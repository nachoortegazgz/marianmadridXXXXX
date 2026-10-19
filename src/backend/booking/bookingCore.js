/*
=============================================================================
MODULE: backend/booking/bookingCore.js
VERSION: v5014-ATOMIC-LOCKS
BASE: v5013-CMS-FINAL + correcciones auditoría P0/P1 (CORE-39..CORE-45)
RESPONSIBILITY: Primitivas atómicas de reserva (simple y dual con gap) sobre
Bookings Writer V2: locks, idempotencia, persistencia CitasF2,
proyección de slots y traducción de enums en frontera.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero consistentRead.
Cero dataLegacyAdapter. Cero alias COLLECTIONS.
CONTRATO: Reserva dual = DOS createBooking independientes unidos por pairToken.
Multiservice Booking PROHIBIDO (BIBLIA 3.6).

CORRECCIONES v5014-ATOMIC-LOCKS:
CORE-39 (P0): _lockSlotKeyOrFail usa update atómico con _revision en vez de
remove+insert. Si el lock expiró, se actualiza el mismo registro
con revisión optimista. Si hay conflicto, retorna LOCK_RACE.
CORE-40 (P0): _unlockSlotKey verifica lockOwnerId + _revision antes de
eliminar. Si la propiedad cambió, retorna LOCK_OWNERSHIP_CHANGED.
Si el remove falla, retorna LOCK_RELEASE_FAILED (no ok:true).
CORE-41 (P0): _initTransaction añade leaseExpiresAt, ownerExecutionId,
heartbeatAt, attempt. Estados ampliados: IN_PROGRESS, COMPLETED,
FAILED_RETRYABLE, FAILED_FINAL.
CORE-42 (P0): _renewLock verifica _revision antes de actualizar. Retorna
newRevision para siguiente renovación. Si hay conflicto, retorna
LOCK_CONFLICT.
CORE-43 (P1): Locks corruptos (sin expiresAt) se tratan como expirados.
Log de error para auditoría.
CORE-44 (P1): Nueva función claimTransaction para reclamar transacciones
huérfanas con revisión optimista.
CORE-45 (P1): _buildSlotLockControl incluye lockOwnerId como campo separado
(no solo en payloadJson) para queries eficientes + lockToken +
propagación de _revision.

FIXES HEREDADOS v5013-CMS-FINAL: CORE-30..CORE-38.
PENDIENTES:
- Verificar que auth.elevate(wixData.insert/update/remove) funciona en
runtime Velo para colecciones admin-only.
=============================================================================
*/
import { bookings } from "@wix/bookings";
import { checkout } from "@wix/ecom";
import { auth } from "@wix/essentials";
import { query as dalQuery, getItem as dalGet, insertItem as dalInsert, updateItem as dalUpdate, removeById as dalRemove } from "backend/dataAccess";
import { getStaffScheduleId } from "backend/staff";
import { logger } from "backend/logger";
import { assertValidEnum } from "backend/validation";
import {
BUSINESS_COLLECTIONS,
OPERATIONAL_COLLECTIONS,
CONTROL_TYPE,
CONCURRENCY,
normalizeBookingType,
isDualBookingType,
SDK_CONFIG,
SLOT_SEARCH,
API,
PAYMENT_STATUS,
BOOKING_FIELDS,
CITAS_BOOKING_STATUS,
CITAS_PAYMENT_STATUS,
} from "backend/internalConfig";
import {
_safeTrim,
_looksLikeGuid,
_roundMoney,
getUtcDateFromMadridLocal,
getMadridLocalStringNoZ,
makeTraceId,
_toDateSafe,
_hashKey,
_normalizeLocalIsoStr,
_generateUUID,
} from "public/mmUtils";
import {
computeGapMinutes,
getResourceIdsFromSlot,
normalizeAvailabilitySlot,
_normalizeGuidForComparison,
_buildPairFingerprint,
_buildPairTokenDeterministic,
} from "backend/booking/bookingUtils";

const log = logger;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

// CORE-31/CORE-33: opción canónica de lectura fuerte. Sin suppressAuth.
const elevatedInsert = dalInsert;
const elevatedUpdate = dalUpdate;
const elevatedRemove = dalRemove;
const elevatedGet = function (collection, id) { return dalGet(collection, id, "strong"); };

function elevatedQueryFind(collection, queryFn) {
return Promise.resolve(queryFn(dalQuery(collection))).then(function (q) {
return q.find();
});
}

