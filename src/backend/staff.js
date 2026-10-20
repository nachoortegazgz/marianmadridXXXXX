/*
=============================================================================
MODULE: backend/staff.js
VERSION: v9-BRIDGES
BASE: v8.2-SSOT-MASTER + reescritura completa tras eliminacion de MapaStaff.
RESPONSIBILITY: Fachada unica de identidad staff. Resuelve resourceId,
  memberId, displayName, scheduleId y roles via Bookings Staff API y
  @wix/members. Cache LRU en memoria. DTO publico whitelist.
STANDARDS: G10 ASCII Strict. Minimo codigo.
DECISION CLAVE: MapaStaff NO existe en CMS KEY FIELDS. Toda identidad
  staff se resuelve via APIs nativas de Wix. Este modulo es el UNICO
  punto de acceso a identidad staff en todo el backend.
PENDIENTES:
  - La resolucion de roles de sitio requiere una fuente de roles distinta de
    Staff Members API; el esquema nativo no expone un campo role.
=============================================================================
*/
import { staffMembers } from "@wix/bookings";
import { auth } from "@wix/essentials";
import {
    SDK_CONFIG,
    STAFF_DEFAULT_NAME,
    ROL_WEBSITE,
    isValidGuid,
} from "backend/internalConfig";
import { _safeTrim, withTimeout } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// CONSTANTES
// =============================================================================
const CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.STAFF_TTL_MS) || 300000;
const CACHE_MAX_ENTRIES = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 100;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

// Identidad de Marian Madrid. Dato de negocio, no configuracion transversal.
// Unica fuente de verdad del resourceId de Marian (R2/DUP-03).
export const MARIAN_RESOURCE_ID = "e556070a-6d6a-402e-8422-11133033ea76";
const _MARIAN_RESOURCE_ID = MARIAN_RESOURCE_ID;

// Bookings Staff Members API oficial.
const queryStaffMembersElevated = auth.elevate(staffMembers.queryStaffMembers);
const STAFF_MEMBER_FIELDS = Object.freeze(["RESOURCE_DETAILS", "ASSOCIATED_IDENTITY_STATUS"]);
const MAX_STAFF_PAGES = 20;

// =============================================================================
// CACHE LRU
// =============================================================================
const _cache = new Map();

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _cache.delete(key);
        return null;
    }
    _cache.delete(key);
    _cache.set(key, entry);
    return entry.val;
}

function _cacheSet(key, val) {
    if (_cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest) _cache.delete(oldest);
    }
    _cache.set(key, { val, ts: Date.now() });
}

export function invalidateStaffCache() {
    _cache.clear();
}

// =============================================================================
// HELPERS (DUP-01/DUP-02: sin regex GUID ni trim locales; SSOT importados)
// =============================================================================
const _trim = _safeTrim;
const _isGuid = isValidGuid;

/*
 * ROL DE STAFF (post-R2, MapaStaff eliminado):
 *   - rolBookings: role devuelto por Bookings Staff API (OWNER/ADMIN/...).
 *   - rolWebsite: DERIVADO por el puente security.js. Regla canonica:
 *     rol de Bookings OWNER/ADMIN => ROL_WEBSITE.ADMIN;
 *     cualquier otro rol de staff valido => ROL_WEBSITE.ESTILISTA.
 *   No es un campo persistido en ninguna coleccion CMS.
 */
const ELEVATED_BOOKINGS_ROLES = Object.freeze(["OWNER", "ADMIN"]);

export function deriveRolWebsite(rolBookings) {
    const role = _trim(rolBookings).toUpperCase();
    if (!role) return "";
    return ELEVATED_BOOKINGS_ROLES.includes(role)
        ? ROL_WEBSITE.ADMIN
        : ROL_WEBSITE.ESTILISTA;
}

// =============================================================================
// RESOLUCION VIA BOOKINGS STAFF API
// =============================================================================

/**
 * Obtiene un staff member por resourceId desde Bookings Staff API.
 * Retorna objeto normalizado o null.
 */
function _normalizeStaffMember(staff) {
    if (!staff || typeof staff !== "object") return null;

    const resource = staff.resource && typeof staff.resource === "object"
        ? staff.resource
        : {};
    const workingHours = Array.isArray(resource.workingHoursSchedules)
        ? resource.workingHoursSchedules[0]
        : null;
    const identityId = staff.associatedWixIdentity?.identificationData?.id || {};

    const normalized = {
        staffMemberId: _trim(staff.id || staff._id || ""),
        resourceId: _trim(staff.resourceId || resource.id || resource._id || ""),
        memberId: _trim(identityId.memberId || ""),
        displayName: _trim(staff.name || ""),
        email: _trim(staff.email || "").toLowerCase(),
        role: _trim(staff.role || "").toUpperCase(),
        scheduleId: _trim(
            workingHours?.id ||
            workingHours?._id ||
            resource.eventsSchedule?.id ||
            resource.eventsSchedule?._id ||
            ""
        ),
        locationId: _trim(staff.locationId || ""),
    };

    return normalized.resourceId ? normalized : null;
}

