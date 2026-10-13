/*
=============================================================================
MODULE: backend/citasManager.web.js
VERSION: v10.3-FINAL
BASE: v10.2-HARDENED + correcciones del informe (idempotencia coherente,
      ownership previo, slotRef verificado, validacion estricta de payload,
      FIELD_PAYMENT_METHOD, transiciones cerradas, subset de bookings,
      ledger-cms consistency, currentMember robusto).
RESPONSIBILITY: Booking processing, payment confirmation and rescheduling.
STANDARDS: G10 ASCII Strict. Sin console.log directo (logger SSOT).

FIXES APLICADOS v10.3-FINAL:
  F-01: _validatePaymentCitaSet ya no rechaza PAID con misma order (idempotencia
        coherente). Se anade early-return si todas las citas ya estan PAID para
        la misma orden, sin re-registrar ledger.
  F-02: confirmPayment consulta citas y verifica ownership ANTES de validar
        la orden de pago.
  F-03: _assertBookingOwner lee contactDetails via FIELD_CONTACT_DETAILS.
  F-04: _getCurrentMemberId comprueba member ausente/status ERROR.
  F-05: _slotReferenceMatches verifica que la revalidacion devuelve el mismo
        slot que el input (fechas y referencia).
  F-06: effectiveMaxGap acotado por serviceConfig.maxDualGapMinutes cuando
        existe.
  F-07: _validateProcessBookingPayload valida campos obligatorios de la
        reserva antes del Saga.
  F-08: _normalizeBookingAddOnIds normaliza addOnIds; se rechazan formatos
        no-array.
  F-09: FIELD_PAYMENT_METHOD resuelto y usado en _isOnlinePaymentAllowed.
  F-10: _setCitasPaymentState envuelto en try/catch con auditoria
        PAYMENT_STATE_UPDATE_FAILED (consistencia ledger <-> CMS).
  F-11: _resolveBookingStatusAfterPayment solo acepta transiciones desde
        PENDING / PENDING_PAYMENT / CONFIRMED (ALLOWED_PAYMENT_CONFIRMATION_STATES).
  F-12: _getValidatedPaidOrder comprueba inclusion (requested subset of order)
        en lugar de igualdad estricta de conjuntos.

FIXES HEREDADOS v10.2-HARDENED:
  H-01..H-15 (ownership, idempotencia, BOOKING_FIELDS en escrituras, gap
  minimo, validacion de serviceId, response publica, paymentMethod, sin
  fallback silencioso).

FIXES HEREDADOS v10.1-ALIGNED:
  CM-01..CM-05 (lectura slotStart/slotEnd, addOnIds canonico, COLLECTIONS,
  _getCitaMeta tolerante, _setCitasPaymentState delegando en _updateCitaSafe).

DEPENDENCIAS: backend/dataAccess.js, backend/booking/bookingSaga.js,
  backend/booking/bookingCore.js, backend/cajas.web.js, backend/reservas.web.js,
  backend/security.js, backend/audit.js, backend/logger.js.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import { orders } from "@wix/ecom";
import { auth } from "@wix/essentials";
import { currentMember } from "wix-members-backend";

import {
    queryFirstItem,
    queryItems,
    wql,
    CONSISTENCY,
} from "backend/dataAccess";

import {
    COLLECTIONS,
    SDK_CONFIG,
    APP_IDS,
    BOOKING_STATUS,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    SLOT_SEARCH,
    BOOKING_TYPE,
    BOOKING_FIELDS,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    _readPositiveAmount,
    getUtcDateFromMadridLocal,
    withTimeout,
} from "public/mmUtils";

import { toUtcRange, computeGapMinutes } from "backend/booking/bookingUtils";

import { executeBookingSaga } from "backend/booking/bookingSaga";

import {
    normalizeError,
    _handleError,
    ERROR_CODES,
    createBookingError,
    _updateCitaSafe,
} from "backend/booking/bookingCore";

import { registerBookingPayment } from "backend/cajas.web.js";
import { rateLimiter } from "backend/security";
import { logger } from "backend/logger";
import { logAuditEvent } from "backend/audit";
import {
    revalidateExactAvailabilitySlot,
    _getServiceBySlugOrIdInternal,
} from "backend/reservas.web.js";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const CITAS_COL = COLLECTIONS.CITAS_F2;

const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const AUDIT_SOURCE = "backend/citasManager.web.js";

/* F-06 (H-09 heredado): sin fallback silencioso. */
const configuredDualGap = Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL);
if (!Number.isFinite(configuredDualGap) || configuredDualGap < 0) {
    throw new Error(
        "[citasManager.web] Invalid SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL configuration"
    );
}
const MAX_DUAL_GAP_MINUTES = configuredDualGap;

