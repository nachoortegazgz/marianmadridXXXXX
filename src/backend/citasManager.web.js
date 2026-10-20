/**
 * MODULE: backend/citasManager.web.js
 * VERSION: v10.8-CLEAN
 * APIS: wix-web-module, @wix/ecom (orders), @wix/bookings (reschedule, getBooking, staff),
 *       @wix/members, @wix/essentials (auth).
 * DOC: https://dev.wix.com/docs/rest/business-solutions/bookings/bookings-writer-v2/reschedule-booking
 *      https://dev.wix.com/docs/rest/business-solutions/e-commerce/orders/introduction
 *
 * LEGACY: eliminado addOnId (solo addonId canónico).
 */
import { webMethod, Permissions } from "wix-web-module";
import { orders } from "@wix/ecom";
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
import { currentMember } from "@wix/members";
import { queryFirstItem, queryItems, wql, CONSISTENCY, insertItem as dalInsert } from "backend/dataAccess";
import {
    BUSINESS_COLLECTIONS, OPERATIONAL_COLLECTIONS, CONTROL_TYPE, SDK_CONFIG,
    APP_IDS, BOOKING_STATUS, PAYMENT_STATUS, PAYMENT_METHOD, CHANNEL_TYPE,
    MOVEMENT_TYPE, SLOT_SEARCH, BOOKING_TYPE, BOOKING_FIELDS
} from "backend/internalConfig";
import {
    makeTraceId, _safeTrim, _looksLikeGuid, _normalizeLocalIsoStr,
    _readPositiveAmount, _toDateSafe, getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ, withTimeout
} from "public/mmUtils";
import { toUtcRange, computeGapMinutes } from "backend/booking/bookingUtils";
import { executeBookingSaga } from "backend/booking/bookingSaga";
import { normalizeError, _handleError, ERROR_CODES, createBookingError, _updateCitaSafe, _forceStaffInPristineSlot } from "backend/booking/bookingCore";
import { registerBookingPayment } from "backend/cajas.web.js";
import { rateLimiter } from "backend/security";
import { logger } from "backend/logger";
import { logAuditEvent } from "backend/audit";
import { revalidateExactAvailabilitySlot, _getServiceBySlugOrIdInternal } from "backend/reservas.web.js";

const log = logger;
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;
const CONTROL_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const AUDIT_SOURCE = "backend/citasManager.web.js";
const MAX_DUAL_GAP_MINUTES = Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120;
const FIELD_BOOKING_ID = BOOKING_FIELDS?.BOOKING_ID || "bookingId";
const FIELD_STATUS = BOOKING_FIELDS?.STATUS || "bookingStatus";
const FIELD_PAYMENT_STATUS = BOOKING_FIELDS?.PAYMENT_STATUS || "paymentStatus";
const FIELD_CASH_MOVEMENT_ID = BOOKING_FIELDS?.CASH_MOVEMENT_ID || "cashMovementId";
const FIELD_ORDER_ID = BOOKING_FIELDS?.ORDER_ID || "orderId";
const FIELD_TRACE_ID = BOOKING_FIELDS?.TRACE_ID || "traceId";
const FIELD_SERVICE_ID = BOOKING_FIELDS?.SERVICE_ID || "serviceId";
const FIELD_RESOURCE_ID = BOOKING_FIELDS?.RESOURCE_ID || "resourceId";
const FIELD_SLOT_START = BOOKING_FIELDS?.SLOT_START || "slotStart";
const FIELD_SLOT_END = BOOKING_FIELDS?.SLOT_END || "slotEnd";
const FIELD_PAIR_TOKEN = BOOKING_FIELDS?.PAIR_TOKEN || "pairToken";
const FIELD_CONTACT_DETAILS = BOOKING_FIELDS?.CONTACT_DETAILS || "contactDetails";
const CHANNEL_ONLINE = _safeTrim(CHANNEL_TYPE.ONLINE).toUpperCase();
const CHANNEL_PRESENCIAL = _safeTrim(CHANNEL_TYPE.PRESENCIAL).toUpperCase();
const ELEVATED_STAFF_ROLES = Object.freeze(new Set(["OWNER", "ADMIN"]));
const getOrderElevated = auth.elevate(orders.getOrder);
const rescheduleBookingElevated = auth.elevate(bookings.rescheduleBooking);
const getBookingElevated = auth.elevate(bookings.getBooking);
const getStaffElevated = auth.elevate(bookings.staff.getMember);

