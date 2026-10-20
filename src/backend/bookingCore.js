/*
MODULE: backend/booking/bookingCore.js
VERSION: v5019-CMS-LOCATION-SCHEDULE
RESPONSIBILITY: Primitivas atómicas de reserva (simple y dual con gap) sobre
Bookings Writer V2: locks, idempotencia, persistencia CitasF2,
proyeccion de slots y traduccion de enums en frontera.

CORRECCIONES v5019-CMS-LOCATION-SCHEDULE:
  CORE-53 (P0): _resolveAvailabilityLocation resuelve el locationId desde
    ServiciosCatalogo.locationId (vía DTO), con fallback a SDK_CONFIG.LOCATION_ID.
    Elimina el hardcode que forzaba todas las reservas a una única sede.
  CORE-54 (P0): _forceStaffInPristineSlot prioriza slot.location.id sobre el
    fallback configurado. El slot de Wix es la fuente de verdad; no se rechaza
    por discrepancia de locationId.
  CORE-55 (P1): _forceStaffInPristineSlot reutiliza slot.scheduleId si está
    presente. Solo resuelve vía _resolveScheduleIdForResource como fallback.
    scheduleId es opcional en Create Booking para citas, pero su presencia
    mejora la vinculación con la agenda del staff.
  CORE-56 (P1): locationType se fuerza a "OWNER_BUSINESS" para escritura,
    independientemente del valor recibido en el slot (que para consulta es
    "BUSINESS"). Cumple con la documentación oficial de Create Booking.
  CORE-57 (P2): _resolveAvailabilityLocation usa "BUSINESS" para consultas
    de disponibilidad (Time Slots V2), y "OWNER_BUSINESS" para escritura.

DOC OFICIAL:
  - Create Booking (appointment): https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/create-booking
    "Specify the slot's startDate, endDate, resource, and location in booking.bookedEntity.slot"
  - Slot Resource: https://cdn.jsdelivr.net/npm/@wix/auto_sdk_bookings_bookings@1.0.183/build/internal/es/meta.d.mts
    scheduleId?: string (opcional); resource?: SlotResource { id: GUID }
  - Bulk Create Booking (ejemplo scheduleId): https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/bulk-create-booking
*/

import { bookings } from "@wix/bookings";
import { checkout } from "@wix/ecom";
import { auth } from "@wix/essentials";
import {
    query as dalQuery,
    getItem as dalGet,
    insertItem as dalInsert,
    updateItem as dalUpdate,
    removeById as dalRemove
} from "backend/dataAccess";
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

/* =============================================================================
 * CONSTANTS
 * ==========================================================================*/
const CONSISTENT_READ = Object.freeze({ consistentRead: true });

const elevatedInsert = dalInsert;
const elevatedUpdate = dalUpdate;
const elevatedRemove = dalRemove;
const elevatedGet = function (collection, id) {
    return dalGet(collection, id, "strong");
};

function elevatedQueryFind(collection, queryFn) {
    return Promise.resolve(queryFn(dalQuery(collection))).then(function (q) {
        return q.find(CONSISTENT_READ);
    });
}

/* =============================================================================
 * ERROR CODES
 * ==========================================================================*/
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
    LOCATION_NOT_CONFIGURED: "LOCATION_NOT_CONFIGURED",
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

/* =============================================================================
 * CMS STATUS ENUMS
 * ==========================================================================*/
export const CMS_BOOKING_STATUS = CITAS_BOOKING_STATUS;
export const CMS_PAYMENT_STATUS = CITAS_PAYMENT_STATUS;

const CMS_BOOKING_CANCELLED =
    (CITAS_BOOKING_STATUS &&
        (CITAS_BOOKING_STATUS.CANCELLED || CITAS_BOOKING_STATUS.CANCELED)) ||
    "CANCELLED";
const CMS_BOOKING_REFUNDED =
    (CITAS_BOOKING_STATUS && CITAS_BOOKING_STATUS.REFUNDED) || "REFUNDED";