// =============================================================================
// BLOQUE 1 - CÓDIGOS DE ERROR
// =============================================================================
export const ERROR_CODES = Object.freeze({
INVALID_PAYLOAD: "INVALID_PAYLOAD",
TOKEN_BUSY: "TOKEN_BUSY",
FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
FISCAL_VIOLATION: "FISCAL_VIOLATION",
BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
CHECKOUT_FAILED: "CHECKOUT_FAILED",
INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
AUTH_REQUIRED: "AUTH_REQUIRED",
ACCESS_DENIED: "ACCESS_DENIED",
INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
RATE_LIMITED: "RATE_LIMITED",
SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
LOCATION_MISMATCH: "LOCATION_MISMATCH",
LOCK_KEY_OR_OWNER_INVALID: "LOCK_KEY_OR_OWNER_INVALID",
LOCK_HELD_BY_ANOTHER_OWNER: "LOCK_HELD_BY_ANOTHER_OWNER",
LOCK_EXPIRED_PENDING_CLEANUP: "LOCK_EXPIRED_PENDING_CLEANUP",
LOCK_RENEWAL_FAILED: "LOCK_RENEWAL_FAILED",
LOCK_RACE: "LOCK_RACE",
LOCK_OWNERSHIP_CHANGED: "LOCK_OWNERSHIP_CHANGED",
LOCK_RELEASE_FAILED: "LOCK_RELEASE_FAILED",
LOCK_CONFLICT: "LOCK_CONFLICT",
TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
PAIR_TOKEN_PAYLOAD_MISMATCH: "PAIR_TOKEN_PAYLOAD_MISMATCH",
TRANSACTION_PREVIOUSLY_FAILED: "TRANSACTION_PREVIOUSLY_FAILED",
INVALID_SLOT_RECHECK: "INVALID_SLOT_RECHECK",
DATABASE_ERROR: "DATABASE_ERROR",
INVALID_DATES: "INVALID_DATES",
UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ENUMS EN FRONTERA: WIX NATIVO <-> CMS PERSISTIDO
// =============================================================================
export const CMS_BOOKING_STATUS = CITAS_BOOKING_STATUS;
export const CMS_PAYMENT_STATUS = CITAS_PAYMENT_STATUS;

const WIX_TO_CMS_BOOKING_STATUS = Object.freeze({
CREATED: CITAS_BOOKING_STATUS.PENDING,
PENDING: CITAS_BOOKING_STATUS.PENDING,
WAITING_LIST: CITAS_BOOKING_STATUS.PENDING,
CONFIRMED: CITAS_BOOKING_STATUS.CONFIRMED,
UPDATED: CITAS_BOOKING_STATUS.CONFIRMED,
COMPLETED: CITAS_BOOKING_STATUS.COMPLETED,
CANCELED: CITAS_BOOKING_STATUS.CANCELLED,
CANCELLED: CITAS_BOOKING_STATUS.CANCELLED,
DECLINED: CITAS_BOOKING_STATUS.CANCELLED,
REFUNDED: CITAS_BOOKING_STATUS.CANCELLED,
NO_SHOW: CITAS_BOOKING_STATUS.NO_SHOW,
NOSHOW: CITAS_BOOKING_STATUS.NO_SHOW,
PENDIENTE: CITAS_BOOKING_STATUS.PENDING,
CONFIRMADO: CITAS_BOOKING_STATUS.CONFIRMED,
COMPLETADO: CITAS_BOOKING_STATUS.COMPLETED,
CANCELADO: CITAS_BOOKING_STATUS.CANCELLED,
REEMBOLSADO: CITAS_BOOKING_STATUS.CANCELLED,
NO_PRESENTADO: CITAS_BOOKING_STATUS.NO_SHOW,
});

const WIX_TO_CMS_PAYMENT_STATUS = Object.freeze({
UNDEFINED: CITAS_PAYMENT_STATUS.UNPAID,
NOT_PAID: CITAS_PAYMENT_STATUS.UNPAID,
PENDING_PAYMENT: CITAS_PAYMENT_STATUS.UNPAID,
PENDING_LEDGER: CITAS_PAYMENT_STATUS.UNPAID,
UNPAID: CITAS_PAYMENT_STATUS.UNPAID,
PAID: CITAS_PAYMENT_STATUS.PAID,
EXEMPT: CITAS_PAYMENT_STATUS.PAID,
PARTIALLY_PAID: CITAS_PAYMENT_STATUS.PARTIAL,
PARTIALLY_REFUNDED: CITAS_PAYMENT_STATUS.PARTIAL,
PARTIAL: CITAS_PAYMENT_STATUS.PARTIAL,
REFUNDED: CITAS_PAYMENT_STATUS.REFUNDED,
IMPAGADO: CITAS_PAYMENT_STATUS.UNPAID,
NO_PAGADO: CITAS_PAYMENT_STATUS.UNPAID,
PENDIENTE_PAGO: CITAS_PAYMENT_STATUS.UNPAID,
PAGADO: CITAS_PAYMENT_STATUS.PAID,
PARCIALMENTE_PAGADO: CITAS_PAYMENT_STATUS.PARTIAL,
REEMBOLSADO_PARCIAL: CITAS_PAYMENT_STATUS.PARTIAL,
REEMBOLSADO: CITAS_PAYMENT_STATUS.REFUNDED,
EXENTO: CITAS_PAYMENT_STATUS.PAID,
});

export function _toCmsBookingStatus(value) {
const v = _safeTrim(value).toUpperCase();
if (!v) return "";
return WIX_TO_CMS_BOOKING_STATUS[v] || "";
}

export function _toCmsPaymentStatus(value) {
const v = _safeTrim(value).toUpperCase();
if (!v) return "";
return WIX_TO_CMS_PAYMENT_STATUS[v] || "";
}

const WIX_NATIVE_PAYMENT_STATUS = Object.freeze({
UNDEFINED: PAYMENT_STATUS.UNDEFINED,
NOT_PAID: PAYMENT_STATUS.NOT_PAID,
PENDING_PAYMENT: PAYMENT_STATUS.PENDING_PAYMENT,
PENDING_LEDGER: PAYMENT_STATUS.PENDING_LEDGER,
PAID: PAYMENT_STATUS.PAID,
PARTIALLY_PAID: PAYMENT_STATUS.PARTIALLY_PAID,
REFUNDED: PAYMENT_STATUS.REFUNDED,
PARTIALLY_REFUNDED: PAYMENT_STATUS.PARTIALLY_REFUNDED,
EXEMPT: PAYMENT_STATUS.EXEMPT,
IMPAGADO: PAYMENT_STATUS.NOT_PAID,
NO_PAGADO: PAYMENT_STATUS.NOT_PAID,
UNPAID: PAYMENT_STATUS.NOT_PAID,
PAGADO: PAYMENT_STATUS.PAID,
PARCIALMENTE_PAGADO: PAYMENT_STATUS.PARTIALLY_PAID,
PARTIAL: PAYMENT_STATUS.PARTIALLY_PAID,
REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
REEMBOLSADO_PARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
EXENTO: PAYMENT_STATUS.EXEMPT,
});

function _toWixNativePaymentStatus(value) {
const v = _safeTrim(value).toUpperCase();
if (!v) return value;
return WIX_NATIVE_PAYMENT_STATUS[v] || value;
}

function _deriveCmsBookingStatus(cmsPaymentStatus) {
return cmsPaymentStatus === CITAS_PAYMENT_STATUS.UNPAID
? CITAS_BOOKING_STATUS.PENDING
: CITAS_BOOKING_STATUS.CONFIRMED;
}

// =============================================================================
// BLOQUE 3 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

const _confirmOrDeclineElevatedRaw = auth.elevate(
bookings.confirmOrDeclineBooking
);

/**
* Traduce paymentStatus SSOT -> enum nativo Wix antes de enviar.
* confirmOrDeclineBooking solo debe llamarse con checkout propio (rama
* presencial). Con eCommerce checkout, Wix sincroniza desde la orden.
*/
export async function confirmOrDeclineBookingElevated(bookingId, options) {
let normalizedOptions = options;
if (
options &&
typeof options === "object" &&
options.paymentStatus !== undefined
) {
const translated = _toWixNativePaymentStatus(options.paymentStatus);
if (translated !== options.paymentStatus) {
log.info("CORE-06: paymentStatus translated SSOT -> Wix native", {
bookingId: _safeTrim(bookingId),
from: options.paymentStatus,
to: translated,
});
}
normalizedOptions = Object.assign({}, options, {
paymentStatus: translated,
});
}
return _confirmOrDeclineElevatedRaw(bookingId, normalizedOptions);
}

export { logger };

// =============================================================================
// BLOQUE 4 - BOOKINGERROR Y NORMALIZACIÓN DE ERRORES
// =============================================================================
export class BookingError extends Error {
constructor(code, message, details) {
super(String(message || "Unknown error"));
this.name = "BookingError";
this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
this.details =
details && typeof details === "object"
? details
: { details: details };
this.timestamp = new Date().toISOString();
}
}

export function createBookingError(code, message, details) {
return new BookingError(code, message, details);
}

export function normalizeError(err) {
if (err && typeof err === "object" && err.name === "BookingError") {
return {
code: String(err.code || ERROR_CODES.UNKNOWN_ERROR),
message: String(err.message || "Unknown error"),
stack: err.stack || null,
details: err.details || {},
};
}
if (err instanceof Error) {
return {
code: String(
err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR
),
message: String(err.message || "Unknown error"),
stack: err.stack || null,
details:
err.details && typeof err.details === "object"
? err.details
: {},
};
}
if (typeof err === "string") {
return {
code: ERROR_CODES.UNKNOWN_ERROR,
message: err,
stack: null,
details: {},
};
}
if (err && typeof err === "object") {
return {
code: String(
err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR
),
message: String(err.message || err.error || "Unknown error"),
stack: err.stack || null,
details: {},
};
}
return {
code: ERROR_CODES.UNKNOWN_ERROR,
message: "Unknown error",
stack: null,
details: {},
};
}

export function _handleError(error, context, traceId, logFn) {
const loggerInstance = logFn || log;
const norm = normalizeError(error);
loggerInstance.error(
"[" + context + "] " + norm.code + ": " + norm.message,
{ traceId: traceId, details: norm.details }
);
return {
status: "ERROR",
data: null,
error: {
code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
message: norm.message || "Unknown error",
},
};
}

// =============================================================================
// BLOQUE 5 - HELPERS COMPARTIDOS DE BAJO NIVEL
// =============================================================================
function _parsePayloadJson(text) {
const raw = _safeTrim(text);
if (!raw) return {};
try {
const parsed = JSON.parse(raw);
return parsed && typeof parsed === "object" && !Array.isArray(parsed)
? parsed
: {};
} catch (_) {
return {};
}
}

function _isDuplicateItemError(error) {
const message = String((error && error.message) || "").toLowerCase();
return (
message.indexOf("wde0123") >= 0 ||
message.indexOf("wd_item_already_exists") >= 0 ||
message.indexOf("duplicated") >= 0 ||
message.indexOf("already exists") >= 0
);
}

function _isRevisionConflictError(error) {
const message = String((error && error.message) || "").toLowerCase();
return (
message.indexOf("revision") >= 0 ||
message.indexOf("conflict") >= 0 ||
message.indexOf("wde0124") >= 0
);
}

// =============================================================================
// BLOQUE 6 - RESOLUCIÓN DE SCHEDULEID
// =============================================================================
async function _resolveScheduleIdByResourceId(resourceId) {
const id = _safeTrim(resourceId);
if (!id || !_looksLikeGuid(id)) return null;
const scheduleId = await getStaffScheduleId(id);
return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
const resourceIdClean = _safeTrim(resourceId);
if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
const s =
sourceSlot && typeof sourceSlot === "object" ? sourceSlot : {};
const nestedSlot =
s.slot && typeof s.slot === "object" ? s.slot : {};
const schedule =
s.schedule && typeof s.schedule === "object" ? s.schedule : {};
const resource =
s.resource && typeof s.resource === "object" ? s.resource : {};
let scheduleId = _safeTrim(
s.scheduleId ||
nestedSlot.scheduleId ||
schedule.id ||
resource.scheduleId
);
if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;
scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
return scheduleId || null;
}

// =============================================================================
// BLOQUE 7 - CONSTRUCCIÓN DEL BODY DE CREATEBOOKING (Writer V2)
// =============================================================================
/**
* Transforma addOnIds (GUIDs de ComplementosCatalogo) al array de objetos
* que consume la API de Wix Bookings a NIVEL RAÍZ del body de createBooking:
*   bookings.createBooking({ bookedEntity: {slot}, bookedAddOns: [{addOnId}], ... })
* Filtra GUIDs inválidos. Deduplica case-insensitive. Preserva orden.
*/
export function _buildBookedAddOns(addOnIds) {
if (!Array.isArray(addOnIds) || addOnIds.length === 0) return [];
const seen = new Set();
const out = [];
for (let i = 0; i < addOnIds.length; i += 1) {
const raw = _safeTrim(addOnIds[i]);
if (!_looksLikeGuid(raw)) continue;
const key = _normalizeGuidForComparison(raw);
if (seen.has(key)) continue;
seen.add(key);
out.push({ addOnId: raw });
}
return out;
}

/**
* Convierte valor local (Date | ISO con Z | ISO local) a cadena local
* Madrid canónica (YYYY-MM-DDTHH:mm:ss). Devuelve "" si no es interpretable.
* Preferencia: localStartDate/localEndDate; fallback startDate/endDate.
*/
function _toMadridLocalString(rawValue) {
if (rawValue instanceof Date) {
return isNaN(rawValue.getTime())
? ""
: getMadridLocalStringNoZ(rawValue);
}
if (typeof rawValue === "string") {
const trimmed = _safeTrim(rawValue);
if (!trimmed) return "";
if (trimmed.endsWith("Z")) {
const utcDt = new Date(trimmed);
return isNaN(utcDt.getTime())
? ""
: getMadridLocalStringNoZ(utcDt);
}
return _normalizeLocalIsoStr(trimmed);
}
return "";
}

function _readSlotLocalStart(slot) {
if (!slot || typeof slot !== "object") return "";
return _toMadridLocalString(slot.localStartDate || slot.startDate);
}

function _readSlotLocalEnd(slot) {
if (!slot || typeof slot !== "object") return "";
return _toMadridLocalString(slot.localEndDate || slot.endDate);
}

const CONFIGURED_LOCATION_ID = _safeTrim(
SDK_CONFIG && SDK_CONFIG.LOCATION_ID
);

/**
* Construye el objeto bookingInfo que exige Bookings Writer V2.
* NO inyecta addOnIds ni selectedAddOns dentro del slot (viajan a nivel raíz).
* Contrato devuelto: { serviceId, scheduleId, startDate (ISO UTC Z),
*   endDate (ISO UTC Z), timezone, resource:{id}, location:{id, locationType} }.
* Null ante dato no certificable (fail-closed).
*/
export async function _forceStaffInPristineSlot(
slot,
resourceId,
serviceIdOverride,
defaultDurationMinutes
) {
if (!slot || typeof slot !== "object") return null;
const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
if (!serviceId || !_looksLikeGuid(serviceId)) {
log.error("_forceStaffInPristineSlot: invalid serviceId", {
serviceId: serviceId,
});
return null;
}
const resourceCandidate =
slot.resource && typeof slot.resource === "object"
? slot.resource
: {};
const resourceIdClean = _safeTrim(
resourceId || slot.resourceId || resourceCandidate.id
);
if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
log.error("_forceStaffInPristineSlot: invalid resourceId", {
resourceId: resourceIdClean,
});
return null;
}
const scheduleId = await _resolveScheduleIdForResource(
resourceIdClean,
slot
);
if (!scheduleId) {
log.error("_forceStaffInPristineSlot: missing scheduleId", {
resourceId: resourceIdClean,
});
return null;
}
const localStartDate = _readSlotLocalStart(slot);
if (!localStartDate) return null;
let localEndDate = _readSlotLocalEnd(slot);
if (!localEndDate) {
const startUtc = getUtcDateFromMadridLocal(localStartDate);
if (!startUtc) return null;
const durationMin =
Number(defaultDurationMinutes) ||
Number(CONCURRENCY && CONCURRENCY.DEFAULT_DURATION_MIN) ||
30;
localEndDate = getMadridLocalStringNoZ(
new Date(startUtc.getTime() + durationMin * 60 * 1000)
);
}
const startDate = getUtcDateFromMadridLocal(localStartDate);
const endDate = getUtcDateFromMadridLocal(localEndDate);
if (!startDate || !endDate) return null;
if (endDate.getTime() <= startDate.getTime()) {
log.error("_forceStaffInPristineSlot: invalid date range", {
localStartDate: localStartDate,
localEndDate: localEndDate,
resourceId: resourceIdClean,
serviceId: serviceId,
});
return null;
}
const slotLocation =
slot.location && typeof slot.location === "object"
? slot.location
: {};
const incomingLocationId = _safeTrim(slotLocation.id);
if (
incomingLocationId &&
CONFIGURED_LOCATION_ID &&
incomingLocationId !== CONFIGURED_LOCATION_ID
) {
log.error("_forceStaffInPristineSlot: location conflict", {
slotLocationId: incomingLocationId,
configuredLocationId: CONFIGURED_LOCATION_ID,
serviceId: serviceId,
});
return null;
}
const locationId = CONFIGURED_LOCATION_ID || incomingLocationId;
if (!locationId || !_looksLikeGuid(locationId)) {
log.error(
"_forceStaffInPristineSlot: missing or invalid LOCATION_ID",
{
configuredLocationId: CONFIGURED_LOCATION_ID,
incomingLocationId: incomingLocationId,
}
);
return null;
}
let locationType = _safeTrim(
SDK_CONFIG &&
SDK_CONFIG.LOCATION_TYPES &&
SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
);
if (!locationType || locationType === "BUSINESS") {
locationType = "OWNER_BUSINESS";
}
return {
serviceId: serviceId,
scheduleId: scheduleId,
startDate: startDate.toISOString(),
endDate: endDate.toISOString(),
timezone:
_safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
resource: { id: resourceIdClean },
location: { id: locationId, locationType: locationType },
};
}

// =============================================================================
// BLOQUE 8 - CHECKOUT URL HELPER
// =============================================================================
export function _extractCheckoutId(checkoutSession) {
if (!checkoutSession || typeof checkoutSession !== "object") return null;
const nested =
checkoutSession.checkout && typeof checkoutSession.checkout === "object"
? checkoutSession.checkout
: {};
return _safeTrim(nested._id) || _safeTrim(checkoutSession._id) || null;
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS
// =============================================================================
export function generateSlotKey(serviceId, resourceId, startDate, endDate) {
const startUtc =
startDate instanceof Date
? startDate
: getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startDate));
const endUtc =
endDate instanceof Date
? endDate
: getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endDate));
if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
throw createBookingError(
ERROR_CODES.INVALID_DATES,
"Invalid slot dates for lock key"
);
}
const res = _safeTrim(resourceId);
if (!res || !_looksLikeGuid(res)) {
throw createBookingError(
ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
"resourceId is required and must be a valid GUID to build a slot key"
);
}
const svc = _safeTrim(serviceId);
const servicePrefix = svc ? svc.slice(0, 8) : "srv";
const startEpochMin = Math.floor(startUtc.getTime() / 60000);
const endEpochMin = Math.floor(endUtc.getTime() / 60000);
return (
"slot_" +
servicePrefix +
"_" +
res +
"_" +
startEpochMin +
"_" +
endEpochMin
);
}