/* F-03/F-09: nombres de campo resueltos una sola vez. */
const FIELD_BOOKING_ID = BOOKING_FIELDS?.BOOKING_ID || "bookingId";
const FIELD_STATUS = BOOKING_FIELDS?.STATUS || "bookingStatus";
const FIELD_PAYMENT_STATUS =
    BOOKING_FIELDS?.PAYMENT_STATUS || "paymentStatus";
const FIELD_CASH_MOVEMENT_ID =
    BOOKING_FIELDS?.CASH_MOVEMENT_ID || "cashMovementId";
const FIELD_ORDER_ID = BOOKING_FIELDS?.ORDER_ID || "orderId";
const FIELD_TRACE_ID = BOOKING_FIELDS?.TRACE_ID || "traceId";
const FIELD_SERVICE_ID = BOOKING_FIELDS?.SERVICE_ID || "serviceId";
const FIELD_RESOURCE_ID = BOOKING_FIELDS?.RESOURCE_ID || "resourceId";
const FIELD_SLOT_START = BOOKING_FIELDS?.SLOT_START || "slotStart";
const FIELD_SLOT_END = BOOKING_FIELDS?.SLOT_END || "slotEnd";
const FIELD_PAIR_TOKEN = BOOKING_FIELDS?.PAIR_TOKEN || "pairToken";
const FIELD_PAYMENT_METHOD =
    BOOKING_FIELDS?.PAYMENT_METHOD || "paymentMethod";
const FIELD_CONTACT_DETAILS =
    BOOKING_FIELDS?.CONTACT_DETAILS || "contactDetails";

/* F-11: estados que bloquean confirmacion de pago. */
const BLOCKED_PAYMENT_STATES = Object.freeze(
    new Set(["CANCELED", "CANCELLED", "REFUNDED"])
);

/* F-11: transiciones permitidas hacia CONFIRMED. */
const ALLOWED_PAYMENT_CONFIRMATION_STATES = Object.freeze(
    new Set(
        [
            "PENDING",
            "PENDING_PAYMENT",
            "CONFIRMED",
        ].map((s) => s.toUpperCase())
    )
);

const getOrderElevated = auth.elevate(orders.getOrder);

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _getCitaMeta(cita) {
    if (!cita) return {};

    const meta = cita.meta;

    if (typeof meta === "string") {
        try {
            const parsed = JSON.parse(meta);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
                parsed :
                {};
        } catch (_) {
            return {};
        }
    }

    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        return {};
    }

    return meta;
}