const WIX_TO_CMS_BOOKING_STATUS = Object.freeze({
    CREATED: CITAS_BOOKING_STATUS.PENDING,
    PENDING: CITAS_BOOKING_STATUS.PENDING,
    WAITING_LIST: CITAS_BOOKING_STATUS.PENDING,
    CONFIRMED: CITAS_BOOKING_STATUS.CONFIRMED,
    UPDATED: CITAS_BOOKING_STATUS.CONFIRMED,
    COMPLETED: CITAS_BOOKING_STATUS.COMPLETED,
    CANCELED: CMS_BOOKING_CANCELLED,
    CANCELLED: CMS_BOOKING_CANCELLED,
    DECLINED: CMS_BOOKING_CANCELLED,
    REFUNDED: CMS_BOOKING_REFUNDED,
    NO_SHOW: CITAS_BOOKING_STATUS.NO_SHOW,
    NOSHOW: CITAS_BOOKING_STATUS.NO_SHOW,
    PENDIENTE: CITAS_BOOKING_STATUS.PENDING,
    CONFIRMADO: CITAS_BOOKING_STATUS.CONFIRMED,
    COMPLETADO: CITAS_BOOKING_STATUS.COMPLETED,
    CANCELADO: CMS_BOOKING_CANCELLED,
    REEMBOLSADO: CMS_BOOKING_REFUNDED,
    NO_PRESENTADO: CITAS_BOOKING_STATUS.NO_SHOW,
});

const WIX_TO_CMS_PAYMENT_STATUS = Object.freeze({
    UNDEFINED: CITAS_PAYMENT_STATUS.UNDEFINED,
    NOT_PAID: CITAS_PAYMENT_STATUS.NOT_PAID,
    PENDING_PAYMENT: CITAS_PAYMENT_STATUS.PENDING_PAYMENT,
    PENDING_LEDGER: CITAS_PAYMENT_STATUS.PENDING_LEDGER,
    UNPAID: CITAS_PAYMENT_STATUS.NOT_PAID,
    PAID: CITAS_PAYMENT_STATUS.PAID,
    EXEMPT: CITAS_PAYMENT_STATUS.EXEMPT,
    PARTIALLY_PAID: CITAS_PAYMENT_STATUS.PARTIALLY_PAID,
    PARTIALLY_REFUNDED: CITAS_PAYMENT_STATUS.PARTIALLY_REFUNDED,
    PARTIAL: CITAS_PAYMENT_STATUS.PARTIALLY_PAID,
    REFUNDED: CITAS_PAYMENT_STATUS.REFUNDED,
    IMPAGADO: CITAS_PAYMENT_STATUS.NOT_PAID,
    NO_PAGADO: CITAS_PAYMENT_STATUS.NOT_PAID,
    PENDIENTE_PAGO: CITAS_PAYMENT_STATUS.PENDING_PAYMENT,
    PAGADO: CITAS_PAYMENT_STATUS.PAID,
    PARCIALMENTE_PAGADO: CITAS_PAYMENT_STATUS.PARTIALLY_PAID,
    REEMBOLSADO_PARCIAL: CITAS_PAYMENT_STATUS.PARTIALLY_REFUNDED,
    REEMBOLSADO: CITAS_PAYMENT_STATUS.REFUNDED,
    EXENTO: CITAS_PAYMENT_STATUS.EXEMPT,
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
    if (
        cmsPaymentStatus === CITAS_PAYMENT_STATUS.NOT_PAID ||
        cmsPaymentStatus === CITAS_PAYMENT_STATUS.PENDING_PAYMENT ||
        cmsPaymentStatus === CITAS_PAYMENT_STATUS.PENDING_LEDGER
    ) {
        return CITAS_BOOKING_STATUS.PENDING;
    }
    return CITAS_BOOKING_STATUS.CONFIRMED;
}

/* =============================================================================
 * ELEVATED PROXIES
 * ==========================================================================*/
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

const _confirmOrDeclineElevatedRaw = auth.elevate(
    bookings.confirmOrDeclineBooking
);

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

/* =============================================================================
 * BOOKINGERROR & NORMALIZATION
 * ==========================================================================*/
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
        const legacy = err.code || err.errorCode || null;
        const msgCode =
            !legacy && typeof err.message === "string"
                ? (err.message.match(/^([A-Z][A-Z0-9_]{2,60}):/) || [])[1] || null
                : null;
        return {
            code: String(legacy || msgCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details:
                err.details && typeof err.details === "object" ? err.details : {},
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
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId: traceId,
        details: norm.details,
    });
    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
            message: norm.message || "Unknown error",
        },
    };
}

/* =============================================================================
 * LOW-LEVEL HELPERS
 * ==========================================================================*/
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

