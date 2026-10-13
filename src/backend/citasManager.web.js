/*
=============================================================================
MODULE: backend/citasManager.web.js
VERSION: v10.4-CMS-FINAL
BASE: v10.3-FINAL + alineacion CMS KEY FIELDS, Biblia SSOT y saga v5013.
RESPONSIBILITY: Booking processing, payment confirmation and rescheduling.
STANDARDS: G10 ASCII Strict. Sin console.log directo (logger SSOT).

CONTRATO OFICIAL VERIFICADO (dev.wix.com, Bookings Writer V2):
  - Reschedule Booking: POST /bookings/v2/bookings/{bookingId}/reschedule
    body { slot: {serviceId, scheduleId, startDate (ISO UTC Z), endDate,
    timezone, resource:{id}, location:{id, locationType}}, revision: STRING,
    flowControlSettings? }. revision obligatorio como string (int64).
  - confirmOrDeclineBooking: solo con checkout propio (rama presencial).
    Con eCommerce checkout, Wix sincroniza el estado desde la orden: la
    confirmacion de pago online vive en events.js (webhook), y este
    confirmPayment es la via de staff/reconciliacion.

FIXES APLICADOS v10.4-CMS-FINAL:
  CM4-01 (P0): discriminacion de canal por CHANNEL_TYPE. PAYMENT_METHOD.ONLINE
    / PRESENCIAL no existen en el enum canonico (BIBLIA 6.3, SAGA-11).
    _validateProcessBookingPayload resuelve channel = channelType ??
    paymentMethod y exige ONLINE|PRESENCIAL. paymentMethod solo se acepta
    como miembro real del enum PAYMENT_METHOD (EFECTIVO, TARJETA, BIZUM,
    TRANSFERENCIA, WIX_PAYMENTS, OTRO) o como valor de canal transitorio.
    processDualBooking inyecta channelType normalizado a la saga.
  CM4-02 (P0): _isOnlinePaymentAllowed lee meta.channelType === ONLINE o
    meta.checkoutUrl (campos persistidos por bookingSaga v5013 SAGA-31).
    Fallback transitorio meta.paymentMethod. Ya no depende de un campo
    fisico paymentMethod que NO existe en CitasF2 (KEY FIELDS).
  CM4-03 (P0): ownership real. Staff: MapaStaff.memberId del miembro actual
    con rolWebsite ADMIN|GESTION. Propietario: email del miembro contra
    contactDetails.email, o contactDetails.memberId si existiera. Ya no se
    exige contactDetails.memberId (la saga persiste nombre/email/telefono
    minimizados, nunca memberId).
  CM4-04 (P1): wix-members-backend -> @wix/members (matriz transversal).
    Shape defensivo: response.member ?? response.
  CM4-05 (P1): ledger con PAYMENT_METHOD.WIX_PAYMENTS + constante
    MOVEMENT_TYPE.VENTA_ONLINE + channelType ONLINE. Cero literales.
    (ADVERTENCIA ADR: el enum de movementType en cms.v8 es COBRO/DEVOLUCION/
    ...; internalConfig define VENTA_ONLINE/REEMBOLSO. Se usa la constante
    de internalConfig como SSOT de codigo hasta resolucion del ADR.)
  CM4-06 (P1): orderId solo en meta (no es campo fisico de CitasF2 segun
    KEY FIELDS). Lectura con fallback fisico-legacy -> meta preservada.
  CM4-07 (P1): _getBookingSlotFromCita usa _toDateSafe: slotStart/slotEnd
    son Date en wix-data; _normalizeLocalIsoStr(Date) devolvia "".
  CM4-08 (P1): nuevos webMethods rescheduleExistingBooking y
    rescheduleDualBookings (BIBLIA 10/20.8). Consumen los helpers antes
    huerfanos: _getDualSlotInput, _hasSlotReference, _slotReferenceMatches,
    _matchesCitaPairIdentifier, _buildDualRescheduleSlot,
    _getBookingSlotFromCita, _loadServiceConfigForCita,
    _revalidateDualInputSlots, _findCitasByPairToken.
  CM4-09 (P2): _assertReschedulableCita: solo bookingStatus PENDING/
    CONFIRMED (enum CMS) y slot actual en futuro.

FIXES HEREDADOS v10.3-FINAL: F-01..F-12.
FIXES HEREDADOS v10.2-HARDENED: H-01..H-15.
FIXES HEREDADOS v10.1-ALIGNED: CM-01..CM-05.

DEPENDENCIAS: backend/dataAccess.js, backend/booking/bookingSaga.js,
  backend/booking/bookingCore.js, backend/cajas.web.js,
  backend/reservas.web.js (v10-CMS-FINAL), backend/security.js,
  backend/audit.js, backend/logger.js, backend/internalConfig.js.
PENDIENTES (fuera de este pase):
  - ADR: permisos de confirmPayment (BIBLIA 10 declara Admin; se mantiene
    SiteMember + ownership/rol real hasta decision formal).
  - Migracion dataAccess -> contrato unico con dataLegacyAdapter.
=============================================================================
*/
import { webMethod, Permissions } from "wix-web-module";
import { orders } from "@wix/ecom";
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
/* CM4-04: @wix/members sustituye a wix-members-backend (matriz transversal). */
import { currentMember } from "@wix/members";
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
    CHANNEL_TYPE,
    MOVEMENT_TYPE,
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
    _toDateSafe,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
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
    _forceStaffInPristineSlot,
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
const MAPA_STAFF_COL = COLLECTIONS.MAPA_STAFF;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const AUDIT_SOURCE = "backend/citasManager.web.js";
const MADRID_TZ = _safeTrim(SDK_CONFIG?.TZ) || "Europe/Madrid";

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

