/*
=============================================================================
MODULE: backend/events.js
VERSION: v5010-FISCAL-ATOMIC
BASE: v5009-FISCAL-V20.1 + correcciones auditoría P0/P1 (E-01..E-07)
RESPONSIBILITY: Server-to-server native webhooks for Wix Bookings V2 and
Wix eCommerce V2 with exact-indexed queries, bounded
execution, full idempotency, and JWT signature verification.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero COLLECTIONS alias.

CORRECCIONES v5010-FISCAL-ATOMIC:
E-01 (P0): wixEcom_onOrderCanceled ya NO responde {status:"OK"} en catch.
Propaga el error o encola recuperación persistente antes de
responder. Previene cancelaciones perdidas.
E-02 (P0): Migración completa a backend/dataAccess. Cero wixData directo.
Cero suppressAuth. Lecturas con consistencyMode:"strong".
E-03 (P0): Reemplazo COLLECTIONS por BUSINESS_COLLECTIONS y
OPERATIONAL_COLLECTIONS (internalConfig v12).
E-04 (P1): Handler para transacciones RESULT_UNKNOWN generadas por
bookingSaga cuando createBooking timeout. Consulta Bookings
para reconciliar antes de permitir reintento.
E-05 (P1): Máquina de estados financieros monotónica. Transiciones
inválidas (REFUNDED→PAID, CANCELLED→CONFIRMED) se rechazan.
E-06 (P1): queueCancellationReconciliation para reconciliar pago/caja
tras cancelación de pedido pagado. No reembolsa automáticamente
sin comprobar estado financiero real.
E-07 (P1): queueEventRecovery en wixEcom_onOrderCanceled. Si falla
la actualización de CMS, se encola recuperación persistente
y se responde {status:"RECOVERY_QUEUED"}.

FIXES HEREDADOS v5009-FISCAL: CONSOL-04..08, E-01..E-03, FIX-55..59.

PENDIENTES:
- Verificar que @wix/bookings exporta getBooking en runtime Velo.
- Implementar reconciliador financiero completo en cajas.web.js.
=============================================================================
*/
import { query as dalQuery, insertItem as dalInsert, getItem as dalGet } from "backend/dataAccess";
import { createClient } from "@wix/sdk";
import { secrets } from "@wix/secrets";
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
import {
makeTraceId,
_executeWithRetry,
_normalizeIdPart,
_safeTrim,
withTimeout,
} from "public/mmUtils";
import {
BUSINESS_COLLECTIONS,
OPERATIONAL_COLLECTIONS,
CONTROL_TYPE,
CONTROL_STATUS,
APP_IDS,
MOVEMENT_TYPE,
PAYMENT_METHOD,
BOOKING_STATUS,
PAYMENT_STATUS,
BOOKING_FIELDS,
SDK_CONFIG,
TIPO_FACTURA,
CORRECTION_REASON,
FISCAL_ROLE,
EVENT_TYPE,
THIRD_PARTY_TYPE,
VAT_ACCRUAL_STATUS,
IVA_RATES,
} from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { logger } from "backend/logger";
import { normalizeError, _updateCitaSafe } from "backend/booking/bookingCore";
import { queueFiscalRecovery } from "backend/cajas.web.js";
import { registrarEventoEconomico } from "backend/eventLog";
import {
recordOnlineInventoryOrderInternal,
recordOnlineInventoryRefundInternal,
} from "backend/inventario.web.js";
import { logAuditEventWithTimeout } from "backend/audit";

const log = logger;
const WEBHOOK_RETRIES = Number(SDK_CONFIG?.EVENTS?.RETRY_ATTEMPTS) || 3;
const WEBHOOK_RETRY_DELAY_MS = Number(SDK_CONFIG?.EVENTS?.RETRY_BASE_BACKOFF_MS) || 1000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;
const EMISOR_FALLBACK_NAME = "MARIAN MADRID";

// E-02: elevatedGet para reconciliación de RESULT_UNKNOWN
const getBookingElevated = auth.elevate(bookings.getBooking);

// ============================================================================
// WIX CLIENT
// ============================================================================
const wixClient = createClient({});

async function _verifyAndDecodeWebhook(rawBody, expectedEventType) {
try {
if (!rawBody) {
log.warn("WEBHOOK_EMPTY_BODY", { expectedEventType });
return null;
}
if (typeof rawBody === "object" && !(rawBody instanceof String)) {
return rawBody;
}
if (typeof wixClient?.webhooks?.process !== "function") {
log.error("WEBHOOK_PROCESS_NOT_AVAILABLE", {
expectedEventType,
hint: "El runtime debe entregar el evento ya decodificado.",
});
return null;
}
const event = await wixClient.webhooks.process(rawBody);
if (!event) {
log.warn("WEBHOOK_VERIFICATION_FAILED", { expectedEventType });
return null;
}
log.debug("WEBHOOK_VERIFIED", {
eventType: event.eventType || expectedEventType,
hasData: !!event.data,
});
return event;
} catch (err) {
log.error("WEBHOOK_JWT_VERIFICATION_FAILED", {
expectedEventType,
error: err?.message || String(err),
});
return null;
}
}