/**
* Extrae resourceId de una slot key de 5 piezas separadas por "_".
* Formato: slot_{prefix}_{resourceId}_{startEpoch}_{endEpoch}
*/
export function parseResourceIdFromSlotKey(slotKey) {
const parts = String(slotKey || "").split("_");
if (parts.length !== 5 || parts[0] !== "slot") return "";
const servicePrefix = _safeTrim(parts[1]);
const resourceId = _safeTrim(parts[2]);
const startEpochMin = parts[3];
const endEpochMin = parts[4];
if (!servicePrefix) return "";
if (!/^\d+$/.test(startEpochMin) || !/^\d+$/.test(endEpochMin)) return "";
if (Number(endEpochMin) <= Number(startEpochMin)) return "";
return _looksLikeGuid(resourceId) ? resourceId : "";
}

// Alias interno usado por _buildSlotLockControl y _lockSlotKeyOrFail.
const _parseResourceIdFromSlotKey = parseResourceIdFromSlotKey;
export { _parseResourceIdFromSlotKey };

export const _buildLockKeys = buildLockKeys;
export function buildLockKeys(phases, resourceId) {
const keys = (Array.isArray(phases) ? phases : [])
.map(function (phase) {
const slot = (phase && phase.rawSlot) || {};
try {
return generateSlotKey(
slot.serviceId,
resourceId,
phase && phase.localStart,
phase && phase.localEnd
);
} catch (_) {
return "";
}
})
.filter(function (key) {
return Boolean(key);
});
return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - MUTEX LOCKS EN ControlOperativo (SLOT_LOCK)
// CORE-39/40/43/45: Atomicidad y verificación de revisión
// =============================================================================
const MUTEX_TTL_MS = Number(
CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX
);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
throw new Error("MS_TTL_MUTEX must be positive");
}

