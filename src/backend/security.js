/*
=============================================================================
MODULE: backend/security.js
VERSION: v9-R2-SSOT
BASE: v8.2-SSOT-MASTER + delegacion total de identidad staff en staff.js
  (v9-BRIDGES, Bookings Staff API). MapaStaff NO existe en CMS KEY FIELDS.
RESPONSIBILITY: Motor de seguridad. Rate limiter con ventana deslizante,
                verificacion de roles y bloqueo persistente cross-instancia
                via ControlOperativo. La resolucion de staff se delega por
                completo en backend/staff.js (DUP-03).
STANDARDS: G10 ASCII Strict.
CORRECCIONES v9-R2:
  SEC-R2-01 (P0): _queryStaffByEmail/_queryStaffByMemberId eliminados
    (queries directas a MapaStaff con suppressAuth). Delegacion en
    findStaff / findStaffByMemberId de backend/staff.js.
  SEC-R2-02 (P0): rolWebsite ya no es campo CMS. Se DERIVA del rol de
    Bookings Staff API via deriveRolWebsite (puente canonico en staff.js).
  SEC-R2-03 (P1): GUID_PATTERN local eliminado (DUP-01). Usar isValidGuid
    de internalConfig. _safeString local eliminado (DUP-02). Usar _safeTrim
    de mmUtils.
FIXES HEREDADOS v8.1: BUG-01 (sin .eq("active")), C-03 (memberId),
  SSOT-11 (capa de autorizacion interna de roles).
PENDIENTES:
  - Migracion dataLegacyAdapter -> backend/dataAccess (solo bloque
    bloqueo persistente; la identidad staff ya no usa wixData aqui).
=============================================================================
*/
import wixData from "backend/dataLegacyAdapter";
/* SEC-R3-03 (R0-02): currentMember.getMember() sustituye a
 * members.getCurrentMember(). */
import { currentMember } from "@wix/members";
import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,
    SDK_CONFIG,
    ROL_WEBSITE,
    isValidGuid,
} from "backend/internalConfig";
import {
    findStaff,
    findStaffByMemberId,
    getStaffDisplayName,
    deriveRolWebsite,
} from "backend/staff";

import { makeTraceId, _safeTrim } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const RATE_LIMIT_CACHE = new Map();

const RATE_LIMIT_MAX_REQUESTS =
    Number(SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS) || 20;

const RATE_LIMIT_WINDOW_MS =
    Number(SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS) || 5000;

const RATE_LIMIT_CLEANUP_TTL_MS =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS) || 60000;

const RATE_LIMIT_CACHE_MAX_ENTRIES =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES) || 5000;

const PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER = 3;
const PERSISTENT_BLOCK_DURATION_MS = 60 * 60 * 1000;

let lastCleanupTime = Date.now();

// SEC-02: Roles de sitio que forman parte del staff operativo.
// Antes: STAFF_ACCESS.ALLOWED_ROLES. Derivado de ROL_WEBSITE (ya importado).
// Incluye ESTILISTA: es personal de staff con acceso a ZONA STAFF y fichaje
// horario (RD 8/2019). Los permisos de gestion se siguen resolviendo por
// isAdmin/isCajero, no por esta lista.
const _ALLOWED_STAFF_ROLES = Object.freeze([
    ROL_WEBSITE.ADMIN,
    ROL_WEBSITE.GESTION,
    ROL_WEBSITE.ESTILISTA,
]);

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS (DUP-01/DUP-02: sin GUID_PATTERN ni trim local)
// =============================================================================

const _safeString = _safeTrim;

function _normalizeRateLimitPart(value, fallback = "unknown") {
    const normalized = _safeString(value);
    if (!normalized) return fallback;
    return normalized.slice(0, 200);
}

function _buildRateLimitCacheKey(surface, key) {
    return `${_normalizeRateLimitPart(surface)}:${_normalizeRateLimitPart(key)}`;
}