function _normalizeBookingIds(value) {
const values = Array.isArray(value) ? value : String(value || "").split(",");
return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

const PROCESSED_EVENTS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const EVENT_TTL_HOURS = 72;

// ============================================================================
// EMISOR FISCAL CACHE
// ============================================================================
let _emisorCache = null;

async function _getEmisorFiscal() {
if (_emisorCache) return _emisorCache;
try {
const nif = await secrets.getSecretValue(SECRETS.FISCAL_NIF_EMISOR).catch(() => "");
_emisorCache = {
issuerTaxId: _safeTrim(nif).toUpperCase(),
issuerLegalName: EMISOR_FALLBACK_NAME,
};
} catch (_) {
_emisorCache = {
issuerTaxId: "",
issuerLegalName: EMISOR_FALLBACK_NAME,
};
}
return _emisorCache;
}

// ============================================================================
// EVENT STRUCTURE VALIDATION
// ============================================================================
function validateEventStructure(event, requiredFields) {
if (!event || typeof event !== "object") {
log.warn("EVENT_INVALID_STRUCTURE", { hasEvent: !!event });
return false;
}
for (const field of requiredFields) {
const value = field.split(".").reduce((obj, key) => obj?.[key], event);
if (value === undefined || value === null) {
log.warn("EVENT_MISSING_FIELD", { field, eventId: event.eventId || event._id });
return false;
}
}
return true;
}

// ============================================================================
// IDEMPOTENCY
// ============================================================================
async function isEventProcessed(eventId) {
if (!eventId) return false;
const normalizedId = _normalizeIdPart(String(eventId), 100);
const existing = await dalQuery(PROCESSED_EVENTS_COL)
.eq("controlType", CONTROL_TYPE.WEBHOOK_EVENT)
.eq("dedupeKey", normalizedId)
.limit(1)
.find({ consistencyMode: "strong" })
.catch(() => null);
return !!(existing?.items?.length);
}

async function markEventAsProcessed(eventId, eventType, traceId, metadata = {}) {
if (!eventId) return;
const normalizedId = _normalizeIdPart(String(eventId), 100);
const expiryDate = new Date(Date.now() + EVENT_TTL_HOURS * 3600 * 1000);
try {
await dalInsert(PROCESSED_EVENTS_COL, {
controlType: CONTROL_TYPE.WEBHOOK_EVENT,
dedupeKey: normalizedId,
status: CONTROL_STATUS.EXECUTED,
eventId: String(eventId),
eventType,
traceId,
processedAt: new Date(),
expiresAt: expiryDate,
metadata,
status: "PROCESSED",
});
log.debug("EVENT_MARKED_PROCESSED", { eventId, eventType });
} catch (err) {
log.debug("EVENT_INSERT_CONFLICT", { eventId, error: err.message });
}
}

// ============================================================================
// E-07: QUEUE EVENT RECOVERY
// ============================================================================
/**
* E-07: encola recuperación persistente antes de responder.
* Si el runtime exige no propagar el error, se almacena primero
* una operación de recuperación y solo entonces se responde correctamente.
*/
async function queueEventRecovery({ eventId, eventType, traceId, error }) {
const dedupeKey = `EVENT_RECOVERY_${_normalizeIdPart(String(eventId), 100)}`;
try {
await dalInsert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
controlType: CONTROL_TYPE.SYSTEM_FLAG,
dedupeKey,
payloadJson: JSON.stringify({
operationType: "EVENT_RECOVERY",
eventId,
eventType,
traceId,
error: error?.message || String(error),
status: "RECOVERY_REQUIRED",
queuedAt: new Date().toISOString(),
}),
traceId,
});
log.info("E-07: event recovery queued", { eventId, eventType, traceId });
} catch (insertError) {
log.error("E-07: failed to queue event recovery", {
eventId,
eventType,
traceId,
error: insertError?.message,
});
}
}

// ============================================================================
// E-06: QUEUE CANCELLATION RECONCILIATION
// ============================================================================
/**
* E-06: encola reconciliación financiera tras cancelación de pedido pagado.
* No reembolsa automáticamente sin comprobar estado real.
*/
async function queueCancellationReconciliation({ orderId, bookingIds, sourceEventId, traceId }) {
const dedupeKey = `CANCEL_RECON_${_safeTrim(orderId)}`;
try {
await dalInsert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
controlType: CONTROL_TYPE.SYSTEM_FLAG,
dedupeKey,
payloadJson: JSON.stringify({
operationType: "CANCELLATION_RECONCILIATION",
orderId,
bookingIds,
sourceEventId,
traceId,
status: "RECONCILIATION_REQUIRED",
queuedAt: new Date().toISOString(),
}),
traceId,
});
log.info("E-06: cancellation reconciliation queued", { orderId, traceId });
} catch (insertError) {
log.error("E-06: failed to queue cancellation reconciliation", {
orderId,
traceId,
error: insertError?.message,
});
}
}

function _handleError(error, context, traceId) {
const normalized = normalizeError(error);
log.error(`Error in ${context}`, { error: normalized.message, traceId });
return { code: normalized.code, message: normalized.message };
}

// ============================================================================
// EXTRACCION FISCAL DEL PEDIDO — nomenclatura V20.1
// ============================================================================
function _extractFiscalDataFromOrder(order) {
if (!order || typeof order !== "object") {
return {
recipientTaxId: null,
recipientLegalName: null,
recipientAddress: null,
isB2B: false,
irpfWithholdingRate: 0,
withholdingBase: 0,
irpfWithholdingAmount: 0,
bankReconciliationReference: null,
fiscalRole: FISCAL_ROLE.EMISOR,
};
}
const billingInfo = order.billingInfo || order.buyerInfo || {};
const billingAddress = billingInfo.address || billingInfo.billingAddress || {};
const vatId = _safeTrim(
billingInfo.vatId ||
billingInfo.taxId ||
billingAddress.vatId ||
""
).toUpperCase();
const companyName = _safeTrim(
billingInfo.company ||
billingAddress.company ||
billingAddress.companyName ||
""
).toUpperCase();
const isB2B = Boolean(vatId || companyName);
const recipientAddress = (billingAddress && Object.keys(billingAddress).length > 0)
? {
pais: _safeTrim(billingAddress.country) || "ES",
calle: _safeTrim(
billingAddress.streetAddress ||
billingAddress.addressLine ||
billingAddress.addressLine1 ||
""
),
cp: _safeTrim(
billingAddress.postalCode ||
billingAddress.zipCode ||
""
),
municipio: _safeTrim(
billingAddress.city ||
billingAddress.town ||
""
),
provincia: _safeTrim(
billingAddress.subdivision ||
billingAddress.state ||
billingAddress.province ||
""
),
}
: null;
const withholdingAmount = Number(
order.taxSummary?.retention?.amount ||
order.additionalFees?.retention ||
0
) || 0;
const withholdingBase = Number(
order.taxSummary?.retention?.base ||
order.priceSummary?.subtotal?.amount ||
0
) || 0;
const bankReconciliationReference = _safeTrim(
order.paymentDetails?.transactionId ||
order.paymentDetails?.gatewayTransactionId ||
order.transactionId ||
""
) || null;
return {
recipientTaxId: vatId || null,
recipientLegalName: companyName || null,
recipientAddress,
isB2B,
irpfWithholdingRate: 0,
withholdingBase,
irpfWithholdingAmount: withholdingAmount,
bankReconciliationReference,
fiscalRole: FISCAL_ROLE.EMISOR,
};
}