/* CM4-09: solo estos estados CMS admiten reprogramacion. */
const ALLOWED_RESCHEDULE_STATES = Object.freeze(
    new Set(["PENDING", "CONFIRMED"])
);

/* CM4-01: canales canonicos (BIBLIA 6.3). */
const CHANNEL_ONLINE = _safeTrim(CHANNEL_TYPE.ONLINE).toUpperCase();
const CHANNEL_PRESENCIAL = _safeTrim(CHANNEL_TYPE.PRESENCIAL).toUpperCase();

/* CM4-03: roles de website que habilitan operacion sobre reservas ajenas. */
const STAFF_ROLES_ALLOWED = Object.freeze(new Set(["ADMIN", "GESTION"]));

const getOrderElevated = auth.elevate(orders.getOrder);
/* CM4-08: Reschedule Booking (Writer V2, contrato verificado). */
const rescheduleBookingElevated = auth.elevate(bookings.rescheduleBooking);
/* Revision viva de la reserva (Reader V2). */
const getBookingElevated = auth.elevate(bookings.getBooking);

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

/* H-12 + CM4-06: orderId se lee del campo fisico legacy o de meta. */
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
 * CM4-02: la reserva es online si la saga persistio channelType=ONLINE o
 * un checkoutUrl en meta. Fallback transitorio: meta.paymentMethod.
 * Ya no se lee un campo fisico paymentMethod (no existe en CitasF2).
 */
function _isOnlinePaymentAllowed(cita) {
    const meta = _getCitaMeta(cita);
    const channel = _safeTrim(
        meta.channelType || cita?.channelType || ""
    ).toUpperCase();
    if (channel === CHANNEL_ONLINE) return true;
    if (_safeTrim(meta.checkoutUrl || "")) return true;
    const legacyPaymentMethod = _safeTrim(
        meta.paymentMethod || cita?.[FIELD_PAYMENT_METHOD] || ""
    ).toUpperCase();
    return (
        legacyPaymentMethod === CHANNEL_ONLINE ||
        legacyPaymentMethod === _safeTrim(PAYMENT_METHOD.WIX_PAYMENTS).toUpperCase()
    );
}