function _getAddOnIdsForRevalidation(cita) {
    const meta = _getCitaMeta(cita);

    const source = Array.isArray(meta.addOnIds) ?
        meta.addOnIds :
        Array.isArray(meta.nativeAddonIds) ?
        meta.nativeAddonIds :
        [];

    return Array.from(
        new Set(
            source
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
}

/* F-08: normaliza addOnIds del payload. */
function _normalizeBookingAddOnIds(value) {
    if (!Array.isArray(value)) return [];

    return Array.from(
        new Set(
            value
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
}

async function _findCitaByBookingId(bookingId) {
    const normalizedId = _safeTrim(bookingId);
    if (!normalizedId) return null;

    return queryFirstItem({
        dataCollectionId: CITAS_COL,
        filter: wql.eq(FIELD_BOOKING_ID, normalizedId),
        consistency: CONSISTENCY.STRONG,
    });
}

async function _findCitasByPairToken(pairToken) {
    const normalizedToken = _safeTrim(pairToken);
    if (!normalizedToken) return [];

    const result = await queryItems({
        dataCollectionId: CITAS_COL,
        filter: wql.eq(FIELD_PAIR_TOKEN, normalizedToken),
        limit: 10,
        offset: 0,
        consistency: CONSISTENCY.STRONG,
    });

    return Array.isArray(result?.items) ? result.items : [];
}

/* H-12: busca cita por bookingId verificando que pertenezca a la orden. */
async function _findCitaByOrderAndBookingId(orderId, bookingId) {
    const cita = await _findCitaByBookingId(bookingId);
    if (!cita) return null;

    const meta = _getCitaMeta(cita);
    const storedOrderId = _safeTrim(
        cita?.[FIELD_ORDER_ID] || meta.orderId || ""
    );

    if (storedOrderId && storedOrderId !== _safeTrim(orderId)) {
        return null;
    }

    return cita;
}

function _rateLimitOrThrow(surface, key, traceId) {
    const result = rateLimiter({ surface, key });

    if (result.allowed) return;

    const error = new Error("RATE_LIMITED");
    error.code = "RATE_LIMITED";
    error.meta = {
        retryAfter: result.retryAfter,
        surface,
        traceId,
    };

    throw error;
}

function _isPaidOrderStatus(value) {
    const status = String(value || "").trim().toUpperCase();

    return ["PAID", "FULLY_PAID", "PAID_FULL"].includes(status);
}

function _getOrderBookingLineItems(order) {
    const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
    const bookingsAppId = APP_IDS.BOOKINGS;

    return lineItems.filter(
        (item) => item?.catalogReference?.appId === bookingsAppId
    );
}

function _getBookingLineItemsTotal(lineItems) {
    return (lineItems || []).reduce((sum, item) => {
        const amount =
            Number(item?.price?.amount ?? item?.price ?? 0) || 0;
        const quantity = Number(item?.quantity) || 1;

        return sum + amount * quantity;
    }, 0);
}

/**
 * F-11: transicion de bookingStatus al confirmar el pago.
 * Bloquea estados terminales y estados desconocidos.
 */
function _resolveBookingStatusAfterPayment(cita, traceId) {
    const current = _safeTrim(
        cita?.[FIELD_STATUS] ||
        cita?.bookingStatus ||
        ""
    ).toUpperCase();

    if (BLOCKED_PAYMENT_STATES.has(current)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking cannot be paid in its current state.",
            { traceId, bookingStatus: current }
        );
    }

    if (current && !ALLOWED_PAYMENT_CONFIRMATION_STATES.has(current)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking has an invalid payment transition.",
            { traceId, bookingStatus: current }
        );
    }

    return BOOKING_STATUS.CONFIRMED;
}

/**
 * F-09: paymentMethod leido a traves de FIELD_PAYMENT_METHOD.
 */
function _isOnlinePaymentAllowed(cita) {
    const meta = _getCitaMeta(cita);

    const paymentMethod = _safeTrim(
        cita?.[FIELD_PAYMENT_METHOD] ||
        meta.paymentMethod ||
        ""
    ).toUpperCase();

    return paymentMethod === PAYMENT_METHOD.ONLINE;
}

/**
 * F-04: comprueba resultado de Wix Members.
 */
async function _getCurrentMemberId() {
    try {
        const member = await currentMember.getMember();

        if (!member || member.status === "ERROR") {
            return "";
        }

        return _safeTrim(
            member._id ||
            member.id ||
            member.memberId ||
            ""
        );
    } catch (_) {
        return "";
    }
}

/**
 * F-07: valida el payload de processDualBooking antes del Saga.
 */
function _validateProcessBookingPayload(payload, traceId) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking payload is invalid.",
            { traceId }
        );
    }

    const requiredText = ["serviceId", "email", "firstName", "phone"];
    for (const field of requiredText) {
        if (!_safeTrim(payload[field])) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                `${field} is required.`,
                { traceId, field }
            );
        }
    }

    if (!payload.slotF1 || typeof payload.slotF1 !== "object") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "slotF1 is required.",
            { traceId }
        );
    }

    if (payload.rgpdConsent !== true) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "RGPD consent is required.",
            { traceId }
        );
    }

    if (
        payload.paymentMethod !== PAYMENT_METHOD.ONLINE &&
        payload.paymentMethod !== PAYMENT_METHOD.PRESENCIAL
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Invalid payment method.",
            { traceId, paymentMethod: payload.paymentMethod || null }
        );
    }

    if (
        payload.addOnIds !== undefined &&
        !Array.isArray(payload.addOnIds)
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "addOnIds must be an array.",
            { traceId }
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 3 - PUBLIC WEB METHODS
// =============================================================================

export const processDualBooking = webMethod(
    Permissions.Anyone,
    async (unsafePayload) => {
        const traceId = unsafePayload?.traceId || makeTraceId("dual-bkg");

        try {
            _validateProcessBookingPayload(unsafePayload, traceId);

            _rateLimitOrThrow(
                "citasManager.processDualBooking",
                _safeTrim(unsafePayload?.email) || "anon",
                traceId
            );

            const normalizedPayload = {
                ...unsafePayload,
                addOnIds: _normalizeBookingAddOnIds(unsafePayload.addOnIds),
                traceId,
            };

            return await executeBookingSaga(normalizedPayload);
        } catch (error) {
            return _handleError(error, "processDualBooking", traceId);
        }
    }
);

/**
 * confirmPayment v10.3:
 *  - Orden de operaciones: lookup -> ownership -> validacion orden ->
 *    idempotencia -> ledger -> CMS.
 *  - Idempotente: si todas las citas ya estan PAID para esta orden,
 *    devuelve SUCCESS sin re-registrar ledger.
 *  - Auditoria si ledger OK pero CMS falla.
 */
export const confirmPayment = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("confirm-pay");

        try {
            _rateLimitOrThrow(
                "citasManager.confirmPayment",
                _safeTrim(payload?.orderId) || "anon",
                traceId
            );

            const orderId = _safeTrim(payload?.orderId);

            const bookingIds = Array.isArray(payload?.bookingIds) ?
                Array.from(
                    new Set(
                        payload.bookingIds
                        .map((id) => _safeTrim(id))
                        .filter((id) => _looksLikeGuid(id))
                    )
                ) :
                [];

            const requestedAmount = _readPositiveAmount(payload?.amount);

            if (!orderId || bookingIds.length === 0) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "INVALID_PAYLOAD",
                        message: "orderId and valid bookingIds are required.",
                    },
                };
            }

            /* F-02: lookup + ownership ANTES de consultar la orden. */
            const citas = [];

            for (const bookingId of bookingIds) {
                const cita = await _findCitaByOrderAndBookingId(
                    orderId,
                    bookingId
                );

                if (!cita) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "CITA_NOT_FOUND",
                            message: "Booking record was not found.",
                        },
                    };
                }

                await _assertBookingOwner(cita, traceId);
                citas.push(cita);
            }

            /* Validaciones de negocio (incluye coherencia de pago previo). */
            await _validatePaymentCitaSet(citas, orderId, traceId);
            await _validatePaymentIdempotency(citas, orderId, traceId);

            for (const cita of citas) {
                if (!_isOnlinePaymentAllowed(cita)) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_PAYLOAD,
                        "This booking is not configured for online payment.",
                        { traceId }
                    );
                }
            }

            /* F-01: si TODAS las citas ya estan PAID con la misma orden,
               respuesta idempotente sin tocar ledger ni CMS. */
            const alreadyPaid = citas.every((cita) => {
                const meta = _getCitaMeta(cita);
                return (
                    String(
                        cita?.[FIELD_PAYMENT_STATUS] ||
                        meta.paymentStatus ||
                        ""
                    ).toUpperCase() === PAYMENT_STATUS.PAID &&
                    _safeTrim(
                        cita?.[FIELD_ORDER_ID] ||
                        meta.orderId ||
                        ""
                    ) === orderId
                );
            });

            if (alreadyPaid) {
                return {
                    status: "SUCCESS",
                    data: {
                        paymentStatus: PAYMENT_STATUS.PAID,
                        confirmed: true,
                        amount: requestedAmount || 0,
                        idempotent: true,
                    },
                    error: null,
                };
            }

            /* F-02: la orden se valida despues del ownership. */
            const { finalAmount } = await _getValidatedPaidOrder(
                orderId,
                bookingIds,
                requestedAmount,
                traceId
            );

            const linkedBookingIds = bookingIds.join(",");

            const ledgerResult = await registerBookingPayment(
                linkedBookingIds,
                finalAmount,
                PAYMENT_METHOD.ONLINE, {
                    concept: "Online booking payment",
                    resourceId: "online",
                    traceId,
                    transactionId: `ORDER-${orderId}`,
                    orderId,
                    origen: "WIX_ECOM_PAYMENT_CONFIRM",
                    movementType: "VENTA_ONLINE",
                }
            );

            if (ledgerResult?.status !== "SUCCESS") {
                await logAuditEvent(
                    "PAYMENT_LEDGER_FAILED",
                    "ERROR",
                    "Payment ledger registration failed.", {
                        orderId,
                        traceId,
                        error: ledgerResult?.error?.message || null,
                    },
                    traceId,
                    orderId,
                    AUDIT_SOURCE
                );

                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "LEDGER_FAIL",
                        message: ledgerResult?.error?.message ||
                            "Payment registration failed.",
                    },
                };
            }

            const cashMovementId =
                ledgerResult?.data?.cabeceraId ||
                ledgerResult?.data?._id ||
                null;

            if (!cashMovementId) {
                await logAuditEvent(
                    "PAYMENT_LEDGER_FAILED",
                    "ERROR",
                    "Ledger registered without cash movement reference.", {
                        orderId,
                        traceId,
                        error: "LEDGER_REFERENCE_MISSING",
                    },
                    traceId,
                    orderId,
                    AUDIT_SOURCE
                );

                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "LEDGER_REFERENCE_MISSING",
                        message: "Payment could not be confirmed: ledger reference missing.",
                    },
                };
            }

            /* F-10: auditoria si ledger OK pero update CMS falla. */
            try {
                await _setCitasPaymentState(
                    citas,
                    PAYMENT_STATUS.PAID,
                    orderId,
                    cashMovementId,
                    traceId
                );
            } catch (stateError) {
                await logAuditEvent(
                    "PAYMENT_STATE_UPDATE_FAILED",
                    "ERROR",
                    "Ledger payment exists but booking state update failed.", {
                        orderId,
                        cashMovementId,
                        traceId,
                        error: stateError?.message || String(stateError),
                    },
                    traceId,
                    orderId,
                    AUDIT_SOURCE
                );

                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "PAYMENT_STATE_UPDATE_FAILED",
                        message:
                            "Payment was registered but booking could not be updated. Reconciliation required.",
                    },
                };
            }

            await logAuditEvent(
                "PAYMENT_CONFIRMED",
                "INFO",
                "Booking payment confirmed.", {
                    orderId,
                    bookingIds,
                    amount: finalAmount,
                    traceId,
                },
                traceId,
                orderId,
                AUDIT_SOURCE
            );

            return {
                status: "SUCCESS",
                data: {
                    paymentStatus: PAYMENT_STATUS.PAID,
                    confirmed: true,
                    amount: finalAmount,
                },
                error: null,
            };
        } catch (error) {
            const normalized = normalizeError(error);

            log.error("confirmPayment failed", {
                code: normalized.code,
                error: normalized.message,
                traceId,
            });

            return {
                status: "ERROR",
                data: null,
                error: {
                    code: normalized.code || "CONFIRM_PAY_FAIL",
                    message: normalized.message,
                },
            };
        }
    }
);