/* =============================================================================
 * LOCATION RESOLUTION (CORE-53 / CORE-57)
 * ==========================================================================*/
/**
 * CORE-53: resuelve la ubicación para consultas de disponibilidad.
 * Prioridad: service.locationId (CMS) → SDK_CONFIG.LOCATION_ID (fallback).
 * CORE-57: el tipo para consultas es siempre "BUSINESS".
 * Devuelve null si no hay un locationId válido.
 */
export function _resolveAvailabilityLocation(service) {
    const fromCms = _safeTrim(service && service.locationId);
    const fromConfig = _safeTrim(SDK_CONFIG && SDK_CONFIG.LOCATION_ID);
    const locationId = _looksLikeGuid(fromCms)
        ? fromCms
        : _looksLikeGuid(fromConfig)
        ? fromConfig
        : "";
    if (!locationId) {
        log.error("_resolveAvailabilityLocation: no valid locationId", {
            cmsLocationId: fromCms || null,
            configLocationId: fromConfig || null,
        });
        return null;
    }
    return Object.freeze({ id: locationId, locationType: "BUSINESS" });
}

/**
 * CORE-53: resuelve la ubicación para escritura (Create Booking).
 * Prioridad: slot.location.id (fuente de verdad de Wix) → service.locationId
 * (CMS) → SDK_CONFIG.LOCATION_ID (fallback).
 * CORE-56: el tipo se fuerza a "OWNER_BUSINESS" para escritura.
 * Devuelve null si no hay un locationId válido.
 */
export function _resolveWriteLocation(slotLocation, serviceConfig) {
    const incoming = _safeTrim(slotLocation && slotLocation.id);
    const fromCms = _safeTrim(serviceConfig && serviceConfig.locationId);
    const fromConfig = _safeTrim(SDK_CONFIG && SDK_CONFIG.LOCATION_ID);
    const locationId = _looksLikeGuid(incoming)
        ? incoming
        : _looksLikeGuid(fromCms)
        ? fromCms
        : _looksLikeGuid(fromConfig)
        ? fromConfig
        : "";
    if (!locationId) {
        log.error("_resolveWriteLocation: no valid locationId", {
            incomingLocationId: incoming || null,
            cmsLocationId: fromCms || null,
            configLocationId: fromConfig || null,
        });
        return null;
    }
    return Object.freeze({ id: locationId, locationType: "OWNER_BUSINESS" });
}

/* =============================================================================
 * SCHEDULE RESOLUTION (CORE-55)
 * ==========================================================================*/
async function _resolveScheduleIdByResourceId(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    const scheduleId = await getStaffScheduleId(id);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

/**
 * CORE-55: resuelve el scheduleId con prioridad al slot original.
 * scheduleId es opcional en Create Booking para citas, pero su presencia
 * mejora la vinculación con la agenda del staff. Solo se resuelve vía
 * staff API como fallback.
 */
export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const s = sourceSlot && typeof sourceSlot === "object" ? sourceSlot : {};
    const nestedSlot = s.slot && typeof s.slot === "object" ? s.slot : {};
    const resource = s.resource && typeof s.resource === "object" ? s.resource : {};

    // Prioridad 1: slot.scheduleId (nivel superior)
    let scheduleId = _safeTrim(s.scheduleId || nestedSlot.scheduleId);
    // Prioridad 2: resource.scheduleId (anidado en resource)
    if (!scheduleId) scheduleId = _safeTrim(resource.scheduleId);
    // Prioridad 3: schedule.id (si el slot trae el objeto schedule)
    if (!scheduleId && s.schedule && typeof s.schedule === "object") {
        scheduleId = _safeTrim(s.schedule.id);
    }

    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;

    // Fallback: resolver desde el staff API
    return await _resolveScheduleIdByResourceId(resourceIdClean);
}

/* =============================================================================
 * CREATEBOOKING BODY (Writer V2) — CORE-54 / CORE-55 / CORE-56
 * ==========================================================================*/
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

/**
 * CORE-54 / CORE-55 / CORE-56: construye el slot para createBooking
 * preservando la información del slot original de disponibilidad.
 *
 * - location: prioriza slot.location.id (CORE-54), fuerza OWNER_BUSINESS (CORE-56).
 * - scheduleId: prioriza slot.scheduleId (CORE-55), fallback staff API.
 * - resource: { id: resourceId } (resourceId elegido por el cliente o auto-asignado).
 * - startDate / endDate: preservados del slot, convertidos a UTC.
 *
 * Devuelve null si algún dato obligatorio no es válido (fail-closed).
 */