/**
 * CM4-03/CM4-04: miembro actual via @wix/members. Shape defensivo:
 * la SDK v2 envuelve el resultado en { member }, la legacy devolvia el
 * objeto plano. Devuelve null si no hay miembro autenticado.
 */
async function _getCurrentMemberInfo() {
    try {
        const response = await currentMember.getMember();
        const member = response?.member || response;
        if (!member || member.status === "ERROR") return null;
        return member;
    } catch (_) {
        return null;
    }
}

async function _getCurrentMemberId() {
    const member = await _getCurrentMemberInfo();
    return _safeTrim(member?._id || member?.id || member?.memberId || "");
}

function _getMemberEmail(member) {
    if (!member) return "";
    const fromList = Array.isArray(member.contactEmails) && member.contactEmails.length
        ? member.contactEmails[0]
        : "";
    return _safeTrim(
        member.loginEmail || member.contactEmail || fromList || ""
    ).toLowerCase();
}

/**
 * CM4-01: valida el payload de processDualBooking antes del Saga.
 * El discriminador de flujo es CHANNEL_TYPE (ONLINE|PRESENCIAL), leido de
 * payload.channelType con fallback transitorio a payload.paymentMethod
 * (el widget actual envia paymentMethod = "ONLINE"|"PRESENCIAL").
 * Si paymentMethod trae un valor distinto de canal, debe ser miembro real
 * del enum PAYMENT_METHOD (BIBLIA 6.3).
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
    const channelRaw = _safeTrim(
        payload.channelType || payload.paymentMethod || ""
    ).toUpperCase();
    if (channelRaw !== CHANNEL_ONLINE && channelRaw !== CHANNEL_PRESENCIAL) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Invalid channelType: expected ONLINE or PRESENCIAL.",
            { traceId, channelType: channelRaw || null }
        );
    }
    const paymentMethodRaw = _safeTrim(payload.paymentMethod || "").toUpperCase();
    if (
        paymentMethodRaw &&
        paymentMethodRaw !== CHANNEL_ONLINE &&
        paymentMethodRaw !== CHANNEL_PRESENCIAL
    ) {
        const isValidEnumMember = Object.values(PAYMENT_METHOD || {})
            .map((value) => _safeTrim(value).toUpperCase())
            .includes(paymentMethodRaw);
        if (!isValidEnumMember) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Invalid payment method.",
                { traceId, paymentMethod: paymentMethodRaw }
            );
        }
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
    return { channelType: channelRaw };
}

// =============================================================================
// BLOQUE 3 - PUBLIC WEB METHODS
// =============================================================================
export const processDualBooking = webMethod(
    Permissions.Anyone,
    async (unsafePayload) => {
        const traceId = unsafePayload?.traceId || makeTraceId("dual-bkg");
        try {
            const validated = _validateProcessBookingPayload(
                unsafePayload,
                traceId
            );
            _rateLimitOrThrow(
                "citasManager.processDualBooking",
                _safeTrim(unsafePayload?.email) || "anon",
                traceId
            );
            const normalizedPayload = {
                ...unsafePayload,
                /* CM4-01: canal canonico explicito para la saga. */
                channelType: validated.channelType,
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
 * confirmPayment v10.4:
 *  - Orden de operaciones: lookup -> ownership -> validacion orden ->
 *    idempotencia -> ledger -> CMS.
 *  - Idempotente: si todas las citas ya estan PAID para esta orden,
 *    devuelve SUCCESS sin re-registrar ledger.
 *  - Auditoria si ledger OK pero CMS falla.
 *  - CM4-03: ownership real (staff por rolWebsite o propietario por email).
 *  - CM4-05: ledger con WIX_PAYMENTS + MOVEMENT_TYPE + channelType.
 *  - NOTA: con checkout eCom, la confirmacion automatica vive en events.js
 *    (webhook). Este metodo es la via de staff/reconciliacion.
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
            /* CM4-05: enum reales. WIX_PAYMENTS es el metodo del canal
               online (BIBLIA 6.3); el canal se discrimina por channelType. */
            const ledgerResult = await registerBookingPayment(
                linkedBookingIds,
                finalAmount,
                PAYMENT_METHOD.WIX_PAYMENTS, {
                    concept: "Online booking payment",
                    resourceId: "online",
                    traceId,
                    transactionId: `ORDER-${orderId}`,
                    orderId,
                    origen: "WIX_ECOM_PAYMENT_CONFIRM",
                    movementType: MOVEMENT_TYPE.VENTA_ONLINE,
                    channelType: CHANNEL_TYPE.ONLINE,
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
 * F-11 + H-13 + CM4-06: escritura canonica con transicion controlada.
 * orderId NO es campo fisico de CitasF2 (KEY FIELDS): vive solo en meta.
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
                const updated = {
                    ...currentCita,
                    [FIELD_STATUS]: nextBookingStatus,
                    [FIELD_PAYMENT_STATUS]: paymentState,
                    [FIELD_CASH_MOVEMENT_ID]: cashMovementId || null,
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
                /* CM4-06: orderId fisico legacy solo se preserva si ya
                   existia; nunca se crea como campo nuevo. */
                return updated;
            },
            traceId,
            "citasManager_setPaymentState"
        );
    }
}