// =============================================================================
// BLOQUE 4 - ORDER VALIDATION
// =============================================================================

async function _getValidatedPaidOrder(
    orderId,
    bookingIds,
    requestedTotalAmount,
    traceId
) {
    const normalizedOrderId = _safeTrim(orderId);

    if (!normalizedOrderId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "orderId is required", { traceId }
        );
    }

    let order;

    try {
        order = await withTimeout(
            getOrderElevated(normalizedOrderId),
            API_TIMEOUT_MS,
            "getOrder"
        );
    } catch (error) {
        throw createBookingError(
            ERROR_CODES.DATABASE_ERROR,
            "Failed to fetch order.", { traceId, cause: error?.message }
        );
    }

    if (!order) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Order not found", { traceId }
        );
    }

    const paymentStatus = String(order?.paymentStatus || "").toUpperCase();

    if (!_isPaidOrderStatus(paymentStatus)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Order is not paid.", { traceId, paymentStatus }
        );
    }

    const bookingLineItems = _getOrderBookingLineItems(order);

    /* F-12: se exige pertenencia de cada booking solicitado a la orden.
       No se exige igualdad estricta de conjuntos para no rechazar ordenes
       con lineas legitimas adicionales. */
    const orderBookingIds = Array.from(
        new Set(
            bookingLineItems
                .map((item) =>
                    _safeTrim(item?.catalogReference?.catalogItemId || "")
                )
                .filter(Boolean)
        )
    );

    const requestedIds = new Set(bookingIds.map(String));
    const orderIds = new Set(orderBookingIds);

    for (const id of requestedIds) {
        if (!orderIds.has(id)) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking is not included in the order.",
                { traceId, bookingId: id }
            );
        }
    }

    const orderTotal = Number(order?.priceSummary?.total?.amount ?? 0) || 0;

    const lineItemsTotal = _getBookingLineItemsTotal(bookingLineItems);

    const finalAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;

    if (
        requestedTotalAmount &&
        Math.abs(finalAmount - requestedTotalAmount) > 0.01
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Amount does not match the order.", { traceId }
        );
    }

    return { order, finalAmount, bookingLineItems };
}