const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function safeLockId(key) {
const k = _safeTrim(key);
if (!k) return "";
return "lk" + _hashKey(k) + k.slice(0, 24);
}

/**
* CORE-45: _buildSlotLockControl incluye lockOwnerId como campo separado
* para queries eficientes, lockToken para verificación adicional,
* y propaga _revision del existing para revisión optimista.
*/
export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
const resourceId = _parseResourceIdFromSlotKey(slotClave);
const ttl = Number(ttlMs);
const now = new Date();
const doc = {
_id: safeLockId(slotClave),
controlType: CONTROL_TYPE.SLOT_LOCK,
dedupeKey: String(slotClave),
resourceId: resourceId,
lockOwnerId: String(lockOwnerId || ""),
lockToken: existing && existing.lockToken ? existing.lockToken : _generateUUID(),
expiresAt: new Date(
now.getTime() +
(Number.isFinite(ttl) && ttl > 0 ? ttl : MUTEX_TTL_MS)
),
acquiredAt: now,
heartbeatAt: now,
payloadJson: JSON.stringify({
lockOwnerId: String(lockOwnerId || ""),
lockStatus: "ACTIVE",
}),
traceId:
_safeTrim(existing && existing.traceId) || makeTraceId("lock"),
};
// CORE-45 FIX: propagar _revision para revisión optimista
if (existing && existing._revision !== undefined) {
doc._revision = existing._revision;
}
return doc;
}

async function _getLock(slotClave) {
const id = safeLockId(slotClave);
if (!id) return null;
// CORE-31/33: elevatedGet + STRONG_READ. Sin suppressAuth.
const item = await elevatedGet(LOCKS_COL, id).catch(
function () {
return null;
}
);
if (!item) return null;
if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
return item;
}

/**
* CORE-45 FIX: lee primero lockOwnerId como campo separado,
* fallback a payloadJson para compatibilidad con locks legacy.
*/
function _getLockOwnerId(lock) {
if (!lock || typeof lock !== "object") return "";
// CORE-45: lockOwnerId ahora es campo separado, fallback a payloadJson.
if (lock.lockOwnerId) return _safeTrim(lock.lockOwnerId);
const payload = _parsePayloadJson(lock.payloadJson);
return _safeTrim(payload.lockOwnerId) || "";
}

/**
* CORE-39: _lockSlotKeyOrFail usa update atómico con _revision en vez de
* remove+insert. Si el lock expiró, se actualiza el mismo registro con
* revisión optimista. Si hay conflicto, retorna LOCK_RACE.
* CORE-43: Locks corruptos (sin expiresAt) se tratan como expirados.
* CORE-45: Devuelve revision y lockToken para que la saga pueda pasarlos
* al heartbeat y a _unlockSlotKey.
*/
export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
const k = _safeTrim(slotClave);
const owner = _safeTrim(lockOwnerId);
if (!k || !owner) {
return {
ok: false,
message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
};
}
if (!_parseResourceIdFromSlotKey(k)) {
return {
ok: false,
message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
};
}
try {
// CORE-33: elevatedInsert para colección admin-only.
const newLock = _buildSlotLockControl(k, owner, ttlMs);
await elevatedInsert(LOCKS_COL, newLock);
return {
ok: true,
acquired: true,
revision: newLock._revision,
lockToken: newLock.lockToken,
};
} catch (error) {
if (!_isDuplicateItemError(error)) {
log.error("_lockSlotKeyOrFail failed", {
slotClave: k,
error: error && error.message,
});
return {
ok: false,
message:
(error && error.message) || ERROR_CODES.DATABASE_ERROR,
};
}
// Lock ya existe, verificar si expiró
const existing = await _getLock(k);
const currentOwner = _getLockOwnerId(existing);
// Si el propietario actual es el mismo, renovar
if (currentOwner && currentOwner === owner) {
// FIX: pasar expectedRevision del lock existente
const renewed = await _renewLock(k, owner, ttlMs, existing._revision);
return renewed.ok
? { ok: true, renewed: true, revision: renewed.newRevision, lockToken: existing.lockToken }
: { ok: false, message: ERROR_CODES.LOCK_RENEWAL_FAILED };
}
// CORE-43: Verificar expiración (locks corruptos sin expiresAt = expirados)
const expiresAt = _toDateSafe(existing && existing.expiresAt);
const malformed = !expiresAt;
const expired = malformed || expiresAt.getTime() <= Date.now();

if (malformed) {
log.error("CORE-43: Malformed lock found (missing expiresAt)", {
slotClave: k,
lockId: existing?._id,
});
}

if (expired && existing && existing._id) {
// CORE-39: Update atómico con _revision en vez de remove+insert
try {
const updated = await elevatedUpdate(
LOCKS_COL,
_buildSlotLockControl(k, owner, ttlMs, existing)
);
return {
ok: true,
acquired: true,
reclaimed: true,
revision: updated._revision,
lockToken: updated.lockToken,
};
} catch (updateError) {
// Conflicto de _revision: otro proceso ganó la carrera
if (_isRevisionConflictError(updateError)) {
return {
ok: false,
message: ERROR_CODES.LOCK_RACE,
};
}
log.error("_lockSlotKeyOrFail: update failed", {
slotClave: k,
error: updateError && updateError.message,
});
return {
ok: false,
message: ERROR_CODES.LOCK_HELD_BY_ANOTHER_OWNER,
};
}
}
return {
ok: false,
message: ERROR_CODES.LOCK_HELD_BY_ANOTHER_OWNER,
};
}
}