// =============================================================================
// BLOQUE 5 - BOOKING LOOKUP Y OWNERSHIP
// =============================================================================
/**
 * F-03 + CM4-03: ownership real sin exigir contactDetails.memberId.
 * Rutas de autorizacion (en orden):
 *   1. Staff: el miembro actual existe en MapaStaff (por memberId) con
 *      rolWebsite ADMIN o GESTION.
 *   2. Propietario por memberId persistido (contactDetails.memberId o
 *      meta.memberId) si llegara a existir en el futuro.
 *   3. Propietario por email: email del miembro autenticado coincide con
 *      contactDetails.email de la cita (la saga persiste email siempre).
 * Fuera de esas rutas: AUTH_REQUIRED.
 */
async function _assertBookingOwner(cita, traceId) {
    if (!cita) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "Booking was not found.", { traceId }
        );
    }
    const member = await _getCurrentMemberInfo();
    const memberId = _safeTrim(member?._id || member?.id || member?.memberId || "");
    if (!memberId) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "Authenticated member is required for this operation.",
            { traceId }
        );
    }
    /* Ruta 1: staff por rolWebsite (BIBLIA 13.1: el rol de negocio manda). */
    const staff = await queryFirstItem({
        dataCollectionId: MAPA_STAFF_COL,
        filter: wql.eq("memberId", memberId),
        consistency: CONSISTENCY.STRONG,
    }).catch(() => null);
    const rolWebsite = _safeTrim(staff?.rolWebsite).toUpperCase();
    if (rolWebsite && STAFF_ROLES_ALLOWED.has(rolWebsite)) {
        return { memberId, rolWebsite, via: "STAFF_ROLE" };
    }
    const meta = _getCitaMeta(cita);
    const contactDetails =
        cita?.[FIELD_CONTACT_DETAILS] || meta.contactDetails || {};
    /* Ruta 2: memberId persistido en la cita. */
    const storedMemberId = _safeTrim(
        contactDetails?.memberId ||
        meta.memberId ||
        ""
    );
    if (storedMemberId && storedMemberId === memberId) {
        return { memberId, rolWebsite, via: "MEMBER_ID" };
    }
    /* Ruta 3: propietario por email. */
    const memberEmail = _getMemberEmail(member);
    const citaEmail = _safeTrim(contactDetails?.email || "").toLowerCase();
    if (memberEmail && citaEmail && memberEmail === citaEmail) {
        return { memberId, rolWebsite, via: "EMAIL_MATCH" };
    }
    throw createBookingError(
        ERROR_CODES.AUTH_REQUIRED,
        "You are not authorized for this booking.", { traceId }
    );
}