export async function _forceStaffInPristineSlot(
    slot,
    resourceId,
    serviceIdOverride,
    defaultDurationMinutes,
    serviceConfig
) {
    if (!slot || typeof slot !== "object") return null;

    // 1. Extraer el slot crudo de Wix (puede venir anidado en slot.slot)
    const rawSlot = (slot.slot && typeof slot.slot === "object") ? slot.slot : slot;

    // 2. serviceId: override o del slot
    const serviceId = _safeTrim(serviceIdOverride || rawSlot.serviceId || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId });
        return null;
    }

    // 3. resourceId: el cliente selecciona, o se usa el del slot
    const resourceCandidate = rawSlot.resource && typeof rawSlot.resource === "object" ? rawSlot.resource : {};
    const resourceIdClean = _safeTrim(
        resourceId || rawSlot.resourceId || resourceCandidate.id
    );
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceId: resourceIdClean });
        return null;
    }

    // 4. scheduleId (CORE-55): preservar del slot, fallback staff API
    const scheduleId = await _resolveScheduleIdForResource(resourceIdClean, rawSlot);
    if (!scheduleId) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    // 5. startDate / endDate: preservar del slot
    const rawStart = rawSlot.startDate || rawSlot.localStartDate;
    const rawEnd = rawSlot.endDate || rawSlot.localEndDate;
    let startDate = _toDateSafe(rawStart);
    let endDate = _toDateSafe(rawEnd);

    // Fallback de duración si falta endDate
    if (!endDate && startDate) {
        const durationMin = Number(defaultDurationMinutes) ||
            Number(CONCURRENCY && CONCURRENCY.DEFAULT_DURATION_MIN) || 30;
        endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);
    }
    if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) {
        log.error("_forceStaffInPristineSlot: invalid date range", {
            localStartDate: rawStart,
            localEndDate: rawEnd,
        });
        return null;
    }

    // 6. location (CORE-54 / CORE-56): priorizar slot.location.id, forzar OWNER_BUSINESS
    const slotLocation = rawSlot.location && typeof rawSlot.location === "object" ? rawSlot.location : {};
    const location = _resolveWriteLocation(slotLocation, serviceConfig);
    if (!location) {
        return null;
    }

    // 7. Construir slot conforme a Create Booking (Writer V2)
    // Propiedades obligatorias: startDate, endDate, resource, location
    // Propiedad opcional: scheduleId (recomendada para vincular agenda)
    return {
        serviceId,
        scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone: _safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
        resource: { id: resourceIdClean },
        location,
    };
}

/* =============================================================================
 * CHECKOUT URL HELPER
 * ==========================================================================*/
export function _extractCheckoutId(checkoutSession) {
    if (!checkoutSession || typeof checkoutSession !== "object") return null;
    const nested =
        checkoutSession.checkout && typeof checkoutSession.checkout === "object"
            ? checkoutSession.checkout
            : {};
    return _safeTrim(nested._id) || _safeTrim(checkoutSession._id) || null;
}

/* =============================================================================
 * SLOT KEYS
 * ==========================================================================*/
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

/* =============================================================================
 * MUTEX LOCKS
 * ==========================================================================*/
const MUTEX_TTL_MS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}

const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function safeLockId(key) {
    const k = _safeTrim(key);
    if (!k) return "";
    return "lk" + _hashKey(k) + k.slice(0, 24);
}

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
            now.getTime() + (Number.isFinite(ttl) && ttl > 0 ? ttl : MUTEX_TTL_MS)
        ),
        acquiredAt: now,
        heartbeatAt: now,
        payloadJson: JSON.stringify({
            lockOwnerId: String(lockOwnerId || ""),
            lockStatus: "ACTIVE",
        }),
        traceId: _safeTrim(existing && existing.traceId) || makeTraceId("lock"),
    };
    if (existing && existing._revision !== undefined) {
        doc._revision = existing._revision;
    }
    return doc;
}