/**
 * F-01: idempotencia coherente.
 * - Rechaza REFUNDED.
 * - Rechaza PAID con orden distinta.
 * - Rechaza estados bloqueados.
 * - PAID con la misma orden se acepta (el flujo idempotente lo procesa antes).
 */
async function _validatePaymentCitaSet(citas, orderId, traceId) {
    for (const cita of citas) {
        const meta = _getCitaMeta(cita);

        const currentPaymentStatus = String(
            cita?.[FIELD_PAYMENT_STATUS] ||
            meta.paymentStatus ||
            ""
        ).toUpperCase();

        const existingOrderId = _safeTrim(
            cita?.[FIELD_ORDER_ID] || meta.orderId || ""
        );

        const bookingId = _safeTrim(
            cita?.[FIELD_BOOKING_ID] || cita?.bookingId || ""
        );

        if (currentPaymentStatus === PAYMENT_STATUS.REFUNDED) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking has already been refunded.",
                { traceId, bookingId, orderId }
            );
        }

        if (
            currentPaymentStatus === PAYMENT_STATUS.PAID &&
            existingOrderId !== orderId
        ) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking has already been paid with another order.",
                { traceId, bookingId, orderId, existingOrderId }
            );
        }

        const bookingStatus = String(
            cita?.[FIELD_STATUS] ||
            cita?.bookingStatus ||
            ""
        ).toUpperCase();

        if (BLOCKED_PAYMENT_STATES.has(bookingStatus)) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking cannot be paid in its current state.",
                { traceId, bookingId, bookingStatus }
            );
        }
    }
}