/**
 * H-04 + CM4-07: campos fisicos canonicos de CitasF2.
 * slotStart/slotEnd son Date en wix-data: se convierten con _toDateSafe
 * (antes _normalizeLocalIsoStr(Date) devolvia "" y el guard de pasado
 * nunca funcionaba).
 */
function _getBookingSlotFromCita(cita) {
    return {
        serviceId: _safeTrim(
            cita?.[FIELD_SERVICE_ID] || cita?.serviceId || ""
        ),
        resourceId: _safeTrim(
            cita?.[FIELD_RESOURCE_ID] || cita?.resourceId || ""
        ),
        slotStart: _toDateSafe(cita?.[FIELD_SLOT_START]) || null,
        slotEnd: _toDateSafe(cita?.[FIELD_SLOT_END]) || null,
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
                cita?.bookingType === BOOKING_TYPE.DUALF2 ||
                meta.linkedF1BookingId
            );
        }) || citas[0];
    const f2Cita =
        citas.find((cita) => {
            const meta = _getCitaMeta(cita);
            return (
                cita?.bookingType === BOOKING_TYPE.DUALF2 ||
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
        serviceConfig,
        gapMinutes,
        exposureMinutes,
        effectiveMaxGap,
    };
}

// =============================================================================
// BLOQUE 7 - RESCHEDULE (CM4-08 / BIBLIA 10 y 20.8)
// =============================================================================
/* Contrato oficial verificado (dev.wix.com, Reschedule Booking):
 *   body = { slot: {serviceId, scheduleId, startDate (ISO UTC Z), endDate,
 *            timezone, resource:{id}, location:{id, locationType}},
 *            revision: "<string int64>" }
 * El slot nuevo se construye con bookingCore._forceStaffInPristineSlot
 * (misma forma verificada del body de createBooking, sin add-ons).
 * La revision viva se lee con bookings.getBooking; fallback a cita.revision.
 */
async function _fetchLiveRevision(bookingId, cita) {
    try {
        const live = await withTimeout(
            getBookingElevated(_safeTrim(bookingId)),
            API_TIMEOUT_MS,
            "getBookingForRevision"
        );
        const liveBooking = live?.booking || live;
        const revision = _safeTrim(liveBooking?.revision);
        if (revision) return revision;
    } catch (error) {
        log.warn("_fetchLiveRevision: getBooking failed; fallback a cita.revision", {
            bookingId,
            error: error?.message,
        });
    }
    const meta = _getCitaMeta(cita);
    const fallback = _safeTrim(
        cita?.revision || meta.writerRevision || ""
    );
    return fallback || "";
}

/* CM4-09: solo PENDING/CONFIRMED (enum CMS) y slot aun no iniciado. */
function _assertReschedulableCita(cita, traceId) {
    const bookingStatus = _safeTrim(
        cita?.[FIELD_STATUS] || cita?.bookingStatus || ""
    ).toUpperCase();
    if (!ALLOWED_RESCHEDULE_STATES.has(bookingStatus)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking cannot be rescheduled in its current state.",
            { traceId, bookingStatus }
        );
    }
    const currentSlot = _getBookingSlotFromCita(cita);
    if (currentSlot.slotEnd && currentSlot.slotEnd.getTime() <= Date.now()) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking slot has already started or finished.",
            { traceId }
        );
    }
    return currentSlot;
}