async function _getLock(slotClave) {
    const id = safeLockId(slotClave);
    if (!id) return null;
    const item = await elevatedGet(LOCKS_COL, id).catch(function () {
        return null;
    });
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    if (lock.lockOwnerId) return _safeTrim(lock.lockOwnerId);
    const payload = _parsePayloadJson(lock.payloadJson);
    return _safeTrim(payload.lockOwnerId) || "";
}

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
        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner && currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs, existing._revision);
            return renewed.ok
                ? {
                    ok: true,
                    renewed: true,
                    revision: renewed.newRevision,
                    lockToken: existing.lockToken,
                }
                : { ok: false, message: ERROR_CODES.LOCK_RENEWAL_FAILED };
        }
        const expiresAt = _toDateSafe(existing && existing.expiresAt);
        const malformed = !expiresAt;
        const expired = malformed || expiresAt.getTime() <= Date.now();
        if (malformed) {
            log.error("CORE-43: Malformed lock found (missing expiresAt)", {
                slotClave: k,
                lockId: existing ? existing._id : null,
            });
        }
        if (expired && existing && existing._id) {
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
                if (_isRevisionConflictError(updateError)) {
                    return { ok: false, message: ERROR_CODES.LOCK_RACE };
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
        return { ok: false, message: ERROR_CODES.LOCK_HELD_BY_ANOTHER_OWNER };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId, expectedRevision) {
    const owner = _safeTrim(lockOwnerId);
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    const currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) {
        return {
            ok: false,
            reason: ERROR_CODES.LOCK_OWNERSHIP_CHANGED,
            skipped: true,
        };
    }
    if (expectedRevision !== undefined && existing._revision !== expectedRevision) {
        return { ok: false, reason: ERROR_CODES.LOCK_CONFLICT };
    }
    try {
        await elevatedRemove(LOCKS_COL, existing._id);
        return { ok: true };
    } catch (error) {
        log.warn("_unlockSlotKey: remove failed", {
            slotClave: slotClave,
            error: error && error.message,
        });
        return {
            ok: false,
            reason: ERROR_CODES.LOCK_RELEASE_FAILED,
            error: error && error.message,
        };
    }
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs, expectedRevision) {
    const owner = _safeTrim(lockOwnerId);
    try {
        const existing = await _getLock(slotClave);
        if (!existing) return { ok: false, reason: "LOCK_NOT_FOUND" };
        if (!owner || _getLockOwnerId(existing) !== owner) {
            return { ok: false, reason: ERROR_CODES.LOCK_OWNERSHIP_CHANGED };
        }
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

/* =============================================================================
 * IDEMPOTENT TRANSACTIONS
 * ==========================================================================*/
const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const TX_DEDUPE_PREFIX = "TX_";
const TX_PAYLOAD_MAX_CHARS = 900;
const TRANSACTION_POLL_BASE_MS =
    Number(CONCURRENCY && CONCURRENCY.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS =
    Number(CONCURRENCY && CONCURRENCY.TRANSACTION_MAX_WAIT_MS) || 3000;
const TRANSACTION_LEASE_MS =
    Number(CONCURRENCY && CONCURRENCY.TRANSACTION_LEASE_MS) || 300000;

async function _getTransactionById(pairToken) {
    const id = _safeTrim(pairToken);
    if (!id) return null;
    return await elevatedGet(TRANSACTIONS_COL, id).catch(function () {
        return null;
    });
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
        leaseExpiresAt: _toDateSafe(
            payload.leaseExpiresAt || doc.leaseExpiresAt
        ),
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
        leaseExpiresAt:
            payload.leaseExpiresAt ||
            (existingDoc && existingDoc.leaseExpiresAt) ||
            null,
        heartbeatAt:
            payload.heartbeatAt ||
            (existingDoc && existingDoc.heartbeatAt) ||
            now,
        attempt: payload.attempt || (existingDoc && existingDoc.attempt) || 1,
        traceId:
            _safeTrim(existingDoc && existingDoc.traceId) ||
            _safeTrim(state.ownerTraceId) ||
            makeTraceId("tx"),
    };
    if (existingDoc && existingDoc._revision !== undefined) {
        doc._revision = existingDoc._revision;
    }
    const bookingId = _safeTrim(payload.bookingId);
    if (bookingId) doc.bookingId = bookingId;
    return doc;
}

async function _writeTransaction(pairToken, state, existingDoc, throwOnError) {
    const doc = _buildTransactionControl(pairToken, state, existingDoc);
    try {
        if (existingDoc && existingDoc._id) {
            await elevatedUpdate(TRANSACTIONS_COL, doc);
        } else {
            await elevatedInsert(TRANSACTIONS_COL, doc);
        }
    } catch (error) {
        const isDup = _isDuplicateItemError(error);
        if (!isDup) {
            log.error("_writeTransaction failed", {
                pairToken: pairToken,
                error: error && error.message,
            });
        }
        if (throwOnError && !isDup) {
            throw error;
        }
    }
}

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
    if (
        current.status === "FAILED" ||
        current.status === "FAILED_RETRYABLE" ||
        current.status === "FAILED_FINAL"
    ) {
        return {
            success: false,
            error: ERROR_CODES.TRANSACTION_PREVIOUSLY_FAILED,
            existing: current,
        };
    }
    return null;
}

export async function _initTransaction(
    pairToken,
    payloadHash,
    traceId,
    ownerExecutionId
) {
    const id = _safeTrim(pairToken);
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };
    const now = new Date();
    const state = {
        status: "IN_PROGRESS",
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
        const remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
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

export async function claimTransaction(
    pairToken,
    newOwnerExecutionId,
    newTraceId
) {
    const id = _safeTrim(pairToken);
    if (!id) return { ok: false, reason: "INVALID_PAIR_TOKEN" };

    const current = await _getTransactionById(id);
    if (!current) return { ok: false, reason: "NOT_FOUND" };

    const tx = _readTransaction(current);

    if (tx.status === "COMPLETED") {
        return { ok: false, reason: "ALREADY_COMPLETED" };
    }

    const leaseExpiresAt = tx.leaseExpiresAt;
    if (leaseExpiresAt && leaseExpiresAt.getTime() > Date.now()) {
        return { ok: false, reason: "LEASE_NOT_EXPIRED" };
    }

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
    if (!id) return { ok: false, error: "INVALID_PAIR_TOKEN" };
    const current = _readTransaction(await _getTransactionById(id));
    if (current && current.status === "COMPLETED") {
        return { ok: true, alreadyCompleted: true };
    }
    try {
        await _writeTransaction(
            id,
            {
                status: "COMPLETED",
                payloadHash: current ? current.payloadHash : "",
                ownerTraceId:
                    _safeTrim(traceId) || (current ? current.ownerTraceId : ""),
                bookingId: _extractBookingIdFromResult(result),
                result: result === undefined ? null : result,
            },
            current ? current.doc : null,
            true
        );
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: (err && err.message) || "COMPLETE_FAILED",
        };
    }
}

export async function _failTransaction(pairToken, errorMessage, retryable) {
    const id = _safeTrim(pairToken);
    if (!id) return;
    const current = _readTransaction(await _getTransactionById(id));
    if (current && current.status === "COMPLETED") return;
    const isRetryable = retryable !== false;
    const finalStatus = isRetryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
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

/* =============================================================================
 * PERSISTENCE CITAS_F2
 * ==========================================================================*/
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

function _minimizeContactDetails(contactDetails) {
    const cd =
        contactDetails && typeof contactDetails === "object" ? contactDetails : {};
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
    if (!bookingId || !serviceId || !resourceId || !p.startDate || !p.endDate) {
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
    const pairToken = _safeTrim(p.pairToken || (p.meta && p.meta.pairToken));
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
    const metaObj = p.meta && typeof p.meta === "object" ? p.meta : {};
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
    const thirdPartyId = _safeTrim(p.thirdPartyId || metaObj.thirdPartyId);
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
    const doc = {
        [BOOKING_FIELDS.BOOKING_ID]: bookingId,
        [BOOKING_FIELDS.PAIR_TOKEN]: pairToken,
        [BOOKING_FIELDS.CATALOG_ID]: catalogId,
        [BOOKING_FIELDS.SERVICE_ID]: serviceId,
        [BOOKING_FIELDS.SCHEDULE_ID]: scheduleIdClean,
        [BOOKING_FIELDS.RESOURCE_ID]: resourceId,
        [BOOKING_FIELDS.STAFF_RESOURCE_ID]: resourceId,
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
        [BOOKING_FIELDS.META]: _normalizeMeta(p.meta, {
            bookingStatus: bookingStatus,
            paymentStatus: paymentStatus,
        }),
        [BOOKING_FIELDS.TRACE_ID]: traceIdClean,
    };
    const existing = await elevatedQueryFind(CITAS_COL, function (q) {
        return q.eq(BOOKING_FIELDS.BOOKING_ID, bookingId).limit(1);
    }).catch(function () {
        return null;
    });
    if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc[BOOKING_FIELDS.REVISION]) || 1;
        const currentRevision = Number(existingDoc[BOOKING_FIELDS.REVISION]) || 1;
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

/* =============================================================================
 * SAFE CITA UPDATE
 * ==========================================================================*/
export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    const bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };
    try {
        const res = await elevatedQueryFind(CITAS_COL, function (q) {
            return q.eq(BOOKING_FIELDS.BOOKING_ID, bid).limit(1);
        });
        const cita = res && Array.isArray(res.items) ? res.items[0] : null;
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
            _toCmsPaymentStatus(updated.paymentStatus) || cita.paymentStatus;
        assertValidEnum(nextBookingStatus, CITAS_BOOKING_STATUS, "bookingStatus");
        assertValidEnum(nextPaymentStatus, CITAS_PAYMENT_STATUS, "paymentStatus");
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

/* =============================================================================
 * RESOURCE IDS FROM SLOT
 * ==========================================================================*/
export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

/* =============================================================================
 * CONTIGUITY / GAP
 * ==========================================================================*/
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;
    const fallbackTolerance = Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_TOLERANCIA);
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
    const rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;
    if (rawDiffMinutes < -1) return false;
    const gap = computeGapMinutes(end1Utc, start2Utc);
    if (gap === null) return false;
    return gap <= maxGap;
}

/* =============================================================================
 * SLOT PROJECTION
 * ==========================================================================*/
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
    const location = _resolveWriteLocation(slotLocation, null);
    if (!location) {
        return null;
    }
    const nestedSlot =
        normalized.slot && typeof normalized.slot === "object"
            ? normalized.slot
            : {};
    return {
        serviceId: serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(normalized.scheduleId || nestedSlot.scheduleId),
        localStartDate: localStartDate,
        localEndDate: localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: normalized.bookable === true,
        availableResources: _extractResourceIdsFromSlot(normalized),
        timezone: _safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
        locationId: location.id,
        locationName: _safeTrim(slotLocation.name),
        formattedAddress: _safeTrim(slotLocation.formattedAddress),
    };
}