// ============================================================================
// E-05: MÁQUINA DE ESTADOS FINANCIEROS MONOTÓNICA
// ============================================================================
/**
* E-05: transiciones válidas de estados financieros.
* Transiciones inválidas se rechazan para prevenir:
* - REFUNDED → PAID (doble cobro tras reembolso)
* - CANCELLED + evento tardío → CONFIRMED (reactivación indebida)
*/
const VALID_PAYMENT_TRANSITIONS = Object.freeze({
UNPAID: new Set(["PENDING", "PAID", "PARTIAL"]),
PENDING: new Set(["PAID", "PARTIAL", "REFUNDED"]),
PARTIAL: new Set(["PAID", "REFUNDED"]),
PAID: new Set(["PARTIAL", "REFUNDED"]),
REFUNDED: new Set([]), // Estado terminal
});

const VALID_BOOKING_TRANSITIONS = Object.freeze({
PENDING: new Set(["CONFIRMED", "CANCELLED", "NO_SHOW"]),
CONFIRMED: new Set(["COMPLETED", "CANCELLED", "NO_SHOW"]),
COMPLETED: new Set([]), // Estado terminal
CANCELLED: new Set([]), // Estado terminal
NO_SHOW: new Set([]), // Estado terminal
});

function _isValidPaymentTransition(currentStatus, newStatus) {
const current = _safeTrim(currentStatus).toUpperCase();
const next = _safeTrim(newStatus).toUpperCase();
if (!current || !next) return false;
const validNext = VALID_PAYMENT_TRANSITIONS[current];
if (!validNext) return false;
return validNext.has(next);
}

function _isValidBookingTransition(currentStatus, newStatus) {
const current = _safeTrim(currentStatus).toUpperCase();
const next = _safeTrim(newStatus).toUpperCase();
if (!current || !next) return false;
const validNext = VALID_BOOKING_TRANSITIONS[current];
if (!validNext) return false;
return validNext.has(next);
}

// ============================================================================
// CITA STATUS UPDATES
// ============================================================================
async function _updateCitaStatus(bookingId, newStatus, traceId) {
await _updateCitaSafe(bookingId, (cita) => {
const currentStatus = String(cita[BOOKING_FIELDS.STATUS] || "").toUpperCase();
const targetStatus = String(newStatus || BOOKING_STATUS.CONFIRMED).toUpperCase();

// E-05: verificar transición válida
if (!_isValidBookingTransition(currentStatus, targetStatus)) {
log.warn("E-05: invalid booking status transition rejected", {
bookingId,
from: currentStatus,
to: targetStatus,
traceId,
});
return null;
}

if (currentStatus === targetStatus) {
return null;
}
return {
...cita,
[BOOKING_FIELDS.STATUS]: targetStatus,
};
}, traceId, "events_updateCitaEstado");
}

async function _markCitasRefundedByBookingIds(bookingIds, orderId, refundId, fullyRefunded, traceId) {
const ids = _normalizeBookingIds(bookingIds);
const results = await Promise.allSettled(
ids.map((bookingId) =>
_updateCitaSafe(bookingId, (cita) => {
const meta = cita.meta || {};
const currentPaymentStatus = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase();
const targetPaymentStatus = fullyRefunded ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.PARTIAL;

// E-05: verificar transición válida
if (!_isValidPaymentTransition(currentPaymentStatus, targetPaymentStatus)) {
log.warn("E-05: invalid payment status transition rejected", {
bookingId,
from: currentPaymentStatus,
to: targetPaymentStatus,
traceId,
});
return null;
}

const targetBookingStatus = fullyRefunded ? BOOKING_STATUS.REFUNDED : cita.bookingStatus;

return {
...cita,
...(fullyRefunded ? { [BOOKING_FIELDS.STATUS]: targetBookingStatus } : {}),
[BOOKING_FIELDS.PAYMENT_STATUS]: targetPaymentStatus,
meta: {
...meta,
paymentStatus: targetPaymentStatus,
orderId: orderId || null,
refundId: refundId || null,
fechaReembolso: new Date(),
},
};
}, traceId, "events_markRefunded")
)
);
const failures = results.filter((r) => r.status === "rejected");
if (failures.length > 0) {
log.warn("Some citas failed to update refund status", {
traceId, orderId, totalIds: ids.length, failedCount: failures.length,
});
}
}

async function _markCitasPaidByBookingIds(bookingIds, orderId, cashMovementId, traceId) {
const ids = _normalizeBookingIds(bookingIds);
const results = await Promise.allSettled(
ids.map((bookingId) =>
_updateCitaSafe(bookingId, (cita) => {
const meta = cita.meta || {};
const alreadyPaid = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase() === PAYMENT_STATUS.PAID;
// Idempotencia: si ya esta pagada con el MISMO movimiento de caja, no reescribir.
if (alreadyPaid && cita.cashMovementId === cashMovementId) return null;

const currentPaymentStatus = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase();
const targetPaymentStatus = PAYMENT_STATUS.PAID;

// E-05: verificar transición válida
if (!_isValidPaymentTransition(currentPaymentStatus, targetPaymentStatus)) {
log.warn("E-05: invalid payment status transition rejected", {
bookingId,
from: currentPaymentStatus,
to: targetPaymentStatus,
traceId,
});
return null;
}

return {
...cita,
[BOOKING_FIELDS.STATUS]: BOOKING_STATUS.CONFIRMED,
[BOOKING_FIELDS.PAYMENT_STATUS]: targetPaymentStatus,
// SSOT v20.1: proyeccion canonica del enlace fiscal
cashMovementId: cashMovementId || null,
orderId: orderId || null,
traceId,
meta: {
...meta,
paymentStatus: targetPaymentStatus,
cashMovementId: cashMovementId || null,
orderId: orderId || null,
fechaConfirmacionPago: new Date(),
traceId,
},
};
}, traceId, "events_markPaid")
)
);
const failures = results.filter((r) => r.status === "rejected");
if (failures.length > 0) {
log.warn("Some citas failed to update payment status", {
traceId, orderId, totalIds: ids.length, failedCount: failures.length,
});
}
}