async function _rescheduleBookingNative(cita, slotInput, traceId) {
    const bookingId = _safeTrim(
        cita?.[FIELD_BOOKING_ID] || cita?.bookingId || ""
    );
    if (!bookingId || !_looksLikeGuid(bookingId)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking identifier is missing.", { traceId }
        );
    }
    const serviceId = _safeTrim(
        slotInput.serviceId ||
        cita?.[FIELD_SERVICE_ID] ||
        cita?.serviceId ||
        ""
    );
    const resourceId = _safeTrim(
        cita?.[FIELD_RESOURCE_ID] || cita?.resourceId || ""
    );
    const pristineSlot = await _forceStaffInPristineSlot(
        {
            localStartDate: slotInput.localStartDate,
            localEndDate: slotInput.localEndDate,
        },
        resourceId,
        serviceId,
        null
    );
    if (!pristineSlot) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Could not build the reschedule slot.", { traceId, bookingId }
        );
    }
    const revision = await _fetchLiveRevision(bookingId, cita);
    if (!revision) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Current booking revision is required to reschedule.",
            { traceId, bookingId }
        );
    }
    await withTimeout(
        rescheduleBookingElevated(bookingId, {
            slot: pristineSlot,
            revision: String(revision),
        }),
        API_TIMEOUT_MS,
        "rescheduleBooking"
    );
    const startUtc = getUtcDateFromMadridLocal(slotInput.localStartDate);
    const endUtc = getUtcDateFromMadridLocal(slotInput.localEndDate);
    return {
        bookingId,
        startUtc,
        endUtc,
        dateYmd: _safeTrim(slotInput.localStartDate).slice(0, 10),
    };
}

async function _applyRescheduleToCita(cita, rescheduleResult, traceId) {
    const bookingId = rescheduleResult.bookingId;
    const meta = _getCitaMeta(cita);
    const previousSlot = _getBookingSlotFromCita(cita);
    await _updateCitaSafe(
        bookingId,
        (currentCita) => {
            const currentMeta = _getCitaMeta(currentCita);
            return {
                ...currentCita,
                [FIELD_SLOT_START]: rescheduleResult.startUtc,
                [FIELD_SLOT_END]: rescheduleResult.endUtc,
                dateYmd: rescheduleResult.dateYmd,
                [FIELD_TRACE_ID]: traceId,
                meta: {
                    ...currentMeta,
                    previousSlotStart: previousSlot.slotStart || null,
                    previousSlotEnd: previousSlot.slotEnd || null,
                    rescheduledAt: new Date(),
                    traceId,
                },
            };
        },
        traceId,
        "citasManager_reschedule"
    );
    /* Invalidacion de caches del dia nuevo y del dia anterior. */
    try {
        const serviceId = _safeTrim(
            cita?.[FIELD_SERVICE_ID] || cita?.serviceId || ""
        );
        const resourceId = _safeTrim(
            cita?.[FIELD_RESOURCE_ID] || cita?.resourceId || ""
        );
        const { _invalidateCachesInternal } = await import("backend/reservas.web.js")
            .catch(() => ({ _invalidateCachesInternal: null }));
        if (typeof _invalidateCachesInternal === "function") {
            await _invalidateCachesInternal(
                serviceId,
                rescheduleResult.dateYmd,
                resourceId,
                traceId
            ).catch(() => null);
        }
    } catch (_) {
        /* best effort: la purga de caches no bloquea el reschedule. */
    }
    void meta;
}

/**
 * CM4-08: reprogramacion de reserva simple (o de una fase concreta).
 * Payload: { bookingId, slotF1: {localStartDate, localEndDate, serviceId?},
 *            traceId? }
 */