/**
* CORE-40: _unlockSlotKey verifica lockOwnerId + _revision antes de eliminar.
* Si la propiedad cambió, retorna LOCK_OWNERSHIP_CHANGED.
* Si el remove falla, retorna LOCK_RELEASE_FAILED (no ok:true).
*/
export async function _unlockSlotKey(slotClave, lockOwnerId, expectedRevision) {
const owner = _safeTrim(lockOwnerId);
const existing = await _getLock(slotClave);
if (!existing) return { ok: true, missing: true };
const currentOwner = _getLockOwnerId(existing);
// Verificar propiedad
if (!owner || currentOwner !== owner) {
return { ok: false, reason: ERROR_CODES.LOCK_OWNERSHIP_CHANGED, skipped: true };
}
// CORE-40: Verificar revisión si se proporciona
if (expectedRevision !== undefined && existing._revision !== expectedRevision) {
return { ok: false, reason: ERROR_CODES.LOCK_CONFLICT };
}
// Intentar eliminar con manejo explícito de errores
try {
await elevatedRemove(LOCKS_COL, existing._id);
return { ok: true };
} catch (error) {
log.warn("_unlockSlotKey: remove failed", {
slotClave: slotClave,
error: error && error.message,
});
// CORE-40: NO retornar ok:true si el remove falla
return {
ok: false,
reason: ERROR_CODES.LOCK_RELEASE_FAILED,
error: error && error.message,
};
}
}

/**
* CORE-42: _renewLock verifica _revision antes de actualizar.
* Retorna newRevision para siguiente renovación.
* Si hay conflicto, retorna LOCK_CONFLICT.
*/
export async function _renewLock(slotClave, lockOwnerId, ttlMs, expectedRevision) {
const owner = _safeTrim(lockOwnerId);
try {
const existing = await _getLock(slotClave);
if (!existing) return { ok: false, reason: "LOCK_NOT_FOUND" };
if (!owner || _getLockOwnerId(existing) !== owner) {
return { ok: false, reason: ERROR_CODES.LOCK_OWNERSHIP_CHANGED };
}
// CORE-42: Verificar revisión si se proporciona
if (expectedRevision !== undefined && existing._revision !== expectedRevision) {
return { ok: false, reason: ERROR_CODES.LOCK_CONFLICT };
}
const updated = await elevatedUpdate(
LOCKS_COL,
_buildSlotLockControl(slotClave, owner, ttlMs, existing)
);
return {
ok: true,
newRevision: updated._revision,
};
} catch (error) {
if (_isRevisionConflictError(error)) {
return { ok: false, reason: ERROR_CODES.LOCK_CONFLICT };
}
log.error("_renewLock failed", {
slotClave: slotClave,
error: error && error.message,
});
return { ok: false, reason: ERROR_CODES.LOCK_RENEWAL_FAILED };
}
}

// =============================================================================
// BLOQUE 11 - TRANSACCIONES IDEMPOTENTES EN ControlOperativo
// CORE-41/44: Lease recuperable y estados ampliados
// =============================================================================
const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const TX_DEDUPE_PREFIX = "TX_";
const TX_PAYLOAD_MAX_CHARS = 900;
const TRANSACTION_POLL_BASE_MS =
Number(CONCURRENCY && CONCURRENCY.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS =
Number(CONCURRENCY && CONCURRENCY.TRANSACTION_MAX_WAIT_MS) || 3000;
// CORE-41: Lease para transacciones (5 minutos por defecto)
const TRANSACTION_LEASE_MS =
Number(CONCURRENCY && CONCURRENCY.TRANSACTION_LEASE_MS) || 300000;

async function _getTransactionById(pairToken) {
const id = _safeTrim(pairToken);
if (!id) return null;
// CORE-31/33: elevatedGet + STRONG_READ.
return await elevatedGet(TRANSACTIONS_COL, id).catch(
function () {
return null;
}
);
}

function _readTransaction(doc) {
if (!doc) return null;
const payload = _parsePayloadJson(doc.payloadJson);
return {
doc: doc,
status: _safeTrim(payload.status || doc.status),
payloadHash: _safeTrim(payload.payloadHash || doc.payloadHash),
ownerTraceId: _safeTrim(
payload.ownerTraceId || doc.ownerTraceId
),
ownerExecutionId: _safeTrim(
payload.ownerExecutionId || doc.ownerExecutionId
),
error: _safeTrim(payload.error || doc.error),
bookingId: _safeTrim(payload.bookingId || doc.bookingId),
result:
payload.result !== undefined ? payload.result : doc.result,
leaseExpiresAt: _toDateSafe(payload.leaseExpiresAt || doc.leaseExpiresAt),
heartbeatAt: _toDateSafe(payload.heartbeatAt || doc.heartbeatAt),
attempt: Number(payload.attempt || doc.attempt || 0),
};
}

function _extractBookingIdFromResult(result) {
if (!result || typeof result !== "object") return "";
const direct = _safeTrim(result.bookingId);
if (direct) return direct;
const nested =
result.data && typeof result.data === "object"
? result.data
: {};
return _safeTrim(nested.bookingId);
}

/**
* CORE-41: _buildTransactionControl incluye leaseExpiresAt, ownerExecutionId,
* heartbeatAt, attempt para transacciones recuperables.
* FIX: propaga _revision del existingDoc para revisión optimista.
*/
function _buildTransactionControl(pairToken, state, existingDoc) {
const payload = Object.assign({}, state);
let payloadJson = JSON.stringify(payload);
if (payloadJson.length > TX_PAYLOAD_MAX_CHARS) {
delete payload.result;
payload.resultDropped = true;
payloadJson = JSON.stringify(payload);
}
const now = new Date();
const doc = {
_id: String(pairToken),
controlType: CONTROL_TYPE.IDEMPOTENCY,
dedupeKey: TX_DEDUPE_PREFIX + String(pairToken),
payloadJson: payloadJson,
// CORE-41: Campos de lease y heartbeat
leaseExpiresAt: payload.leaseExpiresAt || (existingDoc && existingDoc.leaseExpiresAt) || null,
heartbeatAt: payload.heartbeatAt || (existingDoc && existingDoc.heartbeatAt) || now,
attempt: payload.attempt || (existingDoc && existingDoc.attempt) || 1,
traceId:
_safeTrim(existingDoc && existingDoc.traceId) ||
_safeTrim(state.ownerTraceId) ||
makeTraceId("tx"),
};
// FIX: propagar _revision para revisión optimista
if (existingDoc && existingDoc._revision !== undefined) {
doc._revision = existingDoc._revision;
}
const bookingId = _safeTrim(payload.bookingId);
if (bookingId) doc.bookingId = bookingId;
return doc;
}

async function _writeTransaction(pairToken, state, existingDoc) {
const doc = _buildTransactionControl(pairToken, state, existingDoc);
try {
if (existingDoc && existingDoc._id) {
await elevatedUpdate(TRANSACTIONS_COL, doc);
} else {
await elevatedInsert(TRANSACTIONS_COL, doc);
}
} catch (error) {
if (!_isDuplicateItemError(error)) {
log.error("_writeTransaction failed", {
pairToken: pairToken,
error: error && error.message,
});
}
}
}

/**
* FIX: _evaluatePendingTransaction reconoce FAILED_RETRYABLE y FAILED_FINAL.
*/
function _evaluatePendingTransaction(current, payloadHash) {
if (!current) return null;
if (current.payloadHash !== String(payloadHash || "")) {
return {
success: false,
error: ERROR_CODES.PAIR_TOKEN_PAYLOAD_MISMATCH,
existing: current,
};
}
if (current.status === "COMPLETED") {
return { success: true, isNew: false, existing: current };
}
if (current.status === "FAILED" || current.status === "FAILED_RETRYABLE" || current.status === "FAILED_FINAL") {
return {
success: false,
error: ERROR_CODES.TRANSACTION_PREVIOUSLY_FAILED,
existing: current,
};
}
return null;
}

/**
* CORE-41: _initTransaction incluye leaseExpiresAt y ownerExecutionId.
* Estados: IN_PROGRESS (antes PENDING), COMPLETED, FAILED_RETRYABLE, FAILED_FINAL.
*/
export async function _initTransaction(pairToken, payloadHash, traceId, ownerExecutionId) {
const id = _safeTrim(pairToken);
if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };
const now = new Date();
const state = {
status: "IN_PROGRESS", // CORE-41: antes "PENDING"
payloadHash: String(payloadHash || ""),
ownerTraceId: String(traceId || ""),
ownerExecutionId: String(ownerExecutionId || traceId || ""),
leaseExpiresAt: new Date(now.getTime() + TRANSACTION_LEASE_MS),
heartbeatAt: now,
attempt: 1,
};
try {
await elevatedInsert(
TRANSACTIONS_COL,
_buildTransactionControl(id, state, null)
);
return { success: true, isNew: true };
} catch (error) {
if (!_isDuplicateItemError(error)) {
log.error("_initTransaction: insert failed", {
pairToken: id,
error: error && error.message,
});
return { success: false, error: ERROR_CODES.DATABASE_ERROR };
}
}
const startTime = Date.now();
let pollAttempt = 0;
while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
const verdict = _evaluatePendingTransaction(
_readTransaction(await _getTransactionById(id)),
payloadHash
);
if (verdict) return verdict;
const remainingMs =
TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
const delay = Math.min(
Math.floor(
TRANSACTION_POLL_BASE_MS *
Math.pow(2, Math.min(pollAttempt, 3)) *
(0.5 + Math.random())
),
remainingMs
);
if (delay <= 0) break;
pollAttempt += 1;
await new Promise(function (resolve) {
setTimeout(resolve, delay);
});
}
const finalState = _readTransaction(await _getTransactionById(id));
return (
_evaluatePendingTransaction(finalState, payloadHash) || {
success: false,
error: ERROR_CODES.TRANSACTION_TIMEOUT,
existing: finalState,
timeout: true,
}
);
}

