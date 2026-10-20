/**
 * MODULE: backend/reservas.web.js
 * VERSION: v10.7-CLEAN
 * APIS: wix-web-module, @wix/bookings (availabilityTimeSlots), @wix/members.
 * DOC: https://www.wix.com/velo/reference/wix-web-module
 *      https://dev.wix.com/docs/rest/business-solutions/bookings/time-slots/time-slots-v2/introduction
 *      https://www.wix.com/velo/reference/wix-members-backend
 *
 * CONSISTENCIA: wix-data usa consistentRead: true (no consistencyMode).
 */
import { webMethod, Permissions } from "wix-web-module";
import { query as dalQuery, removeById, saveItem, insertItem as dalInsert, getItem as dalGet, updateItem as dalUpdate } from "backend/dataAccess";
import { availabilityTimeSlots } from "@wix/bookings";
import { currentMember } from "@wix/members";
import {
    BUSINESS_COLLECTIONS, OPERATIONAL_COLLECTIONS, CONTROL_TYPE,
    CITAS_BOOKING_STATUS, BOOKING_FIELDS, SDK_CONFIG, SLOT_SEARCH,
    API, STAFF_DEFAULT_NAME
} from "backend/internalConfig";
import { findStaffByResourceId, getStaffDisplayName as _resolveDisplayName } from "backend/staff";
import {
    makeTraceId, _safeTrim, _safeSlugOrId, _looksLikeGuid,
    _normalizeLocalIsoStr, getUtcDateFromMadridLocal, getMadridLocalStringNoZ,
    _executeWithRetry, _hashKey, _generateUUID, _toDateSafe, withTimeout
} from "public/mmUtils";
import { normalizeSlotShape as _normalizeSlotShapeShared, getResourceIdsFromSlot as _getResourceIdsFromSlotShared } from "backend/booking/bookingUtils";
import { logger } from "backend/logger";
import { rateLimiter } from "backend/security";

const log = logger;
const SERVICIOS_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;
const CONTROL_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const CT_DUAL_CACHE = (CONTROL_TYPE && CONTROL_TYPE.DUAL_CACHE) || "DUAL_CACHE";
const CT_DAYS_CACHE = (CONTROL_TYPE && CONTROL_TYPE.DAYS_CACHE) || "DAYS_CACHE";
const CT_DISPLAY_TOKEN = (CONTROL_TYPE && CONTROL_TYPE.DISPLAY_TOKEN) || "DISPLAY_TOKEN";
const CONSISTENT_READ = Object.freeze({ consistentRead: true });
const WATCHDOG_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WATCHDOG_MS) || 15000;
const SERVICE_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.SERVICES_TTL_MS) || 120000;
const SLOTS_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.SLOTS_CACHE_TTL_MS) || 60000;
const DUAL_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.DUAL_CACHE_TTL_MS) || 300000;
const DISPLAY_TOKEN_TTL_MS = 30 * 60 * 1000;
const DISPLAY_TOKEN_MAX_ATTEMPTS = 5;
const DIAS_LIMITE = Number(SLOT_SEARCH?.DIAS_LIMITE) || 14;
const MAX_DUAL_GAP_MINUTES = Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120;
const CACHE_MAX_SIZE = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 500;
const DAYS_CACHE_VERSION = String(SDK_CONFIG?.CACHE?.DAYS_CACHE_VERSION || "v1");
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const LOCATION_TS_ID = SDK_CONFIG.LOCATION_ID;
const LOCATION_TS_TYPE = SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS;
const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();

/* ---------------- Helpers de error (agrupados) ---------------- */
function toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Internal Error") {
    return { code: String(err?.code || fallbackCode), message: String(err?.message || fallbackMessage) };
}
function rateLimitError(surface, retryAfter) {
    const e = new Error("RATE_LIMITED"); e.code = "RATE_LIMITED"; e.meta = { retryAfter, surface }; return e;
}

