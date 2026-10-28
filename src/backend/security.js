/*
MODULE: src/backend/security.js
RESPONSIBILITY: Backend security primitives: rate limiting, authorization checks and persistent abuse controls.
STATIC DEPENDENCIES: @wix/members, backend/dataAccess, backend/internalConfig, backend/staff, public/mmUtils, backend/securityEngine, backend/logger
NAMED EXPORT DECLARATIONS DETECTED: getMyStaffContext, rateLimiter, checkPersistentRateLimitBlock, registerPersistentBlock, isAdmin, isCajero, isStaffCollaborator, _resetRateLimitCacheForTests, requireAdmin, requireCajero, requireMarianManager
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are intentionally omitted.
*/
import { members } from "@wix/members";

import {
    query as dalQuery,
    insertItem as dalInsert,
    updateItem as dalUpdate,
} from "backend/dataAccess";

import {
    SDK_CONFIG,
    ROL_WEBSITE,
    CONTROL_TYPE,
    CONTROL_STATUS,
    OPERATIONAL_COLLECTIONS,
} from "backend/internalConfig";

import {
    findStaffByContactId,
} from "backend/staff";

import { makeTraceId } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const ALLOWED_STAFF_ROLES = Object.freeze([
    ROL_WEBSITE.ADMIN,
    ROL_WEBSITE.GESTION,
    ROL_WEBSITE.ESTILISTA,
]);

const RATE_LIMIT_CACHE = new Map();
const PERSISTENT_BLOCK_CACHE = new Map();
const PERSISTENT_BLOCK_CACHE_TTL_MS = 3000;

const RATE_LIMIT_MAX_REQUESTS =
    Number(SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS) || 20;

const RATE_LIMIT_WINDOW_MS =
    Number(SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS) || 5000;

const RATE_LIMIT_CLEANUP_TTL_MS =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS) || 60000;

const RATE_LIMIT_CACHE_MAX_ENTRIES =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES) || 5000;

function _setPersistentBlockCache(cacheKey, value) {
    if (
        !PERSISTENT_BLOCK_CACHE.has(cacheKey) &&
        PERSISTENT_BLOCK_CACHE.size >= RATE_LIMIT_CACHE_MAX_ENTRIES
    ) {
        const oldestKey = PERSISTENT_BLOCK_CACHE.keys().next().value;
        if (oldestKey !== undefined) PERSISTENT_BLOCK_CACHE.delete(oldestKey);
    }
    PERSISTENT_BLOCK_CACHE.set(cacheKey, value);
}

const PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER = 3;
const PERSISTENT_BLOCK_DURATION_MS = 60 * 60 * 1000;

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* P5: opcion canonica de wix-data para forzar lectura primaria. */
const STRONG_READ = Object.freeze({ consistentRead: true });

let lastCleanupTime = Date.now();

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _safeString(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim();
}

function _isValidGuid(value) {
    return GUID_PATTERN.test(_safeString(value));
}

function _normalizeRateLimitPart(value, fallback = "unknown") {
    const normalized = _safeString(value);

    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 200);
}

function _buildRateLimitCacheKey(surface, key) {
    return `${_normalizeRateLimitPart(surface)}:${_normalizeRateLimitPart(key)}`;
}

async function _buildPersistentBlockDedupeKey(surface, key) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const keyHash = await hashSHA256(`${normalizedSurface}:${normalizedKey}`);
    return `RATE_LIMIT:${normalizedSurface}:${keyHash}`;
}

function _buildPersistentBlockId(dedupeKey) {
    // Stable SHA-256-derived ID prevents concurrent duplicates without storing
    // raw member IDs, email addresses, or visitor keys in the CMS.
    return `RL_${dedupeKey.split(":").pop()}`;
}