export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;
    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;
    const nestedSlot = slot.slot && typeof slot.slot === "object" ? slot.slot : {};
    const scheduleId = _safeTrim(
        projected.scheduleId || slot.scheduleId || nestedSlot.scheduleId
    );
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.warn("_projectWriterSlotFromAvailability: missing or invalid scheduleId", {
            serviceId: finalServiceId,
            scheduleIdRaw: projected.scheduleId || null,
        });
        return null;
    }
    const location = _resolveWriteLocation(
        { id: projected.locationId },
        null
    );
    if (!location) {
        return null;
    }
    return {
        serviceId: finalServiceId,
        scheduleId: scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: { id: projected.resourceId },
        location,
    };
}

/* =============================================================================
 * PAIR TOKEN
 * ==========================================================================*/
export { _buildPairFingerprint, _buildPairTokenDeterministic };

/* =============================================================================
 * RESOURCE RANKING BY LOAD
 * ==========================================================================*/
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
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
            const result = await elevatedQueryFind(CITAS_COL, function (q) {
                return q
                    .eq(BOOKING_FIELDS.DATE_YMD, day)
                    .hasSome(BOOKING_FIELDS.RESOURCE_ID, input)
                    .limit(pageSize)
                    .skip(skip);
            });
            const items = result && Array.isArray(result.items) ? result.items : [];
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                const itemResourceId = _safeTrim(item && item[BOOKING_FIELDS.RESOURCE_ID]);
                if (!loads[itemResourceId]) continue;
                const status = _toCmsBookingStatus(
                    (item && (item[BOOKING_FIELDS.STATUS] || item.status)) || ""
                );
                const payment = _toCmsPaymentStatus(
                    (item && item[BOOKING_FIELDS.PAYMENT_STATUS]) || ""
                );
                const inactive =
                    status === CMS_BOOKING_CANCELLED ||
                    status === CMS_BOOKING_REFUNDED ||
                    status === CITAS_BOOKING_STATUS.NO_SHOW;
                const refunded = payment === CITAS_PAYMENT_STATUS.REFUNDED;
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
        log.warn("_rankResourcesByLoad failed; preserving availability order", {
            traceId: traceId,
            dateYmd: day,
            error: error && error.message,
        });
        return input;
    }
}