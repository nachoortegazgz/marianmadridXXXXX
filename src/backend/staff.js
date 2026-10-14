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
  - Verificar disponibilidad de bookings.staff.getStaff/listStaff en
    runtime Velo (PEND-MAP-01).
  - Migracion dataLegacyAdapter -> backend/dataAccess.
=============================================================================
*/
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
import {
    SDK_CONFIG,
    STAFF_DEFAULT_NAME,
    ROL_WEBSITE,
    isValidGuid,
} from "backend/internalConfig";
import { _safeTrim } from "public/mmUtils";
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

// Proxies elevados para Bookings Staff API.
// STAFF-LH23 (fix derivado de tests 2026-10-14): delegacion LAZY del namespace
// bookings.staff. En runtime Velo el binding top-level es valido. En el harness
// offline (tests/loader.mjs) la binding ESM se captura al importar este modulo,
// antes de que los fixtures escriban mocks.sdk['bookings::staff']; con el getter
// perezoso el mock vivo se resuelve en cada llamada y el cacheo de elevate se
// revalida cuando cambia la referencia (mismo patron LH-21 aplicado al stub).
let _getStaffElevatedCache = null;
let _listStaffElevatedCache = null;
let _elevatedRefCache = null;
function _elevatedBookingsStaff() {
    const staffNs = bookings?.staff;
    if (_elevatedRefCache !== staffNs) {
        _elevatedRefCache = staffNs;
        _getStaffElevatedCache = auth.elevate(staffNs.getStaff);
        _listStaffElevatedCache = auth.elevate(staffNs.listStaff);
    }
    return { get: _getStaffElevatedCache, list: _listStaffElevatedCache };
}
const getStaffElevated = (...args) => _elevatedBookingsStaff().get(...args);
const listStaffElevated = (...args) => _elevatedBookingsStaff().list(...args);

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
async function _fetchStaffByResourceId(resourceId, traceId) {
    const id = _trim(resourceId);
    if (!id || !_isGuid(id)) return null;
    const cacheKey = `staff:rid:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
        const result = await Promise.race([
            getStaffElevated(id),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("TIMEOUT")), API_TIMEOUT_MS)
            ),
        ]);
        const staff = result?.staffMember || result;
        if (!staff) {
            _cacheSet(cacheKey, null);
            return null;
        }
        const normalized = {
            resourceId: _trim(staff.id || staff.resourceId || id),
            memberId: _trim(staff.userId || staff.memberId || ""),
            displayName: _trim(staff.name || staff.displayName || ""),
            email: _trim(staff.email || "").toLowerCase(),
            role: _trim(staff.role || "").toUpperCase(),
            scheduleId: _trim(staff.scheduleId || ""),
            locationId: _trim(staff.locationId || ""),
        };
        _cacheSet(cacheKey, normalized);
        // Indexar tambien por memberId si existe
        if (normalized.memberId && _isGuid(normalized.memberId)) {
            _cacheSet(`staff:mid:${normalized.memberId}`, normalized);
        }
        if (normalized.email) {
            _cacheSet(`staff:email:${normalized.email}`, normalized);
        }
        return normalized;
    } catch (err) {
        log.warn("_fetchStaffByResourceId failed", {
            resourceId: id,
            traceId,
            error: err?.message,
        });
        _cacheSet(cacheKey, null);
        return null;
    }
}

/**
 * Lista todo el staff desde Bookings Staff API.
 */
async function _fetchAllStaff(traceId) {
    const cacheKey = "staff:__ALL__";
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
        const result = await Promise.race([
            listStaffElevated({ limit: 100 }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("TIMEOUT")), API_TIMEOUT_MS)
            ),
        ]);
        const items = result?.staffMembers || result?.items || [];
        const all = items.map((s) => ({
            resourceId: _trim(s.id || s.resourceId || ""),
            memberId: _trim(s.userId || s.memberId || ""),
            displayName: _trim(s.name || s.displayName || ""),
            email: _trim(s.email || "").toLowerCase(),
            role: _trim(s.role || "").toUpperCase(),
            scheduleId: _trim(s.scheduleId || ""),
            locationId: _trim(s.locationId || ""),
        })).filter((s) => s.resourceId && _isGuid(s.resourceId));

        // Indexar cada miembro
        for (const s of all) {
            _cacheSet(`staff:rid:${s.resourceId}`, s);
            if (s.memberId && _isGuid(s.memberId)) {
                _cacheSet(`staff:mid:${s.memberId}`, s);
            }
            if (s.email) {
                _cacheSet(`staff:email:${s.email}`, s);
            }
        }
        _cacheSet(cacheKey, all);
        return all;
    } catch (err) {
        log.warn("_fetchAllStaff failed", { traceId, error: err?.message });
        _cacheSet(cacheKey, []);
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
        // Intentar memberId primero
        let staff = _cacheGet(`staff:mid:${id}`);
        if (staff === undefined) {
            // No cacheado; buscar por resourceId
            staff = await _fetchStaffByResourceId(id, traceId);
        }
        if (staff) return staff;
    }

    // Buscar por email
    const emailKey = `staff:email:${id.toLowerCase()}`;
    const byEmail = _cacheGet(emailKey);
    if (byEmail) return byEmail;

    // Fallback: cargar todo y buscar
    const all = await _fetchAllStaff(traceId);
    return all.find((s) => s.email === id.toLowerCase()) || null;
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
    if (cached !== undefined) return cached;
    // No hay API directa por memberId; cargar todo
    const all = await _fetchAllStaff(traceId);
    return all.find((s) => s.memberId === id) || null;
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