function _cleanupRateLimitCache() {
    const now = Date.now();

    if (now - lastCleanupTime < RATE_LIMIT_CLEANUP_TTL_MS) {
        return;
    }

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

    if (RATE_LIMIT_CACHE.size <= RATE_LIMIT_CACHE_MAX_ENTRIES) {
        return;
    }

    const entriesToDelete =
        RATE_LIMIT_CACHE.size - RATE_LIMIT_CACHE_MAX_ENTRIES;

    let deleted = 0;

    for (const cacheKey of RATE_LIMIT_CACHE.keys()) {
        if (deleted >= entriesToDelete) {
            break;
        }

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

// Site-member ownership uses the Contact ID shared by the current member
// and the connected Bookings staff identity. Email alone never grants access.
async function _resolveStaffByIdentity(memberInfo, traceId) {
    const contactId = _safeString(memberInfo?.contactId);
    if (!contactId || !_isValidGuid(contactId)) return null;

    try {
        return await findStaffByContactId(contactId, traceId);
    } catch (error) {
        log.error("Active staff lookup failed", {
            traceId,
            message: error?.message || String(error),
        });
        return null;
    }
}

function _readStaffRole(staff) {
    if (!staff || typeof staff !== "object") return "";
    const role = _safeString(staff.roleWebsite).toUpperCase();
    return Object.values(ROL_WEBSITE).includes(role) ? role : "";
}

/**
 * SEC-R3-03: contexto de staff del miembro actual (antes exclusivo de
 * horario.web). Fuente unica para webMethods de roles/fichajes.
 * Retorna null si el miembro no tiene ficha staff valida.
 */
export async function getMyStaffContext(traceId = null) {
    const safeTraceId = traceId || makeTraceId("staff-ctx");
    const memberInfo = await _getCurrentMemberInfo(safeTraceId);

    if (!memberInfo?.contactId) {
        return null;
    }

    const staff = await _resolveStaffByIdentity(memberInfo, safeTraceId);

    if (!staff) {
        return null;
    }

    return {
        memberId: memberInfo.memberId || "",
        contactId: staff.contactId || memberInfo.contactId || "",
        email: memberInfo.email || "",
        resourceId: staff.resourceId || "",
        displayName: staff.displayName || "",
        rolWebsite: _readStaffRole(staff),
    };
}

// =============================================================================
// BLOQUE 3 - RATE LIMITER LOCAL
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

    const cacheKey = _buildRateLimitCacheKey(
        normalizedSurface,
        normalizedKey
    );

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
            retryAfter: Math.max(
                1,
                Math.ceil((entry.blockedUntil - now) / 1000)
            ),
            persistentBlock: true,
        };
    }

    if (entry.blockedUntil && entry.blockedUntil <= now) {
        entry.blockedUntil = null;
        entry.persistentBlockTriggered = false;
    }

    const windowStart = now - window;

    entry.timestamps = entry.timestamps.filter(
        (timestamp) => timestamp > windowStart
    );

    const persistentThreshold =
        max * PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER;

    // Count rejected attempts too, so repeated abuse can reach the persistent
    // threshold. The first max requests remain allowed within the window.
    entry.timestamps.push(now);

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
            retryAfter: Math.max(
                1,
                Math.ceil((entry.blockedUntil - now) / 1000)
            ),
            persistentBlock: true,
        };
    }

    if (entry.timestamps.length > max) {
        const oldestTimestamp = entry.timestamps[0] || now;
        const retryAfterMs = oldestTimestamp + window - now;

        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            persistentBlock: false,
        };
    }

    return {
        allowed: true,
        retryAfter: 0,
        persistentBlock: false,
    };
}

// =============================================================================
// BLOQUE 4 - BLOQUEO PERSISTENTE
// =============================================================================