/* ---------------- Helpers internos ---------------- */
function _readField(item, field) { return item?.[field] ?? item?.data?.[field] ?? item?.fields?.[field] ?? null; }
function _readOptionalResourceIds(value) {
    const source = Array.isArray(value) ? value : value ? [value] : [];
    return Array.from(new Set(source.map((item) => typeof item === "string" ? _safeTrim(item) : _safeTrim(item?._id || item?.id || item?.resourceId)).filter(_looksLikeGuid)));
}
function _parseAddons(value) { if (Array.isArray(value)) return value; if (typeof value !== "string") return []; try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
function _extractMediaUrl(value) { if (!value) return ""; if (typeof value === "string") return _safeTrim(value); if (typeof value === "object") return _safeTrim(value.url || value.src || value.fileUrl || ""); return ""; }
function _extractFirstRelationId(value) { if (!value) return ""; if (typeof value === "string") return _safeTrim(value); if (Array.isArray(value)) return _extractFirstRelationId(value[0]); if (typeof value === "object") return _safeTrim(value._id || value.id || value.locationId || ""); return ""; }
function _normalizeAddon(addon) {
    if (!addon || typeof addon !== "object") return null;
    const addonId = _safeTrim(addon.addonId || addon._id || addon.id || "");
    if (!_looksLikeGuid(addonId)) return null;
    const rawPrice = Number(addon.price ?? 0);
    const price = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
    return { addonId, name: _safeTrim(addon.name || addon.nombreComplemento) || "Complemento", price };
}
function _resolveAddonContext(service, requestedAddonIds) {
    const catalog = Array.isArray(service?.addOnOptions) ? service.addOnOptions : [];
    const catalogIds = new Set(catalog.map((a) => _safeTrim(a?.addonId || "")).filter(_looksLikeGuid));
    const requested = Array.from(new Set((Array.isArray(requestedAddonIds) ? requestedAddonIds : []).map((id) => _safeTrim(id)).filter(_looksLikeGuid)));
    const validated = requested.filter((id) => catalogIds.has(id));
    if (requested.length > 0 && validated.length !== requested.length) log.warn("_resolveAddonContext: addOnIds fuera de catalogo", { requested: requested.length, validated: validated.length });
    return { addOnIds: validated, nativeAddonIds: validated };
}
async function _getStaffDisplayName(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;
    try { const staff = await findStaffByResourceId(id); return _resolveDisplayName(staff); }
    catch (e) { log.warn("_getStaffDisplayName failed", { resourceId: id, error: e?.message }); return STAFF_DEFAULT_NAME; }
}
function _cacheSetBounded(map, key, value, maxSize) { if (map.has(key)) map.delete(key); map.set(key, value); if (map.size <= maxSize) return; const firstKey = map.keys().next().value; if (firstKey) map.delete(firstKey); }
function _buildRateLimitKey(surface, visitorId, ipHash) { return `${_safeTrim(visitorId) || "anon"}:${_safeTrim(ipHash) || "noip"}:${surface}`; }
function _rateLimitOrThrow(surface, key) { const result = rateLimiter({ surface, key }); if (result && result.allowed) return; throw rateLimitError(surface, result?.retryAfter ?? null); }
async function _getVisitorIdentity() {
    try {
        const response = await currentMember.getMember();
        const member = response?.member || response;
        if (member && member.status === "ERROR") return { memberId: "", isAuthenticated: false };
        const memberId = _safeTrim(member?._id || member?.id || member?.memberId || "");
        return { memberId, isAuthenticated: Boolean(memberId) };
    } catch (_) { return { memberId: "", isAuthenticated: false }; }
}
function _hashIp(ip) { const v = _safeTrim(ip); return v ? _hashKey(v).slice(0, 16) : ""; }
function _normalizeSlotShape(slot) { return _normalizeSlotShapeShared(slot); }
function _getResourceIdsFromSlot(slot) { return _getResourceIdsFromSlotShared(slot, STAFF_RESOURCE_TYPE_ID); }
function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const s = _normalizeSlotShape(slot); if (!s) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) { log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId }); return null; }
    return { ...s, serviceId, ...(s.slot && typeof s.slot === "object" ? { slot: { ...s.slot, serviceId } } : {}) };
}
function _isValidMadridYmd(value) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_safeTrim(value)); if (!m) return false; const y = +m[1], mo = +m[2], d = +m[3]; const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d; }
function _addDaysYMD(ymd, days) { if (!_isValidMadridYmd(ymd)) return ""; const parts = String(ymd).split("-").map(Number); const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0)); dt.setUTCDate(dt.getUTCDate() + Number(days || 0)); return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ }); }
function _filterDaysByLimit(days) { if (!Array.isArray(days) || days.length === 0) return []; const today = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ }); const tomorrow = _addDaysYMD(today, 1); const max = _addDaysYMD(today, DIAS_LIMITE); if (!tomorrow || !max) return []; return days.filter((d) => d >= tomorrow && d <= max); }
function _normalizeResourceIdsStrict(resourceId, traceId) { const n = _safeTrim(resourceId); if (!n || ["all", "any"].includes(n.toLowerCase())) return []; if (!_looksLikeGuid(n)) { log.warn("_normalizeResourceIdsStrict: invalid staff identifier", { resourceId: n, traceId }); return null; } return [n]; }
function _minutesBetweenUtcDates(a, b) { if (!(a instanceof Date) || !(b instanceof Date)) return 0; const ms = b.getTime() - a.getTime(); return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0; }
function _isValidSlotRange(startLocal, endLocal) { const s = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startLocal)); const e = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endLocal)); return Boolean(s && e && e.getTime() > s.getTime()); }