/**
 * F-01: si TODAS las citas ya estan PAID con la misma orden, no hay nada
 * que hacer. Si hay mezcla (unas pagadas, otras no), se rechaza.
 */
async function _validatePaymentIdempotency(citas, orderId, traceId) {
    let paidCount = 0;

    for (const cita of citas) {
        const meta = _getCitaMeta(cita);

        const existingOrderId = _safeTrim(
            cita?.[FIELD_ORDER_ID] || meta.orderId || ""
        );

        const paymentStatus = String(
            cita?.[FIELD_PAYMENT_STATUS] ||
            meta.paymentStatus ||
            ""
        ).toUpperCase();

        if (paymentStatus !== PAYMENT_STATUS.PAID) {
            continue;
        }

        if (!existingOrderId || existingOrderId !== orderId) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking has already been paid.",
                { traceId, orderId, existingOrderId }
            );
        }

        paidCount += 1;
    }

    /* Mezcla inconsistente: algunas pagadas, otras no. */
    if (paidCount > 0 && paidCount !== citas.length) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Payment state is inconsistent across bookings.",
            { traceId, orderId, paidCount, total: citas.length }
        );
    }
}

/**
 * F-11 + H-13: escritura canonica con transicion controlada.
 */
async function _setCitasPaymentState(
    citas,
    paymentState,
    orderId,
    cashMovementId,
    traceId
) {
    for (const cita of citas) {
        const bookingId = _safeTrim(
            cita?.[FIELD_BOOKING_ID] || cita?.bookingId || ""
        );

        if (!bookingId) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking identifier is missing.", { traceId }
            );
        }

        await _updateCitaSafe(
            bookingId,
            (currentCita) => {
                const meta = _getCitaMeta(currentCita);

                const nextBookingStatus = _resolveBookingStatusAfterPayment(
                    currentCita,
                    traceId
                );

                return {
                    ...currentCita,
                    [FIELD_STATUS]: nextBookingStatus,
                    [FIELD_PAYMENT_STATUS]: paymentState,
                    [FIELD_CASH_MOVEMENT_ID]: cashMovementId || null,
                    [FIELD_ORDER_ID]: orderId || null,
                    [FIELD_TRACE_ID]: traceId,
                    meta: {
                        ...meta,
                        paymentStatus: paymentState,
                        cashMovementId: cashMovementId || null,
                        orderId: orderId || null,
                        traceId,
                        fechaConfirmacionPago: new Date(),
                    },
                };
            },
            traceId,
            "citasManager_setPaymentState"
        );
    }
}

// =============================================================================
// BLOQUE 5 - BOOKING LOOKUP
// =============================================================================

/**
 * F-03: lee contactDetails via FIELD_CONTACT_DETAILS.
 * H-01: comparacion estricta con el miembro autenticado actual.
 */
async function _assertBookingOwner(cita, traceId) {
    if (!cita) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "Booking was not found.", { traceId }
        );
    }

    const meta = _getCitaMeta(cita);
    const contactDetails =
        cita?.[FIELD_CONTACT_DETAILS] || meta.contactDetails || {};

    const memberId = _safeTrim(
        contactDetails?.memberId ||
        contactDetails?._id ||
        meta.memberId ||
        ""
    );

    if (!memberId) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "Booking owner could not be verified.", { traceId }
        );
    }

    const currentMemberId = await _getCurrentMemberId();

    if (!currentMemberId || currentMemberId !== memberId) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "You are not authorized for this booking.", { traceId }
        );
    }

    return true;
}

/**
 * H-04: campos fisicos canonicos de CitasF2.
 */