export async function checkPersistentRateLimitBlock(
    surface,
    key,
    traceId = null
) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const cacheKey = _buildRateLimitCacheKey(normalizedSurface, normalizedKey);
    const now = Date.now();
    const cached = PERSISTENT_BLOCK_CACHE.get(cacheKey);

    if (cached && now - cached.checkedAt < PERSISTENT_BLOCK_CACHE_TTL_MS) {
        return {
            blocked: cached.blockedUntil > now,
            retryAfter: cached.blockedUntil > now
                ? Math.max(1, Math.ceil((cached.blockedUntil - now) / 1000))
                : 0,
            storeUnavailable: Boolean(cached.storeUnavailable),
        };
    }

    try {
        const dedupeKey = await _buildPersistentBlockDedupeKey(normalizedSurface, normalizedKey);
        const response = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", dedupeKey)
            .eq("status", CONTROL_STATUS.ACTIVE)
            .gt("expiresAt", new Date(now))
            .limit(1)
            .find(STRONG_READ);
        const item = response?.items?.[0] || null;
        const expiry = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0;
        const blockedUntil = Number.isFinite(expiry) && expiry > now ? expiry : 0;
        _setPersistentBlockCache(cacheKey, {
            checkedAt: now,
            blockedUntil,
            storeUnavailable: false,
        });
        return {
            blocked: blockedUntil > now,
            retryAfter: blockedUntil > now
                ? Math.max(1, Math.ceil((blockedUntil - now) / 1000))
                : 0,
            storeUnavailable: false,
        };
    } catch (error) {
        _setPersistentBlockCache(cacheKey, {
            checkedAt: now,
            blockedUntil: 0,
            storeUnavailable: true,
        });
        log.error("Persistent rate-limit lookup failed; using local limiter", {
            surface: normalizedSurface,
            traceId,
            message: error?.message || String(error),
        });
        return { blocked: false, retryAfter: 0, storeUnavailable: true };
    }
}

export async function registerPersistentBlock(
    surface,
    key,
    durationMs,
    traceId = null
) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const safeDurationMs = Math.max(
        1000,
        Number(durationMs) || PERSISTENT_BLOCK_DURATION_MS
    );

    if (!normalizedSurface || !normalizedKey) {
        return {
            status: "ERROR",
            registered: false,
            reason: "INVALID_BLOCK_KEY",
        };
    }

    const now = Date.now();
    const expiresAt = new Date(now + safeDurationMs);
    const dedupeKey = await _buildPersistentBlockDedupeKey(normalizedSurface, normalizedKey);
    const blockId = _buildPersistentBlockId(dedupeKey);
    const keyHash = dedupeKey.split(":").pop();
    const effectiveTraceId = _safeString(traceId) || makeTraceId("rl-block");
    const collection = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
    const cacheKey = _buildRateLimitCacheKey(normalizedSurface, normalizedKey);

    try {
        const existingResult = await dalQuery(collection)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", dedupeKey)
            .limit(1)
            .find(STRONG_READ);
        const existing = existingResult?.items?.[0] || null;

        if (existing) {
            const existingExpiry = new Date(existing.expiresAt || 0).getTime();
            if (Number.isFinite(existingExpiry) && existingExpiry > now) {
                _setPersistentBlockCache(cacheKey, {
                    checkedAt: now,
                    blockedUntil: existingExpiry,
                    storeUnavailable: false,
                });
                return {
                    status: "SUCCESS",
                    registered: false,
                    alreadyBlocked: true,
                };
            }

            await dalUpdate(collection, {
                ...existing,
                controlType: CONTROL_TYPE.RATE_LIMIT,
                dedupeKey,
                status: CONTROL_STATUS.ACTIVE,
                expiresAt,
                traceId: effectiveTraceId,
                payload: {
                    surface: normalizedSurface,
                    keyHash,
                    durationMs: safeDurationMs,
                    updatedAt: new Date(now).toISOString(),
                },
            });
        } else {
            await dalInsert(collection, {
                _id: blockId,
                controlType: CONTROL_TYPE.RATE_LIMIT,
                dedupeKey,
                status: CONTROL_STATUS.ACTIVE,
                expiresAt,
                traceId: effectiveTraceId,
                payload: {
                    surface: normalizedSurface,
                    keyHash,
                    durationMs: safeDurationMs,
                    createdAt: new Date(now).toISOString(),
                },
            });
        }

        _setPersistentBlockCache(cacheKey, {
            checkedAt: Date.now(),
            blockedUntil: expiresAt.getTime(),
            storeUnavailable: false,
        });

        log.warn("Persistent rate limit block registered", {
            surface: normalizedSurface,
            traceId: effectiveTraceId,
            durationMs: safeDurationMs,
        });

        return {
            status: "SUCCESS",
            registered: true,
            alreadyBlocked: false,
        };
    } catch (error) {
        // A concurrent insert may win the deterministic _id race. Confirm
        // persistence with a strong read before treating the block as present.
        try {
            const existingResult = await dalQuery(collection)
                .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
                .eq("dedupeKey", dedupeKey)
                .eq("status", CONTROL_STATUS.ACTIVE)
                .gt("expiresAt", new Date())
                .limit(1)
                .find(STRONG_READ);
            const existing = existingResult?.items?.[0] || null;
            if (existing) {
                const existingExpiry = new Date(existing.expiresAt).getTime();
                _setPersistentBlockCache(cacheKey, {
                    checkedAt: Date.now(),
                    blockedUntil: existingExpiry,
                    storeUnavailable: false,
                });
                return {
                    status: "SUCCESS",
                    registered: false,
                    alreadyBlocked: true,
                };
            }
        } catch (readError) {
            log.error("Persistent rate-limit conflict recheck failed", {
                traceId: effectiveTraceId,
                message: readError?.message || String(readError),
            });
        }

        log.error("Persistent rate-limit registration failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
            traceId: effectiveTraceId,
        });

        return {
            status: "ERROR",
            registered: false,
            reason: "PERSISTENT_BLOCK_REGISTRATION_FAILED",
        };
    }
}