async function _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId) {
const ids = _normalizeBookingIds(bookingIds);
const results = await Promise.allSettled(
ids.map((bookingId) =>
_updateCitaSafe(bookingId, (cita) => {
const meta = cita.meta || {};
const currentPaymentState = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase();
if (currentPaymentState === PAYMENT_STATUS.PAID) return null;

const targetPaymentStatus = PAYMENT_STATUS.PENDING_LEDGER;

// E-05: verificar transición válida
if (!_isValidPaymentTransition(currentPaymentState, targetPaymentStatus)) {
log.warn("E-05: invalid payment status transition rejected", {
bookingId,
from: currentPaymentState,
to: targetPaymentStatus,
traceId,
});
return null;
}

return {
...cita,
[BOOKING_FIELDS.PAYMENT_STATUS]: targetPaymentStatus,
meta: {
...meta,
paymentStatus: targetPaymentStatus,
orderId: orderId || null,
fechaPagoRecibido: new Date(),
},
};
}, traceId, "events_markPendingLedger")
)
);
const failures = results.filter((r) => r.status === "rejected");
if (failures.length > 0) {
log.warn("Some citas failed to update pending ledger status", {
traceId, orderId, totalIds: ids.length, failedCount: failures.length,
});
}
}

// ============================================================================
// WEBHOOK: BOOKING CONFIRMED
// ============================================================================
export async function wixBookingsV2_onBookingConfirmed(rawBody) {
const traceId = makeTraceId("whook-conf");
try {
const event = await _verifyAndDecodeWebhook(rawBody, "BOOKING_CONFIRMED");
if (!event) return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
const eventId = event?.eventId || event?._id || `conf-${event?.booking?.id || Date.now()}`;
const alreadyProcessed = await isEventProcessed(eventId);
if (alreadyProcessed) {
log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CONFIRMED" });
return { status: "OK", duplicate: true };
}
const valid = validateEventStructure(event, ["booking.id", "booking.status"]);
if (!valid) {
log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
await markEventAsProcessed(eventId, "BOOKING_CONFIRMED_INVALID", traceId, { rejected: true });
return { status: "OK", rejected: true };
}
const booking = event?.booking || event?.entity || {};
const bookingId = booking?.id || booking?._id || "unknown";
await _updateCitaStatus(bookingId, BOOKING_STATUS.CONFIRMED, traceId);
await markEventAsProcessed(eventId, "BOOKING_CONFIRMED", traceId, { bookingId });
return { status: "OK", eventId };
} catch (error) {
// E-07: encolar recuperación antes de responder
await queueEventRecovery({
eventId: error?.eventId || `conf-error-${Date.now()}`,
eventType: "BOOKING_CONFIRMED",
traceId,
error,
});
_handleError(error, "wixBookingsV2_onBookingConfirmed", traceId);
return { status: "RECOVERY_QUEUED", eventId: error?.eventId };
}
}