export const rescheduleExistingBooking = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("resched");
        try {
            _rateLimitOrThrow(
                "citasManager.rescheduleExistingBooking",
                _safeTrim(payload?.bookingId) || "anon",
                traceId
            );
            const bookingId = _safeTrim(payload?.bookingId);
            if (!bookingId || !_looksLikeGuid(bookingId)) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "bookingId is required.", { traceId }
                );
            }
            const localStartDate = _normalizeLocalIsoStr(
                payload?.slotF1?.localStartDate || ""
            );
            const localEndDate = _normalizeLocalIsoStr(
                payload?.slotF1?.localEndDate || ""
            );
            if (!localStartDate || !localEndDate) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "slotF1.localStartDate and slotF1.localEndDate are required.",
                    { traceId }
                );
            }
            const cita = await _findCitaByBookingId(bookingId);
            if (!cita) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Booking record was not found.", { traceId }
                );
            }
            await _assertBookingOwner(cita, traceId);
            _assertReschedulableCita(cita, traceId);
            const citaServiceId = _safeTrim(
                cita?.[FIELD_SERVICE_ID] || cita?.serviceId || ""
            );
            const requestedServiceId = _safeTrim(payload?.slotF1?.serviceId || "");
            if (requestedServiceId && requestedServiceId !== citaServiceId) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Requested service does not match the booking.",
                    { traceId, expected: citaServiceId }
                );
            }
            const resourceId = _safeTrim(
                cita?.[FIELD_RESOURCE_ID] || cita?.resourceId || ""
            );
            /* Revalidacion de momento (BIBLIA 0.5.2 excepcion legitima):
               el slot nuevo debe seguir existiendo y admitir al staff. */
            const revalidated = await revalidateExactAvailabilitySlot({
                serviceId: citaServiceId,
                localStartDate,
                localEndDate,
                resourceId,
                nativeAddonIds: _getAddOnIdsForRevalidation(cita),
                traceId,
            });
            if (revalidated?.status !== "SUCCESS") {
                throw createBookingError(
                    ERROR_CODES.SLOT_UNAVAILABLE,
                    "New slot could not be verified.", { traceId }
                );
            }
            const slotInput = {
                localStartDate,
                localEndDate,
                serviceId: citaServiceId,
            };
            const rescheduleResult = await _rescheduleBookingNative(
                cita,
                slotInput,
                traceId
            );
            await _applyRescheduleToCita(cita, rescheduleResult, traceId);
            await logAuditEvent(
                "BOOKING_RESCHEDULED",
                "INFO",
                "Booking rescheduled.", {
                    bookingId,
                    traceId,
                    newStart: localStartDate,
                    newEnd: localEndDate,
                },
                traceId,
                bookingId,
                AUDIT_SOURCE
            );
            return {
                status: "SUCCESS",
                data: {
                    bookingId,
                    slotStart: rescheduleResult.startUtc,
                    slotEnd: rescheduleResult.endUtc,
                    dateYmd: rescheduleResult.dateYmd,
                },
                error: null,
            };
        } catch (error) {
            return _handleError(error, "rescheduleExistingBooking", traceId);
        }
    }
);

/**
 * CM4-08: reprogramacion atomica de reserva dual (F1 + F2).
 * Payload: { pairToken,
 *            slotF1: {localStartDate, localEndDate, slotRef, serviceId?},
 *            slotF2: {localStartDate, localEndDate, slotRef, serviceId?},
 *            traceId? }
 * Orden: revalidar ambas fases y gap -> reschedule F1 -> reschedule F2.
 * Si F2 falla: rollback best-effort de F1 a su slot original.
 */