// =============================================================================
// BLOQUE 5 - IDENTIDAD DEL MIEMBRO (ALN-05: @wix/members, sin suppressAuth)
// =============================================================================

async function _getCurrentMemberInfo(traceId = null) {
    try {
        const response = await members.getCurrentMember();
        const member = response?.member || response;

        if (!member) {
            return null;
        }

        const memberId = _safeString(
            member._id || member.id || member.memberId
        );
        const contactId = _safeString(member.contactId);
        const email = _safeString(
            member.loginEmail || member.contactDetails?.email
        ).toLowerCase();

        return {
            memberId,
            contactId,
            email,
        };
    } catch (error) {
        log.error("Current member lookup failed", {
            traceId,
            message: error?.message || String(error),
        });

        return null;
    }
}

// =============================================================================
// BLOQUE 6 - VERIFICACION DE ROLES (ALN-02/03: ROL_WEBSITE, rolWebsite)
// =============================================================================

export async function isAdmin(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.contactId) {
        return false;
    }

    const staff = await _resolveStaffByIdentity(memberInfo, traceId);

    return _readStaffRole(staff) === ROL_WEBSITE.ADMIN;
}

export async function isCajero(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.contactId) {
        return false;
    }

    const staff = await _resolveStaffByIdentity(memberInfo, traceId);

    const role = _readStaffRole(staff);
    return role === ROL_WEBSITE.ADMIN || role === ROL_WEBSITE.GESTION;
}

export async function isStaffCollaborator(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.contactId) {
        return false;
    }

    const staff = await _resolveStaffByIdentity(memberInfo, traceId);

    if (!staff) {
        return false;
    }

    return ALLOWED_STAFF_ROLES.includes(_readStaffRole(staff));
}

// =============================================================================
// BLOQUE 6.5 - HOOK DE TESTS
// =============================================================================

export function _resetRateLimitCacheForTests() {
    RATE_LIMIT_CACHE.clear();
    PERSISTENT_BLOCK_CACHE.clear();
}

// =============================================================================
// BLOQUE 7 - EXIGENCIA DE ROLES
// =============================================================================

export async function requireAdmin(traceId = null) {
    const authorized = await isAdmin(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("ADMIN");
    }

    return true;
}

export async function requireCajero(traceId = null) {
    const authorized = await isCajero(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("CAJERO");
    }

    return true;
}

export async function requireMarianManager(traceId = null) {
    const authorized = await isAdmin(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("MARIAN_MANAGER");
    }

    return true;
}