function _getBookingSlotFromCita(cita) {
    return {
        serviceId: _safeTrim(
            cita?.[FIELD_SERVICE_ID] || cita?.serviceId || ""
        ),
        resourceId: _safeTrim(
            cita?.[FIELD_RESOURCE_ID] || cita?.resourceId || ""
        ),
        slotStart: _normalizeLocalIsoStr(
            cita?.[FIELD_SLOT_START] || ""
        ),
        slotEnd: _normalizeLocalIsoStr(
            cita?.[FIELD_SLOT_END] || ""
        ),
    };
}

/**
 * H-05 + H-06: preserva slotRef validado.
 */
function _getDualSlotInput(payload, key) {
    const slot = payload?.[key];

    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
        return null;
    }

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate);

    const slotRef =
        slot.slotRef &&
        typeof slot.slotRef === "object" &&
        !Array.isArray(slot.slotRef)
            ? slot.slotRef
            : null;

    if (!localStartDate || !localEndDate || !slotRef) {
        return null;
    }

    if (!_hasSlotReference(slotRef)) {
        return null;
    }

    return {
        localStartDate,
        localEndDate,
        slotRef,
        serviceId: _safeTrim(slot.serviceId || ""),
    };
}

function _hasSlotReference(slotRef) {
    if (!slotRef || typeof slotRef !== "object") return false;

    return Boolean(
        _safeTrim(slotRef.id || "") ||
        _safeTrim(slotRef.slotId || "") ||
        _safeTrim(slotRef.scheduleId || "") ||
        _safeTrim(slotRef.serviceId || "")
    );
}

/**
 * F-05: comprueba que la revalidacion devuelve el mismo slot solicitado.
 */
function _slotReferenceMatches(inputSlot, result) {
    const returnedSlot = result?.data?.slot;
    if (!returnedSlot) return false;

    const inputStart = _normalizeLocalIsoStr(inputSlot.localStartDate);
    const inputEnd = _normalizeLocalIsoStr(inputSlot.localEndDate);

    const resultStart = _normalizeLocalIsoStr(
        returnedSlot.localStartDate || returnedSlot.startDate || ""
    );
    const resultEnd = _normalizeLocalIsoStr(
        returnedSlot.localEndDate || returnedSlot.endDate || ""
    );

    return inputStart === resultStart && inputEnd === resultEnd;
}

function _matchesCitaPairIdentifier(cita, token) {
    const meta = _getCitaMeta(cita);

    const pairToken = _safeTrim(
        cita?.[FIELD_PAIR_TOKEN] || meta.pairToken
    );

    return pairToken === _safeTrim(token);
}

function _buildDualRescheduleSlot(serviceConfig, inputSlot, expectedServiceId) {
    if (
        !serviceConfig ||
        !inputSlot?.localStartDate ||
        !inputSlot?.localEndDate
    ) {
        return null;
    }

    const linkedServiceId = _safeTrim(serviceConfig.linkedPhases || "");
    const expectedId = _safeTrim(expectedServiceId);

    if (!linkedServiceId || !expectedId || linkedServiceId !== expectedId) {
        return null;
    }

    return {
        serviceId: linkedServiceId,
        localStartDate: inputSlot.localStartDate,
        localEndDate: inputSlot.localEndDate,
    };
}

async function _loadServiceConfigForCita(cita, traceId) {
    const meta = _getCitaMeta(cita);

    const serviceId = _safeTrim(
        cita?.[FIELD_SERVICE_ID] || cita?.serviceId || meta.serviceId
    );

    if (!serviceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking service is missing.", { traceId }
        );
    }

    const result = await _getServiceBySlugOrIdInternal(serviceId, traceId);

    if (result?.status !== "SUCCESS" || !result?.data) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking service configuration was not found.", { traceId }
        );
    }

    return result.data;
}

// =============================================================================
// BLOQUE 6 - DUAL SLOT REVALIDATION
// =============================================================================

/**
 * H-07 + H-08 + F-05 + F-06: validacion endurecida.
 */