/**
* CORE-44: claimTransaction para reclamar transacciones huérfanas.
* Solo se puede reclamar si:
* - status !== "COMPLETED"
* - leaseExpiresAt < now (lease expirado)
* Usa revisión optimista para que solo un proceso gane.
*/
export async function claimTransaction(pairToken, newOwnerExecutionId, newTraceId) {
const id = _safeTrim(pairToken);
if (!id) return { ok: false, reason: "INVALID_PAIR_TOKEN" };

const current = await _getTransactionById(id);
if (!current) return { ok: false, reason: "NOT_FOUND" };

const tx = _readTransaction(current);

// No reclamar si está completada
if (tx.status === "COMPLETED") {
return { ok: false, reason: "ALREADY_COMPLETED" };
}

// Verificar que el lease haya expirado
const leaseExpiresAt = tx.leaseExpiresAt;
if (leaseExpiresAt && leaseExpiresAt.getTime() > Date.now()) {
return { ok: false, reason: "LEASE_NOT_EXPIRED" };
}

// Intentar reclamar con revisión optimista
const now = new Date();
const newState = {
status: "IN_PROGRESS",
payloadHash: tx.payloadHash,
ownerTraceId: String(newTraceId || ""),
ownerExecutionId: String(newOwnerExecutionId || ""),
leaseExpiresAt: new Date(now.getTime() + TRANSACTION_LEASE_MS),
heartbeatAt: now,
attempt: tx.attempt + 1,
bookingId: tx.bookingId,
};

try {
await elevatedUpdate(
TRANSACTIONS_COL,
_buildTransactionControl(id, newState, current)
);
return {
ok: true,
transaction: _readTransaction(await _getTransactionById(id)),
};
} catch (error) {
if (_isRevisionConflictError(error)) {
return { ok: false, reason: "CLAIM_RACE" };
}
log.error("claimTransaction: update failed", {
pairToken: id,
error: error && error.message,
});
return { ok: false, reason: ERROR_CODES.DATABASE_ERROR };
}
}

export async function _completeTransaction(pairToken, result, traceId) {
const id = _safeTrim(pairToken);
if (!id) return;
const current = _readTransaction(await _getTransactionById(id));
if (current && current.status === "COMPLETED") return;
await _writeTransaction(
id,
{
status: "COMPLETED",
payloadHash: current ? current.payloadHash : "",
ownerTraceId:
_safeTrim(traceId) ||
(current ? current.ownerTraceId : ""),
bookingId: _extractBookingIdFromResult(result),
result: result === undefined ? null : result,
},
current ? current.doc : null
);
}

/**
* CORE-41 FIX: _failTransaction distingue entre FAILED_RETRYABLE y FAILED_FINAL.
*/
export async function _failTransaction(pairToken, errorMessage, retryable = true) {
const id = _safeTrim(pairToken);
if (!id) return;
const current = _readTransaction(await _getTransactionById(id));
if (current && current.status === "COMPLETED") return;
// CORE-41: Distinguir entre FAILED_RETRYABLE y FAILED_FINAL
const finalStatus = retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
await _writeTransaction(
id,
{
status: finalStatus,
payloadHash: current ? current.payloadHash : "",
ownerTraceId: current ? current.ownerTraceId : "",
error: String(errorMessage || ERROR_CODES.UNKNOWN_ERROR),
},
current ? current.doc : null
);
}

// =============================================================================
// BLOQUE 12 - PERSISTENCIA EN CITAS_F2 (CORE-35/36)
// =============================================================================
// CORE-32: BUSINESS_COLLECTIONS directo. Sin alias COLLECTIONS.
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

/**
* CORE-37: minimiza contactDetails preservando memberId si existe.
* Solo firstName, lastName, email, phone, memberId. Nada más.
*/
function _minimizeContactDetails(contactDetails) {
const cd =
contactDetails && typeof contactDetails === "object"
? contactDetails
: {};
const out = {};
const firstName = _safeTrim(cd.firstName || cd.first_name);
const lastName = _safeTrim(cd.lastName || cd.last_name);
const email = _safeTrim(cd.email);
const phone = _safeTrim(cd.phone || cd.phoneNumber);
const memberId = _safeTrim(cd.memberId);
if (firstName) out.firstName = firstName;
if (lastName) out.lastName = lastName;
if (email) out.email = email;
if (phone) out.phone = phone;
if (memberId) out.memberId = memberId;
return out;
}

function _normalizeMeta(rawMeta, overrides) {
let meta = rawMeta;
if (typeof meta === "string") {
try {
meta = JSON.parse(meta);
} catch (_) {
meta = {};
}
}
if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
return Object.assign({}, meta, overrides);
}