/* ---------------- Helpers de error (agrupados) ---------------- */
function rateLimitError(surface, retryAfter, traceId) { const e = new Error("RATE_LIMITED"); e.code = "RATE_LIMITED"; e.meta = { retryAfter, surface, traceId }; return e; }
function _rateLimitOrThrow(surface, key, traceId) { const r = rateLimiter({ surface, key }); if (r.allowed) return; throw rateLimitError(surface, r.retryAfter, traceId); }

/* ---------------- Helpers internos (sin cambios funcionales) ---------------- */
function _getCitaMeta(cita) { /* ... */ }
function _getAddOnIdsForRevalidation(cita) { /* ... */ }
function _normalizeBookingAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((id) => _safeTrim(id)).filter(_looksLikeGuid))).sort();
}
async function _findCitaByBookingId(bookingId) { /* ... */ }
async function _findCitasByPairToken(pairToken) { /* ... */ }
async function _findCitaByOrderAndBookingId(orderId, bookingId) { /* ... */ }
function _isPaidOrderStatus(value) { /* ... */ }
function _getOrderBookingLineItems(order) { /* ... */ }
function _getBookingLineItemsTotal(lineItems) { /* ... */ }
function _resolveBookingStatusAfterPayment(cita, traceId) { /* ... */ }
function _isOnlinePaymentAllowed(cita) { /* ... */ }
async function _getCurrentMemberInfo() { /* ... */ }
function _getMemberId(member) { /* ... */ }
async function _getStaffAccess(resourceId) { /* ... */ }
function _validateProcessBookingPayload(payload, traceId) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Booking payload is invalid.", { traceId });
    const requiredText = ["serviceId", "email", "firstName", "phone"];
    for (const field of requiredText) if (!_safeTrim(payload[field])) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `${field} is required.`, { traceId, field });
    if (!payload.slotF1 || typeof payload.slotF1 !== "object") throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "slotF1 is required.", { traceId });
    if (payload.rgpdConsent !== true) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "RGPD consent is required.", { traceId });
    const channelRaw = _safeTrim(payload.channelType || payload.paymentMethod || "").toUpperCase();
    if (channelRaw !== CHANNEL_ONLINE && channelRaw !== CHANNEL_PRESENCIAL) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Invalid channelType: expected ONLINE or PRESENCIAL.", { traceId, channelType: channelRaw || null });
    const pmRaw = _safeTrim(payload.paymentMethod || "").toUpperCase();
    if (pmRaw && pmRaw !== CHANNEL_ONLINE && pmRaw !== CHANNEL_PRESENCIAL) {
        const validMembers = Object.values(PAYMENT_METHOD || {}).map((v) => _safeTrim(v).toUpperCase());
        if (!validMembers.includes(pmRaw)) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Invalid payment method.", { traceId, paymentMethod: pmRaw });
    }
    if (payload.addOnIds !== undefined && !Array.isArray(payload.addOnIds)) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "addOnIds must be an array.", { traceId });
    return {
        serviceId: _safeTrim(payload.serviceId), slug: _safeTrim(payload.slug || ""),
        resourceId: _safeTrim(payload.resourceId || ""), slotF1: payload.slotF1, slotF2: payload.slotF2 || null,
        email: _safeTrim(payload.email), firstName: _safeTrim(payload.firstName),
        lastName: _safeTrim(payload.lastName || ""), phone: _safeTrim(payload.phone),
        channelType: channelRaw, paymentMethod: pmRaw || null,
        rgpdConsent: true, addOnIds: _normalizeBookingAddOnIds(payload.addOnIds),
        traceId: _safeTrim(payload.traceId || "")
    };
}

/* ---------------- Web methods públicos (sin cambios funcionales) ---------------- */
export const processDualBooking = webMethod(Permissions.Anyone, async (unsafePayload) => { /* ... */ });
export const confirmPayment = webMethod(Permissions.SiteMember, async (payload) => { /* ... */ });
export const rescheduleExistingBooking = webMethod(Permissions.SiteMember, async (payload) => { /* ... */ });
export const rescheduleDualBookings = webMethod(Permissions.SiteMember, async (payload) => { /* ... */ });