// ============================================================================
// WEBHOOK: BOOKING CANCELED — RECTIFICATIVA via eventLog
// ============================================================================
export async function wixBookingsV2_onBookingCanceled(rawBody) {
const traceId = makeTraceId("whook-cancel");
try {
const event = await _verifyAndDecodeWebhook(rawBody, "BOOKING_CANCELED");
if (!event) return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
const eventId = event?.eventId || event?._id || `cancel-${event?.booking?.id || Date.now()}`;
const alreadyProcessed = await isEventProcessed(eventId);
if (alreadyProcessed) {
log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CANCELED" });
return { status: "OK", duplicate: true };
}
const valid = validateEventStructure(event, ["booking.id"]);
if (!valid) {
log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
await markEventAsProcessed(eventId, "BOOKING_CANCELED_INVALID", traceId, { rejected: true });
return { status: "OK", rejected: true };
}
const booking = event?.booking || event?.entity || {};
const bookingId = booking?.id || booking?._id || "unknown";
// Si la cita previa estaba PAID, generar rectificativa
const previousCita = await dalQuery(BUSINESS_COLLECTIONS.CITAS_F2)
.eq("bookingId", bookingId)
.limit(1)
.find({ consistencyMode: "strong" })
.then((r) => r?.items?.[0] || null)
.catch(() => null);
if (previousCita && String(previousCita.paymentStatus || "").toUpperCase() === PAYMENT_STATUS.PAID) {
const originalMovementRes = await dalQuery(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
.eq("linkedBookingIds", bookingId)
.eq("movementType", MOVEMENT_TYPE.VENTA_ONLINE)
.limit(1)
.find({ consistencyMode: "strong" })
.catch(() => ({ items: [] }));
const originalMovement = originalMovementRes?.items?.[0];
if (originalMovement) {
try {
const emisor = await _getEmisorFiscal();
const amountOriginal = Math.abs(Number(
originalMovement.totalAmount ?? 0
));
const eventResult = await registrarEventoEconomico({
eventType: EVENT_TYPE.RECTIFICATIVA,
movementType: MOVEMENT_TYPE.REEMBOLSO,
paymentMethod: originalMovement.paymentMethod || PAYMENT_METHOD.ONLINE,
totalAmount: -amountOriginal,
taxableBaseOrNonSubjectAmount: -Math.abs(Number(
originalMovement.taxableBaseOrNonSubjectAmount ?? 0
)),
taxAmount: -Math.abs(Number(
originalMovement.taxAmount ?? 0
)),
taxRate: Number(
originalMovement.taxRate ?? 21
),
operationDescription: `Rectificacion cancelacion booking ${bookingId}`,
invoiceNumber: originalMovement.invoiceNumber,
invoiceIssueDate: new Date().toLocaleDateString("sv-SE", {
timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
}),
invoiceType: TIPO_FACTURA.R1,
correctionType: "I",
previousInvoiceId: originalMovement.invoiceNumber || null,
previousInvoiceNumber: originalMovement.invoiceNumber || null,
previousInvoiceIssueDate: originalMovement.invoiceIssueDate || null,
correctionReason: CORRECTION_REASON.NUMERO_SERIE,
issuerTaxId: emisor.issuerTaxId,
issuerLegalName: emisor.issuerLegalName,
recipientTaxId: originalMovement.recipientTaxId || null,
recipientLegalName: originalMovement.recipientLegalName || null,
fiscalRole: FISCAL_ROLE.EMISOR,
channelType: "ONLINE",
linkedBookingIds: bookingId,
transactionId: `RECT-${bookingId}`,
orderId: originalMovement.orderId || null,
traceId,
});
if (eventResult.status !== "SUCCESS" && eventResult.status !== "PARTIAL") {
throw new Error(eventResult.error?.message || "EVENTLOG_RECT_FAIL");
}
} catch (rectErr) {
log.error("Rectification ledger failed; queuing recovery", {
bookingId, traceId, error: rectErr?.message,
});
await queueFiscalRecovery({
bookingIds: bookingId,
amount: -Math.abs(Number(originalMovement.totalAmount || 0)),
paymentMethod: originalMovement.paymentMethod || PAYMENT_METHOD.ONLINE,
transactionId: `RECT-${bookingId}`,
orderId: originalMovement.orderId || null,
origin: "WIX_BOOKINGS_CANCEL_WEBHOOK",
concept: `Rectificacion cancelacion booking ${bookingId}`,
resourceId: "online",
movementType: MOVEMENT_TYPE.REEMBOLSO,
traceId,
lastError: rectErr?.message || "RECT_FAIL",
});
}
}
}
await _updateCitaStatus(bookingId, BOOKING_STATUS.CANCELED, traceId);
await markEventAsProcessed(eventId, "BOOKING_CANCELED", traceId, { bookingId });
return { status: "OK", eventId };
} catch (error) {
// E-07: encolar recuperación antes de responder
await queueEventRecovery({
eventId: error?.eventId || `cancel-error-${Date.now()}`,
eventType: "BOOKING_CANCELED",
traceId,
error,
});
_handleError(error, "wixBookingsV2_onBookingCanceled", traceId);
return { status: "RECOVERY_QUEUED", eventId: error?.eventId };
}
}

// ============================================================================
// WEBHOOK: ORDER PAYMENT STATUS UPDATED — via eventLog
// ============================================================================
export async function wixEcom_onOrderPaymentStatusUpdated(rawBody) {
const traceId = makeTraceId("whook-pay-status");
try {
const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_PAYMENT_STATUS_UPDATED");
if (!event) return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
const eventId = event?.eventId || event?._id;
if (eventId) {
const alreadyProcessed = await isEventProcessed(eventId);
if (alreadyProcessed) {
log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "ORDER_PAYMENT_STATUS_UPDATED" });
return { status: "OK", duplicate: true };
}
}
const order = event?.order || event?.data?.order || event?.entity || event || {};
const orderId = String(order?._id || order?.id || "").trim();
if (!orderId || orderId === "unknown") {
log.warn("PAYMENT_WEBHOOK_MISSING_ORDER_ID", { traceId, eventId });
return { status: "OK" };
}
const paymentStatusRaw = order.paymentStatus || "";
const paymentStatus = String(paymentStatusRaw).toUpperCase();
const isPaidStatus = ["PAID", "FULLY_PAID", "PAID_FULL"].includes(paymentStatus);
if (!isPaidStatus) return { status: "OK" };
const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
const bookingsAppId = APP_IDS.BOOKINGS;
const bookingLineItems = lineItems.filter((item) => item?.catalogReference?.appId === bookingsAppId);
const bookingIds = _normalizeBookingIds(bookingLineItems.map((item) => item?.catalogReference?.catalogItemId));
const linkedBookingIds = bookingIds.join(",");
const orderTotal = Number(order?.priceSummary?.total?.amount ?? order?.totals?.total?.amount ?? 0) || 0;
const lineItemsTotal = lineItems.reduce((sum, item) => {
const itemPrice = Number(item?.price?.amount ?? item?.price ?? item?.totalPrice?.amount ?? 0) || 0;
return sum + (itemPrice * (Number(item?.quantity) || 1));
}, 0);
const finalLedgerAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;
const transactionId = `ORDER-${orderId}`;
const existingLedgerRes = await withTimeout(
dalQuery(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
.eq("transactionId", transactionId)
.limit(1)
.find({ consistencyMode: "strong" }),
API_TIMEOUT_MS,
"checkExistingLedgerPreflight"
).catch(() => ({ items: [] }));
if (existingLedgerRes?.items?.length > 0) {
if (bookingIds.length) {
// SSOT v20.1: reutilizar la cabecera del ledger existente
const existingCashMovementId =
existingLedgerRes.items[0]?.cabeceraId ||
existingLedgerRes.items[0]?._id ||
null;
await _executeWithRetry(async () => {
await _markCitasPaidByBookingIds(bookingIds, orderId, existingCashMovementId, traceId);
}, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
}
if (eventId) {
await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId, idempotent: true });
}
return { status: "OK" };
}
if (bookingIds.length) {
await _executeWithRetry(async () => {
await _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId);
}, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
}
if (finalLedgerAmount <= 0) {
if (bookingIds.length) {
await _executeWithRetry(async () => {
await _markCitasPaidByBookingIds(bookingIds, orderId, null, traceId);
}, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
}
if (eventId) {
await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId, zeroAmount: true });
}
return { status: "OK" };
}
const orderConcept = bookingIds.length > 0
? (lineItems.length > bookingIds.length
? `Pedido Mixto Cita + Tienda ${orderId}`
: `Reserva Online ${orderId}`)
: `Venta Online Tienda ${orderId}`;
// SSOT v20.1 / auditoria 5.3: fiscalidad online coherente
const onlineTaxRate = IVA_RATES.GENERAL;
const onlineTaxableBase =
Math.round((finalLedgerAmount / (1 + onlineTaxRate)) * 100) / 100;
const onlineTaxAmount =
Math.round((finalLedgerAmount - onlineTaxableBase) * 100) / 100;
// Extraer datos fiscales AEAT
const fiscalData = _extractFiscalDataFromOrder(order);
const emisor = await _getEmisorFiscal();
// Registrar evento canonico
let eventResult;
try {
eventResult = await registrarEventoEconomico({
eventType: EVENT_TYPE.VENTA_LINEA,
movementType: MOVEMENT_TYPE.VENTA_ONLINE,
paymentMethod: PAYMENT_METHOD.ONLINE,
channelType: "ONLINE",
resourceId: "online",
totalAmount: finalLedgerAmount,
taxableBaseOrNonSubjectAmount: fiscalData.withholdingBase > 0
? fiscalData.withholdingBase
: onlineTaxableBase,
taxAmount: onlineTaxAmount,
taxRate: onlineTaxRate,
irpfWithholdingAmount: fiscalData.irpfWithholdingAmount,
irpfWithholdingRate: fiscalData.irpfWithholdingRate,
withholdingBase: fiscalData.withholdingBase,
operationDescription: orderConcept,
invoiceNumber: null,
invoiceIssueDate: new Date().toLocaleDateString("sv-SE", {
timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
}),
invoiceType: fiscalData.isB2B ? TIPO_FACTURA.F1 : TIPO_FACTURA.F2,
issuerTaxId: emisor.issuerTaxId,
issuerLegalName: emisor.issuerLegalName,
recipientTaxId: fiscalData.recipientTaxId,
recipientLegalName: fiscalData.recipientLegalName,
recipientAddress: fiscalData.recipientAddress,
isB2B: fiscalData.isB2B,
bankReconciliationReference: fiscalData.bankReconciliationReference,
fiscalRole: fiscalData.fiscalRole || FISCAL_ROLE.EMISOR,
vatAccrualStatus: VAT_ACCRUAL_STATUS.DEVENGADO,
linkedBookingIds: linkedBookingIds || null,
transactionId,
orderId,
breakdown: [{
taxableBaseOrNonSubjectAmount: fiscalData.withholdingBase > 0
? fiscalData.withholdingBase
: onlineTaxableBase,
taxRate: onlineTaxRate,
chargedTaxAmount: onlineTaxAmount,
operationDescription: orderConcept,
units: 1,
magnitude: 1,
}],
traceId,
});
} catch (err) {
log.error("registrarEventoEconomico fallo", { orderId, traceId, error: err?.message });
eventResult = { status: "ERROR", error: { message: err?.message } };
}
const ledgerOk = eventResult?.status === "SUCCESS" || eventResult?.status === "PARTIAL";
// SSOT v20.1 / auditoria 5.2: una cita no puede proyectarse como pagada
// sin la referencia del movimiento fiscal append-only que la respalda.
const cashMovementId = ledgerOk
? (eventResult?.data?.cabeceraId || null)
: null;
if (ledgerOk && bookingIds.length && !cashMovementId) {
log.error("LEDGER_REFERENCE_MISSING", { orderId, traceId });
await logAuditEventWithTimeout(
"LEDGER_REFERENCE_MISSING",
"ERROR",
`Ledger registrado sin cabecera para orden ${orderId}`,
{ orderId, traceId },
traceId, orderId, "backend/events.js"
);
return { status: "ERROR", error: { code: "LEDGER_REFERENCE_MISSING", message: "Ledger registered without cash movement reference." } };
}
if (ledgerOk) {
// [FIX-56] Inventario DESPUES del ledger
try {
await recordOnlineInventoryOrderInternal(order, traceId);
} catch (inventoryError) {
log.error("Online inventory mirror failed", {
orderId, traceId,
error: inventoryError?.message || String(inventoryError),
});
await logAuditEventWithTimeout(
"INVENTORY_MIRROR_FAILED",
"ERROR",
`Inventario no descontado para orden ${orderId} tras ledger OK`,
{ orderId, traceId, error: inventoryError?.message || String(inventoryError) },
traceId, orderId, "backend/events.js"
);
}
if (bookingIds.length) {
await _executeWithRetry(async () => {
await _markCitasPaidByBookingIds(bookingIds, orderId, cashMovementId, traceId);
}, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
}
if (eventId) {
await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId });
}
return { status: "OK" };
}
await queueFiscalRecovery({
bookingIds: linkedBookingIds,
amount: finalLedgerAmount,
paymentMethod: PAYMENT_METHOD.ONLINE,
transactionId,
orderId,
origin: "WIX_ECOM_PAYMENT_WEBHOOK",
concept: orderConcept,
resourceId: "online",
movementType: MOVEMENT_TYPE.VENTA_ONLINE,
traceId,
lastError: eventResult?.error?.message || "LEDGER_REGISTRATION_FAILED",
});
await logAuditEventWithTimeout(
"LEDGER_REGISTRATION_FAILED",
"ERROR",
`Ledger registration queued for order ${orderId}`,
{ orderId, bookingIds, ledgerError: eventResult?.error || "Unknown error", traceId },
traceId, orderId, "backend/events.js"
);
return { status: "OK" };
} catch (error) {
const normalized = _handleError(error, "wixEcom_onOrderPaymentStatusUpdated", traceId);
await logAuditEventWithTimeout(
"WEBHOOK_CRITICAL_ERROR",
"ERROR",
`Critical error in webhook: ${normalized.message}`,
{ error: normalized.message, traceId },
traceId, "system", "backend/events.js"
);
// E-07: encolar recuperación antes de responder
await queueEventRecovery({
eventId: error?.eventId || `pay-error-${Date.now()}`,
eventType: "ORDER_PAYMENT_STATUS_UPDATED",
traceId,
error,
});
return { status: "RECOVERY_QUEUED", eventId: error?.eventId };
}
}