/**
* CORE-35: escribe slotStart/slotEnd Y startDate/endDate.
* Ambos pares existen en CMS KEY FIELDS CitasF2.
* CORE-36: usa BOOKING_FIELDS.X para todas las keys.
* CORE-33: elevatedInsert/elevatedUpdate para colección admin-only.
*/
export async function _persistBooking(params, traceId) {
const p = params || {};
const traceIdClean = _safeTrim(traceId || p.traceId);
if (!traceIdClean) {
throw createBookingError(
ERROR_CODES.INVALID_PAYLOAD,
"traceId is required to persist a booking in CitasF2",
{ bookingId: _safeTrim(p.bookingId) }
);
}
const bookingId = _safeTrim(p.bookingId);
const serviceId = _safeTrim(p.serviceId);
const resourceId = _safeTrim(p.resourceId);
if (
!bookingId ||
!serviceId ||
!resourceId ||
!p.startDate ||
!p.endDate
) {
throw createBookingError(
ERROR_CODES.INVALID_PAYLOAD,
"Missing required fields for persistBooking",
{ traceId: traceIdClean, bookingId: bookingId }
);
}
const scheduleIdClean = _safeTrim(p.scheduleId);
if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
throw createBookingError(
ERROR_CODES.INVALID_PAYLOAD,
"scheduleId is required and must be a valid GUID for CitasF2 persistence",
{
traceId: traceIdClean,
bookingId: bookingId,
scheduleIdRaw: p.scheduleId,
}
);
}
const startDateObj = _toDateSafe(p.startDate);
const endDateObj = _toDateSafe(p.endDate);
if (
!startDateObj ||
!endDateObj ||
endDateObj.getTime() <= startDateObj.getTime()
) {
throw createBookingError(
ERROR_CODES.INVALID_DATES,
"Invalid startDate/endDate for persistBooking",
{ traceId: traceIdClean, bookingId: bookingId }
);
}
const startLocal = getMadridLocalStringNoZ(startDateObj);
const dateYmd = startLocal ? startLocal.slice(0, 10) : "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
throw createBookingError(
ERROR_CODES.INVALID_DATES,
"Cannot derive dateYmd (Europe/Madrid) from slotStart",
{
traceId: traceIdClean,
bookingId: bookingId,
startLocal: startLocal,
}
);
}
const bookingType = normalizeBookingType(p.bookingType || p.tipo);
const pairToken = _safeTrim(
p.pairToken || (p.meta && p.meta.pairToken)
);
if (isDualBookingType(bookingType) && !pairToken) {
throw createBookingError(
ERROR_CODES.INVALID_PAYLOAD,
"Missing pairToken for linked booking",
{
traceId: traceIdClean,
bookingId: bookingId,
bookingType: bookingType,
}
);
}
const metaObj =
p.meta && typeof p.meta === "object" ? p.meta : {};
const rawPayment =
p.paymentStatus !== undefined
? p.paymentStatus
: metaObj.paymentStatus !== undefined
? metaObj.paymentStatus
: PAYMENT_STATUS.NOT_PAID;
const paymentStatus = _toCmsPaymentStatus(rawPayment);
const rawBookingStatus =
p.bookingStatus !== undefined ? p.bookingStatus : p.status;
const bookingStatus =
_toCmsBookingStatus(rawBookingStatus) ||
_deriveCmsBookingStatus(paymentStatus);
assertValidEnum(bookingStatus, CITAS_BOOKING_STATUS, "bookingStatus");
assertValidEnum(paymentStatus, CITAS_PAYMENT_STATUS, "paymentStatus");
const thirdPartyId = _safeTrim(
p.thirdPartyId || metaObj.thirdPartyId
);
if (!thirdPartyId) {
log.warn("CitasF2 persisted without thirdPartyId (ADR pendiente)", {
traceId: traceIdClean,
bookingId: bookingId,
});
}
const catalogId = _safeTrim(p.catalogId) || serviceId;
const totalAmount = _roundMoney(
Number(
p.totalAmount !== undefined
? p.totalAmount
: metaObj.totalAmount || 0
) || 0
);
// CORE-35/36: doc con todas las keys via BOOKING_FIELDS + startDate/endDate.
const doc = {
[BOOKING_FIELDS.BOOKING_ID]: bookingId,
[BOOKING_FIELDS.PAIR_TOKEN]: pairToken,
[BOOKING_FIELDS.CATALOG_ID]: catalogId,
[BOOKING_FIELDS.SERVICE_ID]: serviceId,
[BOOKING_FIELDS.SCHEDULE_ID]: scheduleIdClean,
[BOOKING_FIELDS.RESOURCE_ID]: resourceId,
[BOOKING_FIELDS.THIRD_PARTY_ID]: thirdPartyId,
[BOOKING_FIELDS.DATE_YMD]: dateYmd,
[BOOKING_FIELDS.SLOT_START]: startDateObj,
[BOOKING_FIELDS.SLOT_END]: endDateObj,
[BOOKING_FIELDS.START_DATE]: startDateObj,
[BOOKING_FIELDS.END_DATE]: endDateObj,
[BOOKING_FIELDS.BOOKING_TYPE]: bookingType,
[BOOKING_FIELDS.REVISION]: Number(p.revision) || 1,
[BOOKING_FIELDS.STATUS]: bookingStatus,
[BOOKING_FIELDS.PAYMENT_STATUS]: paymentStatus,
[BOOKING_FIELDS.TOTAL_AMOUNT]: totalAmount,
[BOOKING_FIELDS.CONTACT_DETAILS]: _minimizeContactDetails(
p.contactDetails
),
meta: _normalizeMeta(p.meta, {
bookingStatus: bookingStatus,
paymentStatus: paymentStatus,
}),
[BOOKING_FIELDS.TRACE_ID]: traceIdClean,
};
// CORE-31/33: query elevada con STRONG_READ.
const existing = await elevatedQueryFind(CITAS_COL, function (q) {
return q.eq(BOOKING_FIELDS.BOOKING_ID, bookingId).limit(1);
}).catch(function () {
return null;
});
if (
existing &&
Array.isArray(existing.items) &&
existing.items.length > 0
) {
const existingDoc = existing.items[0];
const incomingRevision =
Number(doc[BOOKING_FIELDS.REVISION]) || 1;
const currentRevision =
Number(existingDoc[BOOKING_FIELDS.REVISION]) || 1;
if (incomingRevision < currentRevision) {
throw new BookingError(
ERROR_CODES.DATABASE_ERROR,
"Booking revision conflict",
{
bookingId: bookingId,
currentRevision: currentRevision,
incomingRevision: incomingRevision,
traceId: traceIdClean,
}
);
}
const updated = Object.assign({}, existingDoc, doc);
delete updated._createdDate;
delete updated._updatedDate;
delete updated._owner;
delete updated.status;
const item = await elevatedUpdate(CITAS_COL, updated);
return { created: false, item: item };
}
const item = await elevatedInsert(CITAS_COL, doc);
return { created: true, item: item };
}

// =============================================================================
// BLOQUE 13 - ACTUALIZACIÓN SEGURA DE CITA
// =============================================================================
/**
* Actualiza cita con transición controlada de enums.
* CORE-33: elevatedQueryFind + elevatedUpdate.
* CORE-36: usa BOOKING_FIELDS.X.
*/
export async function _updateCitaSafe(
bookingId,
updater,
traceId,
operation
) {
const bid = _safeTrim(bookingId);
if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };
try {
const res = await elevatedQueryFind(CITAS_COL, function (q) {
return q.eq(BOOKING_FIELDS.BOOKING_ID, bid).limit(1);
});
const cita =
res && Array.isArray(res.items) ? res.items[0] : null;
if (!cita) {
log.warn("_updateCitaSafe: cita not found", {
bookingId: bid,
operation: operation,
traceId: traceId,
});
return { updated: false, reason: "NOT_FOUND" };
}
const updated = updater(cita);
if (!updated) return { updated: false, reason: "NO_CHANGE" };
const rawStatus =
updated.bookingStatus !== undefined
? updated.bookingStatus
: updated.status;
const nextBookingStatus =
_toCmsBookingStatus(rawStatus) || cita.bookingStatus;
const nextPaymentStatus =
_toCmsPaymentStatus(updated.paymentStatus) ||
cita.paymentStatus;
assertValidEnum(
nextBookingStatus,
CITAS_BOOKING_STATUS,
"bookingStatus"
);
assertValidEnum(
nextPaymentStatus,
CITAS_PAYMENT_STATUS,
"paymentStatus"
);
updated[BOOKING_FIELDS.STATUS] = nextBookingStatus;
updated[BOOKING_FIELDS.PAYMENT_STATUS] = nextPaymentStatus;
delete updated.status;
updated[BOOKING_FIELDS.TRACE_ID] =
_safeTrim(traceId) || _safeTrim(updated.traceId);
delete updated._createdDate;
delete updated._updatedDate;
delete updated._owner;
await elevatedUpdate(CITAS_COL, updated);
return { updated: true, bookingId: bid };
} catch (err) {
log.error("_updateCitaSafe failed", {
bookingId: bid,
operation: operation,
traceId: traceId,
error: err && err.message,
});
return {
updated: false,
reason: "ERROR",
error: err && err.message,
};
}
}

// =============================================================================
// BLOQUE 14 - EXTRACCIÓN DE RESOURCEIDS DESDE SLOTS
// =============================================================================
/**
* Delegación completa a bookingUtils.getResourceIdsFromSlot.
* Exige staffResourceTypeId explícito (UTILS-13). Fail-closed.
*/
export function _extractResourceIdsFromSlot(slot) {
return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 15 - VERIFICACIÓN DE CONTIGÜIDAD / GAP ENTRE SLOTS
// =============================================================================
/**
* CORE-34: computeGapMinutes devuelve null ante fechas inválidas.
* null nunca debe degradarse a gap válido (fail-closed).
*/
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
if (!slot1 || !slot2) return false;
const fallbackTolerance = Number(
SLOT_SEARCH && SLOT_SEARCH.MINUTOS_TOLERANCIA
);
const maxGap =
maxGapMinutes === null || maxGapMinutes === undefined
? Number.isFinite(fallbackTolerance)
? fallbackTolerance
: 120
: Number(maxGapMinutes);
const end1 = slot1.localEndDate || slot1.endDate;
const start2 = slot2.localStartDate || slot2.startDate;
if (!end1 || !start2) return false;
const end1Utc =
end1 instanceof Date
? end1
: getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
const start2Utc =
start2 instanceof Date
? start2
: getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
if (!end1Utc || !start2Utc) return false;
const rawDiffMinutes =
(start2Utc.getTime() - end1Utc.getTime()) / 60000;
if (rawDiffMinutes < -1) return false;
// CORE-34: gap null = fail-closed.
const gap = computeGapMinutes(end1Utc, start2Utc);
if (gap === null) return false;
return gap <= maxGap;
}