function _indexStaff(staff) {
    if (!staff) return;
    _cacheSet(`staff:rid:${staff.resourceId}`, staff);
    if (staff.memberId && _isGuid(staff.memberId)) {
        _cacheSet(`staff:mid:${staff.memberId}`, staff);
    }
    if (staff.email) _cacheSet(`staff:email:${staff.email}`, staff);
}

async function _queryStaffMembers({ filter = null, traceId = null } = {}) {
    const all = [];
    let cursor = "";
    for (let page = 0; page < MAX_STAFF_PAGES; page += 1) {
        const query = {
            cursorPaging: {
                limit: 100,
                ...(cursor ? { cursor } : {}),
            },
        };
        if (!cursor && filter) query.filter = filter;

        const response = await withTimeout(
            queryStaffMembersElevated(query, { fields: STAFF_MEMBER_FIELDS }),
            API_TIMEOUT_MS,
            "Bookings.staffMembers.queryStaffMembers"
        );

        const items = Array.isArray(response?.staffMembers)
            ? response.staffMembers
            : [];
        all.push(...items);

        const nextCursor = _trim(response?.pagingMetadata?.cursors?.next || "");
        if (!nextCursor) break;
        cursor = nextCursor;
    }

    return all.map(_normalizeStaffMember).filter(Boolean);
}

/**
 * Resolves a native Bookings resourceId through the documented staff-member
 * query. resourceId is not the staffMemberId, so getStaffMember(id) is not
 * valid for this lookup.
 */
async function _fetchStaffByResourceId(resourceId, traceId) {
    const id = _trim(resourceId);
    if (!id || !_isGuid(id)) return null;

    const cached = _cacheGet(`staff:rid:${id}`);
    if (cached) return cached;

    try {
        const staff = await _queryStaffMembers({
            filter: { resourceId: { $eq: id } },
            traceId,
        });
        const found = staff.find((item) => item.resourceId === id) || null;
        if (found) _indexStaff(found);
        return found;
    } catch (error) {
        log.warn("_fetchStaffByResourceId failed", {
            resourceId: id,
            traceId,
            error: error?.message,
        });
        return null;
    }
}

/**
 * Loads the native list of bookable service providers and indexes their
 * resource, member and email identifiers in the shared in-memory cache.
 */
async function _fetchAllStaff(traceId) {
    const cacheKey = "staff:__ALL__";
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const all = await _queryStaffMembers({ traceId });
        for (const staff of all) _indexStaff(staff);
        _cacheSet(cacheKey, all);
        return all;
    } catch (error) {
        log.warn("_fetchAllStaff failed", { traceId, error: error?.message });
        return [];
    }
}

// =============================================================================
// API PUBLICA
// =============================================================================

/**
 * Resuelve staff por resourceId, memberId o email.
 * Prioridad: memberId > resourceId > email.
 */
export async function findStaff(identifier, traceId = null) {
    const id = _trim(identifier);
    if (!id) return null;

    if (_isGuid(id)) {
        const byMemberId = _cacheGet(`staff:mid:${id}`);
        if (byMemberId) return byMemberId;

        const byResourceId = await _fetchStaffByResourceId(id, traceId);
        if (byResourceId) return byResourceId;
    }

    const emailKey = `staff:email:${id.toLowerCase()}`;
    const byEmail = _cacheGet(emailKey);
    if (byEmail) return byEmail;

    const all = await _fetchAllStaff(traceId);
    return all.find((staff) =>
        staff.email === id.toLowerCase() ||
        staff.memberId === id ||
        staff.resourceId === id
    ) || null;
}

export async function findStaffByResourceId(resourceId, traceId = null) {
    return _fetchStaffByResourceId(resourceId, traceId);
}

/**
 * Ficha de Marian (identidad canonica). Unico punto donde vive el
 * resourceId de Marian (R2/DUP-03: sin duplicaciones en consumidores).
 */
export async function findMarianStaff(traceId = null) {
    return _fetchStaffByResourceId(_MARIAN_RESOURCE_ID, traceId);
}

export async function findStaffByMemberId(memberId, traceId = null) {
    const id = _trim(memberId);
    if (!_isGuid(id)) return null;

    const cached = _cacheGet(`staff:mid:${id}`);
    if (cached) return cached;

    const all = await _fetchAllStaff(traceId);
    return all.find((staff) => staff.memberId === id) || null;
}

export async function getStaffScheduleId(resourceId, traceId = null) {
    const staff = await findStaffByResourceId(resourceId, traceId);
    return staff ? _trim(staff.scheduleId) || null : null;
}

export async function listStaff(traceId = null) {
    return _fetchAllStaff(traceId);
}

/**
 * Verifica si un resourceId pertenece a Marian (manager).
 */
export function isMarianResource(resourceId) {
    return _trim(resourceId) === _MARIAN_RESOURCE_ID;
}

/**
 * Nombre visible de staff. Fallback a STAFF_DEFAULT_NAME (SSOT internalConfig).
 */
export function getStaffDisplayName(staff) {
    if (!staff) return STAFF_DEFAULT_NAME;
    return _trim(staff.displayName) || STAFF_DEFAULT_NAME;
}