export const rescheduleDualBookings = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("resched-dual");
        try {
            _rateLimitOrThrow(
                "citasManager.rescheduleDualBookings",
                _safeTrim(payload?.pairToken) || "anon",
                traceId
            );
            const pairToken = _safeTrim(payload?.pairToken);
            if (!pairToken) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "pairToken is required.", { traceId }
                );
            }
            const slotF1Input = _getDualSlotInput(payload, "slotF1");
            const slotF2Input = _getDualSlotInput(payload, "slotF2");
            if (!slotF1Input || !slotF2Input) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "slotF1 and slotF2 with localStartDate, localEndDate and slotRef are required.",
                    { traceId }
                );
            }
            const citas = await _findCitasByPairToken(pairToken);
            const matched = citas.filter((cita) =>
                _matchesCitaPairIdentifier(cita, pairToken)
            );
            if (matched.length < 2) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Dual booking phases were not found for this pairToken.",
                    { traceId, found: matched.length }
                );
            }
            for (const cita of matched) {
                await _assertBookingOwner(cita, traceId);
                _assertReschedulableCita(cita, traceId);
            }
            /* Validacion integral: mismas citas, mismo staff, slots exactos,
               gap >= exposure y <= maximo efectivo (consume
               _revalidateDualInputSlots + _slotReferenceMatches). */
            const validation = await _revalidateDualInputSlots(
                matched,
                slotF1Input,
                slotF2Input,
                traceId
            );
            const { f1Cita, f2Cita, serviceConfig } = validation;
            /* _buildDualRescheduleSlot: el serviceId de F2 debe ser el
               linkedPhases del servicio padre. */
            const f2ExpectedServiceId = _safeTrim(
                f2Cita?.[FIELD_SERVICE_ID] || f2Cita?.serviceId || ""
            );
            const dualF2Slot = _buildDualRescheduleSlot(
                serviceConfig,
                slotF2Input,
                f2ExpectedServiceId
            );
            if (!dualF2Slot) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "F2 slot does not correspond to the linked phase of the service.",
                    { traceId, expected: f2ExpectedServiceId }
                );
            }
            const originalF1Slot = _getBookingSlotFromCita(f1Cita);
            /* Reschedule F1. */
            const f1Result = await _rescheduleBookingNative(
                f1Cita,
                slotF1Input,
                traceId
            );
            /* Reschedule F2 con rollback best-effort de F1. */
            let f2Result = null;
            try {
                f2Result = await _rescheduleBookingNative(
                    f2Cita,
                    dualF2Slot,
                    traceId
                );
            } catch (f2Error) {
                log.error("Dual reschedule: F2 failed; rolling back F1", {
                    traceId,
                    error: f2Error?.message,
                });
                if (originalF1Slot.slotStart && originalF1Slot.slotEnd) {
                    try {
                        await _rescheduleBookingNative(
                            f1Cita,
                            {
                                localStartDate: getMadridLocalStringNoZ(originalF1Slot.slotStart),
                                localEndDate: getMadridLocalStringNoZ(originalF1Slot.slotEnd),
                                serviceId: originalF1Slot.serviceId,
                            },
                            traceId
                        );
                    } catch (rollbackError) {
                        await logAuditEvent(
                            "RESCHEDULE_ROLLBACK_FAILED",
                            "ERROR",
                            "F1 rollback failed after F2 reschedule error. Manual intervention required.", {
                                pairToken,
                                traceId,
                                error: rollbackError?.message || String(rollbackError),
                            },
                            traceId,
                            pairToken,
                            AUDIT_SOURCE
                        );
                    }
                }
                throw f2Error;
            }
            await _applyRescheduleToCita(f1Cita, f1Result, traceId);
            await _applyRescheduleToCita(f2Cita, f2Result, traceId);
            await logAuditEvent(
                "DUAL_BOOKING_RESCHEDULED",
                "INFO",
                "Dual booking rescheduled.", {
                    pairToken,
                    traceId,
                    gapMinutes: validation.gapMinutes,
                },
                traceId,
                pairToken,
                AUDIT_SOURCE
            );
            return {
                status: "SUCCESS",
                data: {
                    pairToken,
                    f1: {
                        bookingId: f1Result.bookingId,
                        slotStart: f1Result.startUtc,
                        slotEnd: f1Result.endUtc,
                        dateYmd: f1Result.dateYmd,
                    },
                    f2: {
                        bookingId: f2Result.bookingId,
                        slotStart: f2Result.startUtc,
                        slotEnd: f2Result.endUtc,
                        dateYmd: f2Result.dateYmd,
                    },
                    gapMinutes: validation.gapMinutes,
                },
                error: null,
            };
        } catch (error) {
            return _handleError(error, "rescheduleDualBookings", traceId);
        }
    }
);