async function _revalidateDualInputSlots(
    citas,
    slotF1Input,
    slotF2Input,
    traceId
) {
    if (!slotF1Input?.localStartDate || !slotF1Input?.localEndDate) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F1 slot dates are required.", { traceId }
        );
    }

    if (!slotF2Input?.localStartDate || !slotF2Input?.localEndDate) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 slot dates are required.", { traceId }
        );
    }

    const f1Cita =
        citas.find((cita) => {
            const meta = _getCitaMeta(cita);

            return !(
                cita?.bookingType === BOOKING_TYPE.DUAL_F2 ||
                meta.linkedF1BookingId
            );
        }) || citas[0];

    const f2Cita =
        citas.find((cita) => {
            const meta = _getCitaMeta(cita);

            return (
                cita?.bookingType === BOOKING_TYPE.DUAL_F2 ||
                Boolean(meta.linkedF1BookingId)
            );
        }) || citas[1];

    if (!f1Cita || !f2Cita) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Both dual booking phases are required.", { traceId }
        );
    }

    const f1ServiceId = _safeTrim(
        f1Cita?.[FIELD_SERVICE_ID] ||
        f1Cita?.serviceId ||
        _getCitaMeta(f1Cita).serviceId
    );

    const f2ServiceId = _safeTrim(
        f2Cita?.[FIELD_SERVICE_ID] ||
        f2Cita?.serviceId ||
        _getCitaMeta(f2Cita).serviceId
    );

    if (slotF1Input.serviceId && slotF1Input.serviceId !== f1ServiceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F1 service does not match the booking.",
            { traceId, expected: f1ServiceId, received: slotF1Input.serviceId }
        );
    }

    if (slotF2Input.serviceId && slotF2Input.serviceId !== f2ServiceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 service does not match the booking.",
            { traceId, expected: f2ServiceId, received: slotF2Input.serviceId }
        );
    }

    const f1ResourceId = _safeTrim(
        f1Cita?.[FIELD_RESOURCE_ID] || f1Cita?.resourceId || ""
    );
    const f2ResourceId = _safeTrim(
        f2Cita?.[FIELD_RESOURCE_ID] || f2Cita?.resourceId || ""
    );

    if (f1ResourceId && f2ResourceId && f1ResourceId !== f2ResourceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual phases must use the same staff member.", { traceId }
        );
    }

    const selectedResourceId = f1ResourceId || f2ResourceId || null;

    const f1Addons = _getAddOnIdsForRevalidation(f1Cita);
    const f2Addons = _getAddOnIdsForRevalidation(f2Cita);

    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: f1ServiceId,
        localStartDate: slotF1Input.localStartDate,
        localEndDate: slotF1Input.localEndDate,
        resourceId: selectedResourceId,
        nativeAddonIds: f1Addons,
        traceId,
    });

    if (
        f1Result?.status !== "SUCCESS" ||
        !_slotReferenceMatches(slotF1Input, f1Result)
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F1 slot could not be verified.",
            { traceId }
        );
    }

    const f2Result = await revalidateExactAvailabilitySlot({
        serviceId: f2ServiceId,
        localStartDate: slotF2Input.localStartDate,
        localEndDate: slotF2Input.localEndDate,
        resourceId: selectedResourceId,
        nativeAddonIds: f2Addons,
        traceId,
    });

    if (
        f2Result?.status !== "SUCCESS" ||
        !_slotReferenceMatches(slotF2Input, f2Result)
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 slot could not be verified.",
            { traceId }
        );
    }

    const range = toUtcRange(
        slotF1Input.localStartDate,
        slotF1Input.localEndDate
    );

    const f2StartUtc = getUtcDateFromMadridLocal(slotF2Input.localStartDate);

    if (!range || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual slot dates are invalid.", { traceId }
        );
    }

    const { endUtc: f1EndUtc } = range;

    if (f2StartUtc.getTime() < f1EndUtc.getTime()) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 must start after F1.", { traceId }
        );
    }

    const serviceConfig = await _loadServiceConfigForCita(f1Cita, traceId);

    const exposureMinutes = Math.max(
        0,
        Number(
            serviceConfig?.exposureDuration ??
            serviceConfig?.tiempoExposicion ??
            0
        )
    );

    /* F-06: hueco maximo acotado por configuracion del servicio si existe. */
    const configuredServiceGap = Number(serviceConfig?.maxDualGapMinutes);
    const effectiveMaxGap =
        Number.isFinite(configuredServiceGap) && configuredServiceGap >= 0
            ? Math.min(MAX_DUAL_GAP_MINUTES, configuredServiceGap)
            : MAX_DUAL_GAP_MINUTES;

    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);

    if (gapMinutes === null) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Gap between F1 and F2 could not be computed.", { traceId }
        );
    }

    if (gapMinutes < exposureMinutes) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Gap between F1 and F2 is shorter than the required exposure time.",
            { traceId, gapMinutes, exposureMinutes }
        );
    }

    if (gapMinutes > effectiveMaxGap) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Gap between F1 and F2 exceeds the maximum allowed.",
            { traceId, gapMinutes, maxGap: effectiveMaxGap }
        );
    }

    return {
        f1Cita,
        f2Cita,
        f1Result,
        f2Result,
        selectedResourceId,
        gapMinutes,
        exposureMinutes,
        effectiveMaxGap,
    };
}