/* ---------------- Catálogo y DTO ---------------- */
export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null, visited = new Set()) { /* ... (sin cambios, usa CONSISTENT_READ) ... */ }
export async function _resolveServiceIdInternal(serviceIdReq) { /* ... (sin cambios) ... */ }
export async function _mapServiceToDTO(service, traceId, visited = new Set()) { /* ... (sin cambios, pero `linkedPhases` y `clientHidden` se mantienen) ... */ }
export async function _mapServiceImport2ToUX(row, traceId = null) { /* ... (sin cambios) ... */ }
export async function getServiceForBookingInternal(serviceId, traceId = null) { return _getServiceBySlugOrIdInternal(serviceId, traceId || makeTraceId("service-internal")); }

/* ---------------- Web methods públicos ---------------- */
export const getServiceBySlugOrId = webMethod(Permissions.Anyone, async (slugOrId) => { /* ... (sin cambios, rate-limit + _toPublicService) ... */ });
export const resolveServiceId = webMethod(Permissions.Anyone, async (serviceIdReq) => { /* ... (sin cambios) ... */ });

/* _toPublicService: preserva linkedPhases y clientHidden (v10.6) */
export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const { status, availableStaff, staffOptions, ...publicService } = service;
    return publicService;
}

/* Revalidación exacta y slots (sin cambios, usan CONSISTENT_READ) */
export async function revalidateExactAvailabilitySlot({ serviceId, localStartDate, localEndDate, resourceId, nativeAddonIds = [], traceId }) { /* ... */ }
async function _listTimeSlotsV2(...) { /* ... */ }
async function _getBookedMinutesByResourceForDay(...) { /* ... */ }
async function _rankResourcesByLoad(...) { /* ... */ }
async function _pickLeastLoadedResource(...) { /* ... */ }
async function _findNextSlotForServiceInternal(...) { /* ... */ }
export async function _resolveStaffForSlotInternal(params) { /* ... */ }

/* Dual slots, caché e invalidación (sin cambios) */
export async function _cleanExpiredDualSlotsInternal(...) { /* ... */ }
export async function _getCertifiedDualSlotsInternal(...) { /* ... */ }
export async function _invalidateCachesInternal(...) { /* ... */ }
export const invalidateCachesInternal = webMethod(Permissions.Admin, async (serviceId, dateYMD, resourceId) => { /* ... */ });

/* Disponibilidad pública */
export const getAvailableDays = webMethod(Permissions.Anyone, async (serviceId, resourceId, year, month, addonIds = []) => { /* ... */ });
export const getCertifiedDualSlots = webMethod(Permissions.Anyone, async (serviceId, resourceId, dateYMD, addonIds = []) => { /* ... */ });
export const getAvailableSlots = webMethod(Permissions.Anyone, async (serviceId, resourceId, dateYMD, addonIds = []) => { /* ... */ });
export const resolveStaffForSlot = webMethod(Permissions.Anyone, async (serviceId, start1, rId, addonIds = [], dualContext = null) => { /* ... */ });

/* Tokens de visualización (sin cambios) */
async function _generateDisplayToken(bookingId, traceId) { /* ... */ }
async function _validateAndConsumeDisplayToken(token, traceId) { /* ... */ }
async function _consumeDisplayToken(tokenId, traceId) {
    try {
        const fresh = await dalGet(CONTROL_COL, tokenId, CONSISTENT_READ);
        if (!fresh || fresh.consumedAt) return false;
        await dalUpdate(CONTROL_COL, { ...fresh, consumedAt: new Date() });
        return true;
    } catch (e) { log.error("_consumeDisplayToken failed (fail-closed)", { tokenId, traceId, error: e?.message }); return false; }
}
export const getConfirmedBookingForDisplay = webMethod(Permissions.Anyone, async ({ bookingId, displayToken } = {}) => { /* ... */ });
export const generateDisplayToken = webMethod(Permissions.Anyone, async ({ bookingId, confirmationToken } = {}) => { /* ... */ });