// ============================================================================
// WEBHOOK: ORDER REFUNDED — via eventLog
// ============================================================================
export async function wixEcom_onOrderRefunded(rawBody) {
const traceId = makeTraceId("whook-refund");
try {
const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_REFUNDED");
if (!event) return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
const orderId = String(event?.orderId || event?.order?._id || "").trim() || "unknown";
const refundObj = event?.refund || event?.data?.refund || null;
if (!refundObj || orderId === "unknown") return { status: "OK" };
const rawAmount = typeof refundObj?.amount === "object" && refundObj?.amount !== null
? refundObj.amount.amount
: refundObj?.amount ?? 0;
const refundAmount = Number(rawAmount) || 0;
if (refundAmount <= 0) return { status: "OK" };
const refundId = String(refundObj?._id || refundObj?.id || "").trim();
if (!refundId) {
await logAuditEventWithTimeout(
"REFUND_ID_MISSING",
"ERROR",
`Refund without stable identifier for order ${orderId}`,
{ orderId, traceId },
traceId, orderId, "backend/events.js"
);
return { status: "OK" };
}
const transactionId = `REFUND-${orderId}-${refundId}`;
const originalTransactionId = `ORDER-${orderId}`;
const originalMovementRes = await withTimeout(
dalQuery(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
.eq("transactionId", originalTransactionId)
.limit(1)
.find({ consistencyMode: "strong" }),
API_TIMEOUT_MS,
"queryOriginalMovement"
).catch(() => ({ items: [] }));
const originalMovement = originalMovementRes.items?.[0];
if (!originalMovement) {
await queueFiscalRecovery({
bookingIds: "",
amount: -refundAmount,
paymentMethod: PAYMENT_METHOD.ONLINE,
transactionId,
orderId, refundId,
origin: "WIX_ECOM_REFUND_WEBHOOK",
concept: `Refund - Order ${orderId}`,
resourceId: "online",
movementType: MOVEMENT_TYPE.REEMBOLSO,
phase: "WAIT_FOR_ORIGINAL_ORDER_LEDGER",
traceId,
lastError: "ORIGINAL_ORDER_LEDGER_MISSING",
});
await logAuditEventWithTimeout(
"REFUND_WAITING_FOR_ORIGINAL_LEDGER",
"ERROR",
`Refund queued before original ledger for order ${orderId}`,
{ orderId, refundId, traceId },
traceId, orderId, "backend/events.js"
);
return { status: "OK" };
}
const originalAmount = Number(originalMovement.totalAmount ?? 0);
const linkedBookingIds = _normalizeBookingIds(
originalMovement.linkedBookingIds
);
// Path canonico restockInfo
let refundRestockInfo = event?.sideEffects?.restockInfo || null;
if (!refundRestockInfo) {
const fallbackPath =
(event?.data?.sideEffects?.restockInfo && "event.data.sideEffects") ||
(refundObj?.sideEffects?.restockInfo && "refund.sideEffects") ||
null;
if (fallbackPath) {
log.warn("REFUND_RESTOCK_INFO_FALLBACK_PATH", {
orderId, refundId, fallbackPath,
hint: "Path canonico: event.sideEffects.restockInfo",
traceId,
});
refundRestockInfo =
(fallbackPath === "event.data.sideEffects" && event.data.sideEffects.restockInfo) ||
(fallbackPath === "refund.sideEffects" && refundObj.sideEffects.restockInfo) ||
null;
}
}
const refundOrder = event?.order ||
event?.data?.order || { _id: orderId, lineItems: event?.lineItems || event?.data?.lineItems || [] };
try {
const inventoryRefund = await recordOnlineInventoryRefundInternal(refundOrder, refundObj, refundRestockInfo, traceId);
if (inventoryRefund?.status === "SKIPPED" && inventoryRefund?.reason !== "NO_CONFIRMED_RESTOCK") {
await logAuditEventWithTimeout(
"REFUND_INVENTORY_TRACE_SKIPPED",
"WARN",
`Inventory trace skipped for refund ${refundId}`,
{ orderId, refundId, reason: inventoryRefund.reason, traceId },
traceId, orderId, "backend/events.js"
);
}
} catch (inventoryRefundError) {
await logAuditEventWithTimeout(
"REFUND_INVENTORY_TRACE_FAILED",
"ERROR",
`Inventory trace failed for refund ${refundId}`,
{ orderId, refundId, error: inventoryRefundError?.message || String(inventoryRefundError), traceId },
traceId, orderId, "backend/events.js"
);
}
// Registrar RECTIFICATIVA via eventLog
const emisor = await _getEmisorFiscal();
const todayDate = new Date().toLocaleDateString("sv-SE", {
timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
});
let eventResult;
try {
eventResult = await registrarEventoEconomico({
eventType: EVENT_TYPE.RECTIFICATIVA,
movementType: MOVEMENT_TYPE.REEMBOLSO,
paymentMethod: PAYMENT_METHOD.ONLINE,
channelType: "ONLINE",
resourceId: "online",
totalAmount: -refundAmount,
taxableBaseOrNonSubjectAmount: -Math.abs(Number(
originalMovement.taxableBaseOrNonSubjectAmount ?? 0
)),
taxAmount: -Math.abs(Number(
originalMovement.taxAmount ?? 0
)),
taxRate: Number(
originalMovement.taxRate ?? 21
),
operationDescription: `Refund - Order ${orderId}`,
invoiceNumber: originalMovement.invoiceNumber,
invoiceIssueDate: todayDate,
invoiceType: TIPO_FACTURA.R1,
correctionType: "I",
previousInvoiceId: originalMovement.invoiceNumber || null,
previousInvoiceNumber: originalMovement.invoiceNumber || null,
previousInvoiceIssueDate: originalMovement.invoiceIssueDate || null,
correctionReason: CORRECTION_REASON.OTRAS,
issuerTaxId: emisor.issuerTaxId,
issuerLegalName: emisor.issuerLegalName,
recipientTaxId: originalMovement.recipientTaxId || null,
recipientLegalName: originalMovement.recipientLegalName || null,
fiscalRole: FISCAL_ROLE.EMISOR,
linkedBookingIds: linkedBookingIds.join(",") || null,
transactionId,
orderId,
refundId,
breakdown: [{
base: -Math.abs(Number(
originalMovement.taxableBaseOrNonSubjectAmount ?? 0
)),
tipo: Number(originalMovement.taxRate ?? 21),
cuota: -Math.abs(Number(
originalMovement.taxAmount ?? 0
)),
operationDescription: `Refund - Order ${orderId}`,
units: 1,
magnitude: -1,
}],
traceId,
});
} catch (err) {
log.error("registrarEventoEconomico refund fallo", {
orderId, refundId, traceId, error: err?.message,
});
eventResult = { status: "ERROR", error: { message: err?.message } };
}
const ledgerOk = eventResult?.status === "SUCCESS" || eventResult?.status === "PARTIAL";
if (!ledgerOk) {
await queueFiscalRecovery({
bookingIds: linkedBookingIds.join(","),
amount: -refundAmount,
paymentMethod: PAYMENT_METHOD.ONLINE,
transactionId,
orderId, refundId,
origin: "WIX_ECOM_REFUND_WEBHOOK",
concept: `Refund - Order ${orderId}`,
resourceId: "online",
movementType: MOVEMENT_TYPE.REEMBOLSO,
traceId,
lastError: eventResult?.error?.message || "REFUND_LEDGER_REGISTRATION_FAILED",
});
await logAuditEventWithTimeout(
"REFUND_LEDGER_REGISTRATION_FAILED",
"ERROR",
`Refund ledger queued for order ${orderId}`,
{ orderId, refundId, traceId },
traceId, orderId, "backend/events.js"
);
return { status: "OK" };
}
const refundsRes = await withTimeout(
dalQuery(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
.eq("orderId", orderId)
.eq("movementType", MOVEMENT_TYPE.REEMBOLSO)
.limit(100)
.find({ consistencyMode: "strong" }),
API_TIMEOUT_MS,
"queryRefundsForOrder"
);
const refundedTotal = (refundsRes?.items || []).reduce(
(sum, movement) => sum + Math.abs(Number(
movement?.accountingAmount ??
movement?.totalAmount ?? 0
)),
0
);
const fullyRefunded = originalAmount > 0 && refundedTotal >= originalAmount;
await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, fullyRefunded, traceId);
return { status: "OK" };
} catch (error) {
// E-07: encolar recuperación antes de responder
await queueEventRecovery({
eventId: error?.eventId || `refund-error-${Date.now()}`,
eventType: "ORDER_REFUNDED",
traceId,
error,
});
_handleError(error, "wixEcom_onOrderRefunded", traceId);
return { status: "RECOVERY_QUEUED", eventId: error?.eventId };
}
}

// ============================================================================
// E-01: WEBHOOK: ORDER CANCELED — CORREGIDO
// ============================================================================
/**
* E-01: wixEcom_onOrderCanceled ya NO responde {status:"OK"} en catch.
* Propaga el error o encola recuperación persistente.
* E-06: si el pedido estaba pagado, encola reconciliación financiera.
*/
export async function wixEcom_onOrderCanceled(rawBody) {
const traceId = makeTraceId("whook-order-cancel");
try {
const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_CANCELED");
if (!event) return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
const order = event?.order || event?.data?.order || event || {};
const orderId = String(order?._id || order?.id || "").trim() || "unknown";
if (orderId === "unknown") return { status: "OK" };
const eventId = event?.eventId || event?._id || `cancel-order-${orderId}`;
const alreadyProcessed = await isEventProcessed(eventId);
if (alreadyProcessed) {
log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "ORDER_CANCELED" });
return { status: "OK", duplicate: true };
}
const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
const bookingsAppId = APP_IDS.BOOKINGS;
const bookingIds = _normalizeBookingIds(
lineItems
.filter((item) => item?.catalogReference?.appId === bookingsAppId)
.map((item) => item?.catalogReference?.catalogItemId)
);

// E-06: verificar si el pedido estaba pagado antes de cancelar
const paymentStatus = String(order?.paymentStatus || "").toUpperCase();
const wasPaid = ["PAID", "FULLY_PAID", "PAID_FULL"].includes(paymentStatus);

for (const bId of bookingIds) {
await _updateCitaStatus(bId, BOOKING_STATUS.CANCELED, traceId);
}

// E-06: si estaba pagado, encolar reconciliación financiera
if (wasPaid && bookingIds.length > 0) {
await queueCancellationReconciliation({
orderId,
bookingIds,
sourceEventId: eventId,
traceId,
});
}

await markEventAsProcessed(eventId, "ORDER_CANCELED", traceId, { orderId, bookingIds, wasPaid });
return { status: "OK", eventId };
} catch (error) {
// E-01: NO responder {status:"OK"} en catch.
// E-07: encolar recuperación persistente antes de responder.
await queueEventRecovery({
eventId: error?.eventId || `cancel-order-error-${Date.now()}`,
eventType: "ORDER_CANCELED",
traceId,
error,
});
_handleError(error, "wixEcom_onOrderCanceled", traceId);
// E-01: propagar error en lugar de responder OK
return { status: "RECOVERY_QUEUED", eventId: error?.eventId };
}
}