// =============================================================================
// BLOQUE 16 - PROYECCIÓN DE SLOTS CERTIFICADOS Y WRITER
// =============================================================================
/**
* Proyecta slot certificado al contrato interno canónico.
* Lee preferentemente localStartDate/localEndDate; cae a startDate/endDate
* solo para respuestas Wix crudas.
*/
export function _projectCertifiedSlot(slot, resourceId) {
const normalized = normalizeAvailabilitySlot(slot);
if (!normalized) return null;
const serviceId = _safeTrim(normalized.serviceId);
if (!serviceId || !_looksLikeGuid(serviceId)) return null;
const resourceCandidate =
normalized.resource && typeof normalized.resource === "object"
? normalized.resource
: {};
const resourceIdClean = _safeTrim(
resourceId || normalized.resourceId || resourceCandidate.id
);
if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
const localStartDate = normalized.localStartDate;
const localEndDate = normalized.localEndDate;
if (!localStartDate || !localEndDate) return null;
const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
const endDateUtc = getUtcDateFromMadridLocal(localEndDate);
if (
!startDateUtc ||
!endDateUtc ||
endDateUtc.getTime() <= startDateUtc.getTime()
) {
return null;
}
const slotLocation =
normalized.location && typeof normalized.location === "object"
? normalized.location
: {};
const slotLocationId = _safeTrim(slotLocation.id);
if (
slotLocationId &&
CONFIGURED_LOCATION_ID &&
slotLocationId !== CONFIGURED_LOCATION_ID
) {
log.warn("_projectCertifiedSlot: location mismatch", {
slotLocationId: slotLocationId,
configuredLocationId: CONFIGURED_LOCATION_ID,
serviceId: serviceId,
});
return null;
}
const locationId = slotLocationId || CONFIGURED_LOCATION_ID;
if (!locationId || !_looksLikeGuid(locationId)) {
log.warn(
"_projectCertifiedSlot: missing or invalid locationId",
{
slotLocationId: slotLocationId,
configuredLocationId: CONFIGURED_LOCATION_ID,
serviceId: serviceId,
}
);
return null;
}
const nestedSlot =
normalized.slot && typeof normalized.slot === "object"
? normalized.slot
: {};
return {
serviceId: serviceId,
resourceId: resourceIdClean,
scheduleId: _safeTrim(
normalized.scheduleId || nestedSlot.scheduleId
),
localStartDate: localStartDate,
localEndDate: localEndDate,
startDate: startDateUtc,
endDate: endDateUtc,
bookable: normalized.bookable === true,
availableResources: _extractResourceIdsFromSlot(normalized),
timezone:
_safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
locationId: locationId,
locationName: _safeTrim(slotLocation.name),
formattedAddress: _safeTrim(slotLocation.formattedAddress),
};
}

/**
* Proyecta slot de disponibilidad al formato Writer V2.
* NO inyecta addOnIds ni selectedAddOns dentro del slot.
* Los add-ons viajan por bookedAddOns a nivel raíz del body.
*/
export function _projectWriterSlotFromAvailability(
slot,
resourceId,
serviceId
) {
const projected = _projectCertifiedSlot(slot, resourceId);
if (!projected) return null;
const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;
const nestedSlot =
slot.slot && typeof slot.slot === "object" ? slot.slot : {};
const scheduleId = _safeTrim(
projected.scheduleId || slot.scheduleId || nestedSlot.scheduleId
);
if (!scheduleId || !_looksLikeGuid(scheduleId)) {
log.warn(
"_projectWriterSlotFromAvailability: missing or invalid scheduleId",
{
serviceId: finalServiceId,
scheduleIdRaw: projected.scheduleId || null,
}
);
return null;
}
let writerLocationType = _safeTrim(
SDK_CONFIG &&
SDK_CONFIG.LOCATION_TYPES &&
SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
);
if (!writerLocationType || writerLocationType === "BUSINESS") {
writerLocationType = "OWNER_BUSINESS";
}
return {
serviceId: finalServiceId,
scheduleId: scheduleId,
startDate: projected.startDate,
endDate: projected.endDate,
timezone: projected.timezone,
resource: { id: projected.resourceId },
location: {
id: projected.locationId,
locationType: writerLocationType,
},
};
}

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANÓNICO
// =============================================================================
export { _buildPairFingerprint, _buildPairTokenDeterministic };

// =============================================================================
// BLOQUE 18 - RANKING DE RECURSOS POR CARGA
// =============================================================================
/**
* Ranking de recursos por carga diaria. Dedupe case-insensitive.
* CORE-31/33: elevatedQueryFind + STRONG_READ.
* CORE-36: usa BOOKING_FIELDS.X para queries.
*/
export async function _rankResourcesByLoad(
resourceIds,
dateYmd,
traceId
) {
const input = Array.isArray(resourceIds)
? (function () {
const seen = new Set();
const out = [];
for (let i = 0; i < resourceIds.length; i += 1) {
const raw = _safeTrim(resourceIds[i]);
if (!_looksLikeGuid(raw)) continue;
const key = _normalizeGuidForComparison(raw);
if (seen.has(key)) continue;
seen.add(key);
out.push(raw);
}
return out;
})()
: [];
if (input.length < 2) return input;
const day = _safeTrim(dateYmd);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
log.warn("_rankResourcesByLoad: invalid dateYmd", {
dateYmd: day,
traceId: traceId,
});
return input;
}
const loads = {};
input.forEach(function (id, index) {
loads[id] = { resourceId: id, load: 0, firstIndex: index };
});
try {
const pageSize = 1000;
let skip = 0;
let hasMore = true;
while (hasMore) {
// CORE-33: query elevada con STRONG_READ.
const result = await elevatedQueryFind(
CITAS_COL,
function (q) {
return q
.eq(BOOKING_FIELDS.DATE_YMD, day)
.hasSome(BOOKING_FIELDS.RESOURCE_ID, input)
.limit(pageSize)
.skip(skip);
}
);
const items =
result && Array.isArray(result.items)
? result.items
: [];
for (let i = 0; i < items.length; i += 1) {
const item = items[i];
const itemResourceId = _safeTrim(
item && item[BOOKING_FIELDS.RESOURCE_ID]
);
if (!loads[itemResourceId]) continue;
const status = _toCmsBookingStatus(
(item &&
(item[BOOKING_FIELDS.STATUS] || item.status)) ||
""
);
const payment = _toCmsPaymentStatus(
(item && item[BOOKING_FIELDS.PAYMENT_STATUS]) || ""
);
const inactive =
status === CITAS_BOOKING_STATUS.CANCELLED ||
status === CITAS_BOOKING_STATUS.NO_SHOW;
const refunded =
payment === CITAS_PAYMENT_STATUS.REFUNDED;
if (!inactive && !refunded) {
loads[itemResourceId].load += 1;
}
}
skip += items.length;
hasMore = items.length === pageSize;
}
return Object.keys(loads)
.map(function (key) {
return loads[key];
})
.sort(function (a, b) {
return a.load - b.load || a.firstIndex - b.firstIndex;
})
.map(function (entry) {
return entry.resourceId;
});
} catch (error) {
log.warn(
"_rankResourcesByLoad failed; preserving availability order",
{
traceId: traceId,
dateYmd: day,
error: error && error.message,
}
);
return input;
}
}