function _buildPersistentBlockId(surface, key) {
    const raw = `${_normalizeRateLimitPart(surface)}_${_normalizeRateLimitPart(key)}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return `RL_${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 190)}`;
}

function _cleanupRateLimitCache() {
    const now = Date.now();
    if (now - lastCleanupTime < RATE_LIMIT_CLEANUP_TTL_MS) return;

    lastCleanupTime = now;

    for (const [cacheKey, entry] of RATE_LIMIT_CACHE.entries()) {
        const windowStart = now - entry.windowMs;
        entry.timestamps = (entry.timestamps || []).filter(
            (timestamp) => timestamp > windowStart
        );
        const activeBlock =
            Number(entry.blockedUntil) > now && entry.blockedUntil !== null;
        if (entry.timestamps.length === 0 && !activeBlock) {
            RATE_LIMIT_CACHE.delete(cacheKey);
        }
    }

    if (RATE_LIMIT_CACHE.size <= RATE_LIMIT_CACHE_MAX_ENTRIES) return;

    const entriesToDelete =
        RATE_LIMIT_CACHE.size - RATE_LIMIT_CACHE_MAX_ENTRIES;
    let deleted = 0;
    for (const cacheKey of RATE_LIMIT_CACHE.keys()) {
        if (deleted >= entriesToDelete) break;
        RATE_LIMIT_CACHE.delete(cacheKey);
        deleted += 1;
    }
}

function _createAccessDeniedError(requiredRole) {
    const error = new Error(`ACCESS_DENIED: ${requiredRole} role required`);
    error.code = "ACCESS_DENIED";
    error.requiredRole = requiredRole;
    return error;
}

// =============================================================================
// BLOQUE 3 - RESOLUCION DE STAFF (DUP-03: delegacion total en backend/staff.js)
// =============================================================================

// SEC-R2-01: _queryStaffByEmail / _queryStaffByMemberId eliminados.
// No existen queries directas a MapaStaff (coleccion inexistente en CMS).
// staff.js resuelve identidad via Bookings Staff API + cache LRU propia,
// sin suppressAuth.

// =============================================================================
// BLOQUE 4 - RATE LIMITER LOCAL
// =============================================================================

export function rateLimiter(
    { surface, key } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    _cleanupRateLimitCache();

    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    const max = Math.max(1, Number(maxRequests) || RATE_LIMIT_MAX_REQUESTS);
    const window = Math.max(1, Number(windowMs) || RATE_LIMIT_WINDOW_MS);

    const cacheKey = _buildRateLimitCacheKey(normalizedSurface, normalizedKey);
    const now = Date.now();

    let entry = RATE_LIMIT_CACHE.get(cacheKey);
    if (!entry) {
        entry = {
            timestamps: [],
            blockedUntil: null,
            persistentBlockTriggered: false,
            maxRequests: max,
            windowMs: window,
        };
        RATE_LIMIT_CACHE.set(cacheKey, entry);
    }

    entry.maxRequests = max;
    entry.windowMs = window;

    if (entry.blockedUntil && entry.blockedUntil > now) {
        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
            persistentBlock: true,
        };
    }

    if (entry.blockedUntil && entry.blockedUntil <= now) {
        entry.blockedUntil = null;
        entry.persistentBlockTriggered = false;
    }

    const windowStart = now - window;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const persistentThreshold = max * PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER;

    if (entry.timestamps.length >= persistentThreshold) {
        if (!entry.persistentBlockTriggered) {
            entry.persistentBlockTriggered = true;
            entry.blockedUntil = now + PERSISTENT_BLOCK_DURATION_MS;

            const traceId = makeTraceId("rl-block");
            registerPersistentBlock(
                normalizedSurface,
                normalizedKey,
                PERSISTENT_BLOCK_DURATION_MS,
                traceId
            ).catch((error) => {
                log.error("Persistent block registration failed", {
                    traceId,
                    message: error?.message || String(error),
                });
            });

            log.warn("Persistent rate limit block triggered", {
                surface: normalizedSurface,
                key: normalizedKey,
                requestsInWindow: entry.timestamps.length,
                threshold: persistentThreshold,
                durationMs: PERSISTENT_BLOCK_DURATION_MS,
                traceId,
            });
        }

        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
            persistentBlock: true,
        };
    }

    if (entry.timestamps.length >= max) {
        const oldestTimestamp = entry.timestamps[0] || now;
        const retryAfterMs = oldestTimestamp + window - now;
        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            persistentBlock: false,
        };
    }

    entry.timestamps.push(now);

    return { allowed: true, retryAfter: 0, persistentBlock: false };
}

// =============================================================================
// BLOQUE 5 - BLOQUEO PERSISTENTE (ControlOperativo RATE_LIMIT)
// =============================================================================

export async function isKeyPersistentlyBlocked(surface, key) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    if (!normalizedSurface || !normalizedKey) return false;

    try {
        const result = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            /* SEC-R3-04 (ADR-T06): suppressAuth ELIMINADO. dataAccess va
             * elevado incondicionalmente (R1/R5); la opcion era no-op. */
            .find();

        return Array.isArray(result?.items) && result.items.length > 0;
    } catch (error) {
        log.error("Persistent block lookup failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
        });
        return false;
    }
}

export async function registerPersistentBlock(surface, key, durationMs, traceId = null) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const safeDurationMs = Math.max(
        1000,
        Number(durationMs) || PERSISTENT_BLOCK_DURATION_MS
    );

    if (!normalizedSurface || !normalizedKey) {
        return { status: "ERROR", registered: false, reason: "INVALID_BLOCK_KEY" };
    }

    const expiresAt = new Date(Date.now() + safeDurationMs);
    const blockId = _buildPersistentBlockId(normalizedSurface, normalizedKey);

    try {
        const existing = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            .find();

        if (existing?.items?.length > 0) {
            return { status: "SUCCESS", registered: false, alreadyBlocked: true };
        }

        await wixData.insert(
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
            {
                controlType: CONTROL_TYPE.RATE_LIMIT,
                dedupeKey: `${normalizedSurface}|${normalizedKey}`,
                status: CONTROL_STATUS.BLOCKED,
                _id: blockId,
                traceId: traceId || `rate-${blockId}`,
                surface: normalizedSurface,
                requesterKey: normalizedKey,
                expiresAt,
            }
        );

        log.warn("Persistent block registered", {
            surface: normalizedSurface,
            key: normalizedKey,
            durationMs: safeDurationMs,
            traceId,
        });

        return { status: "SUCCESS", registered: true, alreadyBlocked: false };
    } catch (error) {
        log.error("Persistent block registration failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
            traceId,
        });
        return {
            status: "ERROR",
            registered: false,
            reason: "PERSISTENT_BLOCK_REGISTRATION_FAILED",
        };
    }
}

// =============================================================================
// BLOQUE 6 - IDENTIDAD DEL MIEMBRO
// =============================================================================

async function _getCurrentMemberInfo(traceId = null) {
    try {
        /* SEC-R3-03 (R0-02): currentMember.getMember() con shape defensivo
         * (SDK v2 envuelve en {member}). */
        const response = await currentMember.getMember();
        const member = response?.member || response;
        if (!member || member.status === "ERROR") return null;

        const memberId = _safeString(member._id);
        const email = _safeString(
            member.loginEmail ||
                member.contactEmail ||
                (Array.isArray(member.contactEmails) &&
                    member.contactEmails.length
                    ? member.contactEmails[0]
                    : "") ||
                member.contactDetails?.email
        ).toLowerCase();

        return { memberId, email };
    } catch (error) {
        log.error("Current member lookup failed", {
            traceId,
            message: error?.message || String(error),
        });
        return null;
    }
}

// =============================================================================
// BLOQUE 7 - VERIFICACION DE ROLES (SEC-R2-02: rol derivado de Bookings API)
// =============================================================================

async function _resolveStaffForCurrentMember(traceId) {
    const memberInfo = await _getCurrentMemberInfo(traceId);
    if (!memberInfo) return null;

    // C-03: prioridad a memberId (mas robusto que email). Resolucion
    // delegada en staff.js (Bookings Staff API + cache LRU).
    if (memberInfo.memberId && isValidGuid(memberInfo.memberId)) {
        const byMemberId = await findStaffByMemberId(
            memberInfo.memberId,
            traceId
        );
        if (byMemberId) return byMemberId;
    }

    if (memberInfo.email) {
        const byEmail = await findStaff(memberInfo.email, traceId);
        if (byEmail) return byEmail;
    }

    return null;
}

/*
 * SEC-R2-02: capa de autorizacion interna. El rol persistido es el de
 * Bookings Staff API (staff.role). ROL_WEBSITE se deriva con el puente
 * canonico deriveRolWebsite (backend/staff.js). No hay campo "rolWebsite"
 * en ninguna coleccion CMS.
 */
async function _getRolWebsiteOfCurrentMember(traceId) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    if (!staff) return "";
    return deriveRolWebsite(staff.role || staff.rolBookings);
}

export async function isAdmin(traceId = null) {
    return (
        (await _getRolWebsiteOfCurrentMember(traceId)) === ROL_WEBSITE.ADMIN
    );
}

export async function isCajero(traceId = null) {
    const rolWebsite = await _getRolWebsiteOfCurrentMember(traceId);
    return (
        rolWebsite === ROL_WEBSITE.ADMIN || rolWebsite === ROL_WEBSITE.GESTION
    );
}

export async function isStaffCollaborator(traceId = null) {
    const rolWebsite = await _getRolWebsiteOfCurrentMember(traceId);
    return _ALLOWED_STAFF_ROLES.includes(rolWebsite);
}

export async function isEstilista(traceId = null) {
    return (
        (await _getRolWebsiteOfCurrentMember(traceId)) ===
        ROL_WEBSITE.ESTILISTA
    );
}

export async function getMyStaffContext(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    if (!staff) return null;

    const rolBookings = _safeString(staff.role || staff.rolBookings).toUpperCase();

    return {
        resourceId: staff.resourceId,
        memberId: staff.memberId,
        rolBookings,
        rolWebsite: deriveRolWebsite(rolBookings),
        displayName: getStaffDisplayName(staff),
        email: staff.email,
        scheduleId: staff.scheduleId,
        locationId: staff.locationId,
    };
}

// =============================================================================
// BLOQUE 8 - EXIGENCIA DE ROLES
// =============================================================================

export async function requireAdmin(traceId = null) {
    const authorized = await isAdmin(traceId);
    if (!authorized) throw _createAccessDeniedError("ADMIN");
    return true;
}

export async function requireCajero(traceId = null) {
    const authorized = await isCajero(traceId);
    if (!authorized) throw _createAccessDeniedError("CAJERO");
    return true;
}

export async function requireStaffCollaborator(traceId = null) {
    const authorized = await isStaffCollaborator(traceId);
    if (!authorized) throw _createAccessDeniedError("STAFF_COLLABORATOR");
    return true;
}

export async function requireMarianManager(traceId = null) {
    const authorized = await isAdmin(traceId);
    if (!authorized) throw _createAccessDeniedError("MARIAN_MANAGER");
    return true;
}