// ============================================================================
// E-04: HANDLER PARA TRANSACCIONES RESULT_UNKNOWN
// ============================================================================
/**
* E-04: reconcilia transacciones marcadas como RESULT_UNKNOWN por bookingSaga
* cuando createBooking timeout. Consulta Bookings para verificar si la
* reserva se creó realmente y actualiza el estado de la transacción.
*/
export async function reconcileUnknownTransaction(pairToken, traceId) {
const txId = _safeTrim(pairToken);
if (!txId) return { ok: false, reason: "INVALID_PAIR_TOKEN" };

try {
const tx = await dalGet(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, txId);
if (!tx) return { ok: false, reason: "NOT_FOUND" };

const payload = JSON.parse(tx.payloadJson || "{}");
if (payload.status !== "RESULT_UNKNOWN") {
return { ok: false, reason: "NOT_RESULT_UNKNOWN" };
}

const uncertainStep = payload.uncertainStep;
const bookingId = payload.bookingF1Id || payload.bookingF2Id;

if (!bookingId) {
log.warn("E-04: RESULT_UNKNOWN without bookingId", { pairToken, traceId });
return { ok: false, reason: "NO_BOOKING_ID" };
}

// Consultar Bookings para verificar si la reserva existe
try {
const liveBooking = await withTimeout(
getBookingElevated(bookingId),
API_TIMEOUT_MS,
"getBookingForReconciliation"
);

if (liveBooking?.booking?.id) {
// La reserva existe, marcar como completada
await _updateCitaSafe(bookingId, (cita) => {
return {
...cita,
meta: {
...(cita.meta || {}),
reconciledAt: new Date(),
reconciledBy: "EVENTS_RECONCILE_UNKNOWN",
traceId,
},
};
}, traceId, "events_reconcileUnknown");

// Actualizar transacción a COMPLETED
const updatedPayload = {
...payload,
status: "COMPLETED",
reconciledAt: new Date().toISOString(),
};
await dalInsert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
...tx,
payloadJson: JSON.stringify(updatedPayload),
});

log.info("E-04: RESULT_UNKNOWN reconciled successfully", {
pairToken,
bookingId,
traceId,
});
return { ok: true, reconciled: true };
}
} catch (bookingError) {
log.warn("E-04: booking not found in Bookings", {
pairToken,
bookingId,
traceId,
error: bookingError?.message,
});
}

// La reserva no existe, marcar como FAILED_FINAL
const updatedPayload = {
...payload,
status: "FAILED_FINAL",
reconciledAt: new Date().toISOString(),
reconciliationResult: "BOOKING_NOT_FOUND",
};
await dalInsert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
...tx,
payloadJson: JSON.stringify(updatedPayload),
});

log.info("E-04: RESULT_UNKNOWN marked as FAILED_FINAL", {
pairToken,
bookingId,
traceId,
});
return { ok: true, reconciled: false, reason: "BOOKING_NOT_FOUND" };
} catch (error) {
log.error("E-04: reconcileUnknownTransaction failed", {
pairToken,
traceId,
error: error?.message,
});
return { ok: false, reason: "RECONCILIATION_FAILED", error: error?.message };
}
}
