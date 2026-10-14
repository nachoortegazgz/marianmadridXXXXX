/*
=============================================================================
MODULE: backend/events.js
VERSION: v5010-CMS-FINAL
BASE: v5009-FISCAL-V20.1 + correcciones destructivas alineadas con
      CMS KEY FIELDS, Biblia SSOT, matriz legacy e internalConfig v11.
RESPONSIBILITY: Server-to-server native webhooks for Wix Bookings V2 and
  Wix eCommerce V2 with exact-indexed queries, bounded execution, full
  idempotency, and JWT signature verification.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero consistentRead.
CONTRATO OFICIAL (dev.wix.com):
  - Con Wix eCommerce checkout, Bookings sincroniza el estado de pago desde
    la orden automaticamente. Estos webhooks son el UNICO camino de
    confirmacion online (citasManager.confirmPayment es via de
    staff/reconciliacion).
  - Eventos JWT firmados: verificar, extraer payload y DEDUPLICAR contra
    ControlOperativo (WEBHOOK_EVENT) antes de tocar cualquier ledger
    (BIBLIA 3.8 / 15.1.4).
FIXES APLICADOS v5010-CMS-FINAL:
  EVE-07 (P0): safeTrim -> _safeTrim en _getEmisorFiscal. ReferenceError
    que tumbaba toda rectificativa y venta online.
  EVE-08 (P0): markEventAsProcessed sin clave duplicada status. La segunda
    asignacion ("PROCESSED") pisaba CONTROL_STATUS.EXECUTED.
  EVE-09 (P0): eventType/metadata movidos a payloadJson. No son campos
    fisicos de ControlOperativo (CMS KEY FIELDS).
  EVE-10 (P0): lecturas de MovimientosCaja con keys reales CMS + fallbacks
    transitorios consolidados en _readOriginalMovementFiscal:
    baseImponibleOImporteNoSujeto, cuotaTotal/taxAmount, tipoImpositivo,
    numSerieFactura, fechaExpedicionFactura, nifDestinatario,
    recipientLegalName.
  EVE-11 (P1): movimiento original de cancelacion buscado por bookingId
    (FK real en CMS KEY FIELDS) con fallback a linkedBookingIds.
  EVE-12 (P1): dedupe por eventId en wixEcom_onOrderRefunded. Un replay
    de Wix ya no duplica rectificativa, inventario ni marcas de reembolso.
  EVE-13 (P1): PAYMENT_METHOD.ONLINE (inexistente en enum, Biblia 6.3)
    reemplazado por PAYMENT_METHOD.WIX_PAYMENTS en los 5 sitios.
  EVE-14 (P2): channelType literal "ONLINE" reemplazado por constante
    CHANNEL_TYPE.ONLINE.
  EVE-15 (P2): import muerto THIRD_PARTY_TYPE eliminado. Sin consumidor
    en este modulo.
  EVE-16 (P1): _markCitasPaidByBookingIds ya no escribe orderId como campo
    fisico de CitasF2 (no existe en CMS KEY FIELDS). Solo meta.orderId.
  EVE-17 (P2): breakdown de reembolso unificado a forma canonica de venta
    (taxableBaseOrNonSubjectAmount/taxRate/chargedTaxAmount). Antes usaba
    base/tipo/cuota, inconsistente con el desglose de venta.
  EVE-18 (P1): fallback taxRate unificado a IVA_RATES.GENERAL (0.21).
    Antes usaba 21 (entero), incoherente con amount/(1+0.21) de la venta.
  EVE-19 (P1): suppressAuth eliminado de todas las queries. dataLegacyAdapter
    gestiona elevacion internamente.
  EVE-20 (P1): consistentRead reemplazado por consistencyMode:"strong"
    (matriz transversal).
FIXES HEREDADOS v5009-FISCAL-V20.1: V20-01..V20-06.
FIXES HEREDADOS v5009-FISCAL: CONSOL-04..08, E-01..E-03, FIX-55..59.
NOTA DE ENUMS: bookingStatus/paymentStatus nativos Wix (CANCELED,
  PARTIALLY_REFUNDED, REFUNDED...) se pasan tal cual a _updateCitaSafe,
  que los traduce al enum CMS (CANCELLED doble L, PARTIAL, REFUNDED) en
  frontera (bookingCore, CORE-11/20).
PENDIENTES (fuera de este pase):
  - Migracion dataLegacyAdapter -> backend/dataAccess.
  - ADR MOVEMENT_TYPE (internalConfig VENTA_ONLINE/REEMBOLSO vs cms.v8
    COBRO/DEVOLUCION): se mantienen las constantes de internalConfig.
  - Eliminar fallbacks legacy de _readOriginalMovementFiscal tras migrar
    datos historicos de MovimientosCaja a keys reales.
=============================================================================
*/
import { insertItem as insert } from "backend/dataAccess";
import { createClient } from "@wix/sdk";
import { secrets } from "@wix/secrets";
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
    CHANNEL_TYPE,
    BOOKING_STATUS,
    PAYMENT_STATUS,
    BOOKING_FIELDS,
    SDK_CONFIG,
    TIPO_FACTURA,
    CORRECTION_REASON,
    FISCAL_ROLE,
    EVENT_TYPE,
    VAT_ACCRUAL_STATUS,
    IVA_RATES,
} from "backend/internalConfig";
// EVE-15: THIRD_PARTY_TYPE eliminado. Sin consumidor en este modulo.
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
const WEBHOOK_RETRY_DELAY_MS =
    Number(SDK_CONFIG?.EVENTS?.RETRY_BASE_BACKOFF_MS) || 1000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;
const EMISOR_FALLBACK_NAME = "MARIAN MADRID";

// EVE-19/20: lectura fuerte canonica via dataLegacyAdapter.
const STRONG_READ = Object.freeze({ consistencyMode: "strong" });

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
    const values = Array.isArray(value)
        ? value
        : String(value || "").split(",");
    return Array.from(
        new Set(values.map((id) => String(id || "").trim()).filter(Boolean))
    );
}

const PROCESSED_EVENTS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const EVENT_TTL_HOURS = 72;

// ============================================================================
// EMISOR FISCAL CACHE (EVE-07)
// ============================================================================
let _emisorCache = null;

/**
 * EVE-07: _safeTrim (con guion bajo). Antes: safeTrim(nif) -> ReferenceError
 * que tumbaba toda rectificativa y venta online en produccion.
 */
async function _getEmisorFiscal() {
    if (_emisorCache) return _emisorCache;
    try {
        const nif = await secrets
            .getSecretValue(SECRETS.FISCAL_NIF_EMISOR)
            .catch(() => "");
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
        const value = field
            .split(".")
            .reduce((obj, key) => obj?.[key], event);
        if (value === undefined || value === null) {
            log.warn("EVENT_MISSING_FIELD", {
                field,
                eventId: event.eventId || event._id,
            });
            return false;
        }
    }
    return true;
}

// ============================================================================
// IDEMPOTENCY (EVE-08/09/19/20)
// ============================================================================

/**
 * EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
 */
async function isEventProcessed(eventId) {
    if (!eventId) return false;
    const normalizedId = _normalizeIdPart(String(eventId), 100);
    const existing = await wixData
        .query(PROCESSED_EVENTS_COL)
        .eq("controlType", CONTROL_TYPE.WEBHOOK_EVENT)
        .eq("dedupeKey", normalizedId)
        .limit(1)
        .find(STRONG_READ)
        .catch(() => null);
    return !!(existing?.items?.length);
}

/**
 * EVE-08: una sola clave status (CONTROL_STATUS.EXECUTED). Antes habia dos
 *   claves "status" en el mismo literal; la segunda ("PROCESSED") pisaba
 *   a la primera.
 * EVE-09: eventType y metadata van en payloadJson, NO como campos fisicos.
 *   CMS KEY FIELDS ControlOperativo NO tiene eventType ni metadata.
 * EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
 */
async function markEventAsProcessed(
    eventId,
    eventType,
    traceId,
    metadata = {}
) {
    if (!eventId) return;
    const normalizedId = _normalizeIdPart(String(eventId), 100);
    const expiryDate = new Date(Date.now() + EVENT_TTL_HOURS * 3600 * 1000);
    try {
        await insert(
            PROCESSED_EVENTS_COL,
            {
                controlType: CONTROL_TYPE.WEBHOOK_EVENT,
                dedupeKey: normalizedId,
                // EVE-08: una sola clave status.
                status: CONTROL_STATUS.EXECUTED,
                eventId: String(eventId),
                traceId,
                processedAt: new Date(),
                expiresAt: expiryDate,
                // EVE-09: eventType y metadata en payloadJson.
                payloadJson: JSON.stringify({
                    eventType: _safeTrim(eventType),
                    metadata:
                        metadata && typeof metadata === "object"
                            ? metadata
                            : {},
                }),
            },
            STRONG_READ
        );
        log.debug("EVENT_MARKED_PROCESSED", { eventId, eventType });
    } catch (err) {
        // Conflicto de dedupeKey = evento ya registrado. No es error.
        log.debug("EVENT_INSERT_CONFLICT", {
            eventId,
            error: err?.message,
        });
    }
}

function _handleError(error, context, traceId) {
    const normalized = normalizeError(error);
    log.error(`Error in ${context}`, {
        error: normalized.message,
        traceId,
    });
    return { code: normalized.code, message: normalized.message };
}

// ============================================================================
// EXTRACCION FISCAL DEL PEDIDO -- nomenclatura V20.1
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
    const billingAddress =
        billingInfo.address || billingInfo.billingAddress || {};
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
    const recipientAddress =
        billingAddress && Object.keys(billingAddress).length > 0
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
                      billingAddress.city || billingAddress.town || ""
                  ),
                  provincia: _safeTrim(
                      billingAddress.subdivision ||
                          billingAddress.state ||
                          billingAddress.province ||
                          ""
                  ),
              }
            : null;
    const withholdingAmount =
        Number(
            order.taxSummary?.retention?.amount ||
                order.additionalFees?.retention ||
                0
        ) || 0;
    const withholdingBase =
        Number(
            order.taxSummary?.retention?.base ||
                order.priceSummary?.subtotal?.amount ||
                0
        ) || 0;
    const bankReconciliationReference =
        _safeTrim(
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
// LECTURA NORMALIZADA DE MOVIMIENTOSCAJA (EVE-10/18)
// ============================================================================

/**
 * EVE-10: keys reales CMS (KEY FIELDS MovimientosCaja) con fallback
 * transitorio a claves legacy V20.1 para datos historicos.
 * EVE-18: fallback de tipoImpositivo unificado a IVA_RATES.GENERAL (0.21).
 *   Antes usaba 21 (entero), incoherente con amount/(1+0.21) de la venta.
 *
 * Tras migrar datos historicos a keys reales, eliminar los fallbacks.
 */
function _readOriginalMovementFiscal(movement) {
    if (!movement || typeof movement !== "object") return null;
    const base =
        Number(
            movement.baseImponibleOImporteNoSujeto ??
                movement.taxableBaseOrNonSubjectAmount ??
                movement.taxBase ??
                0
        ) || 0;
    const cuota =
        Number(movement.cuotaTotal ?? movement.taxAmount ?? 0) || 0;
    // EVE-18: fallback a IVA_RATES.GENERAL (0.21), nunca 21.
    const tipo = Number(
        movement.tipoImpositivo ?? movement.taxRate ?? IVA_RATES.GENERAL
    );
    return {
        totalAmount:
            Number(
                movement.totalAmount ?? movement.accountingAmount ?? 0
            ) || 0,
        base,
        cuota,
        tipo: Number.isFinite(tipo) ? tipo : IVA_RATES.GENERAL,
        numSerieFactura:
            _safeTrim(
                movement.numSerieFactura || movement.invoiceNumber || ""
            ) || null,
        fechaExpedicionFactura:
            movement.fechaExpedicionFactura ||
            movement.invoiceIssueDate ||
            null,
        nifDestinatario:
            _safeTrim(
                movement.nifDestinatario || movement.recipientTaxId || ""
            ) || null,
        recipientLegalName:
            _safeTrim(movement.recipientLegalName || "") || null,
        paymentMethod: _safeTrim(movement.paymentMethod || "") || null,
        orderId: _safeTrim(movement.orderId || "") || null,
        linkedBookingIds: movement.linkedBookingIds,
    };
}

// ============================================================================
// BUSQUEDA DE MOVIMIENTO ORIGINAL (EVE-11)
// ============================================================================

/**
 * EVE-11: busca primero por bookingId (FK directa en CMS KEY FIELDS
 * MovimientosCaja). Si no encuentra, fallback a linkedBookingIds (CSV,
 * eq solo casa con valor exacto completo).
 * EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
 */
async function _findOriginalOnlineMovement(bookingId) {
    const id = _safeTrim(bookingId);
    if (!id) return null;
    // Busqueda primaria: bookingId (FK directa).
    const primary = await wixData
        .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
        .eq("bookingId", id)
        .eq("movementType", MOVEMENT_TYPE.VENTA_ONLINE)
        .limit(1)
        .find(STRONG_READ)
        .catch(() => ({ items: [] }));
    if (primary?.items?.length) return primary.items[0];
    // Fallback: linkedBookingIds (CSV).
    const fallback = await wixData
        .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
        .eq("linkedBookingIds", id)
        .eq("movementType", MOVEMENT_TYPE.VENTA_ONLINE)
        .limit(1)
        .find(STRONG_READ)
        .catch(() => ({ items: [] }));
    return fallback?.items?.[0] || null;
}

// ============================================================================
// CITA STATUS UPDATES (EVE-16)
// ============================================================================

async function _updateCitaStatus(bookingId, newStatus, traceId) {
    await _updateCitaSafe(
        bookingId,
        (cita) => {
            if (
                String(
                    cita[BOOKING_FIELDS.STATUS] || ""
                ).toUpperCase() ===
                String(newStatus || "").toUpperCase()
            ) {
                return null;
            }
            return {
                ...cita,
                [BOOKING_FIELDS.STATUS]: String(
                    newStatus || BOOKING_STATUS.CONFIRMED
                ).toUpperCase(),
            };
        },
        traceId,
        "events_updateCitaEstado"
    );
}

async function _markCitasRefundedByBookingIds(
    bookingIds,
    orderId,
    refundId,
    fullyRefunded,
    traceId
) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(
                bookingId,
                (cita) => {
                    const meta = cita.meta || {};
                    const paymentState = fullyRefunded
                        ? PAYMENT_STATUS.REFUNDED
                        : PAYMENT_STATUS.PARTIALLY_REFUNDED;
                    return {
                        ...cita,
                        ...(fullyRefunded
                            ? {
                                  [BOOKING_FIELDS.STATUS]:
                                      BOOKING_STATUS.REFUNDED,
                              }
                            : {}),
                        [BOOKING_FIELDS.PAYMENT_STATUS]: paymentState,
                        meta: {
                            ...meta,
                            paymentStatus: paymentState,
                            orderId: orderId || null,
                            refundId: refundId || null,
                            fechaReembolso: new Date(),
                        },
                    };
                },
                traceId,
                "events_markRefunded"
            )
        )
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update refund status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

/**
 * EVE-16: orderId solo en meta. NO es campo fisico de CitasF2
 * (CMS KEY FIELDS). cashMovementId si lo es y se mantiene.
 */
async function _markCitasPaidByBookingIds(
    bookingIds,
    orderId,
    cashMovementId,
    traceId
) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(
                bookingId,
                (cita) => {
                    const meta = cita.meta || {};
                    const alreadyPaid =
                        String(
                            meta.paymentStatus || cita.paymentStatus || ""
                        ).toUpperCase() === PAYMENT_STATUS.PAID;
                    // Idempotencia: si ya esta pagada con el MISMO movimiento
                    // de caja, no reescribir.
                    if (
                        alreadyPaid &&
                        cita.cashMovementId === cashMovementId
                    )
                        return null;
                    return {
                        ...cita,
                        [BOOKING_FIELDS.STATUS]: BOOKING_STATUS.CONFIRMED,
                        [BOOKING_FIELDS.PAYMENT_STATUS]:
                            PAYMENT_STATUS.PAID,
                        // SSOT: proyeccion canonica del enlace fiscal.
                        cashMovementId: cashMovementId || null,
                        // EVE-16: orderId NO se escribe como campo fisico.
                        traceId,
                        meta: {
                            ...meta,
                            paymentStatus: PAYMENT_STATUS.PAID,
                            cashMovementId: cashMovementId || null,
                            orderId: orderId || null,
                            fechaConfirmacionPago: new Date(),
                            traceId,
                        },
                    };
                },
                traceId,
                "events_markPaid"
            )
        )
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update payment status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

async function _markCitasPendingLedgerByBookingIds(
    bookingIds,
    orderId,
    traceId
) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(
                bookingId,
                (cita) => {
                    const meta = cita.meta || {};
                    const currentPaymentState = String(
                        meta.paymentStatus || cita.paymentStatus || ""
                    ).toUpperCase();
                    if (currentPaymentState === PAYMENT_STATUS.PAID)
                        return null;
                    return {
                        ...cita,
                        [BOOKING_FIELDS.PAYMENT_STATUS]:
                            PAYMENT_STATUS.PENDING_LEDGER,
                        meta: {
                            ...meta,
                            paymentStatus: PAYMENT_STATUS.PENDING_LEDGER,
                            orderId: orderId || null,
                            fechaPagoRecibido: new Date(),
                        },
                    };
                },
                traceId,
                "events_markPendingLedger"
            )
        )
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update pending ledger status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

// ============================================================================
// WEBHOOK: BOOKING CONFIRMED
// ============================================================================
export async function wixBookingsV2_onBookingConfirmed(rawBody) {
    const traceId = makeTraceId("whook-conf");
    try {
        const event = await _verifyAndDecodeWebhook(
            rawBody,
            "BOOKING_CONFIRMED"
        );
        if (!event)
            return {
                status: "REJECTED",
                reason: "JWT_VERIFICATION_FAILED",
            };
        const eventId =
            event?.eventId ||
            event?._id ||
            `conf-${event?.booking?.id || Date.now()}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", {
                eventId,
                eventType: "BOOKING_CONFIRMED",
            });
            return { status: "OK", duplicate: true };
        }
        const valid = validateEventStructure(event, [
            "booking.id",
            "booking.status",
        ]);
        if (!valid) {
            log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
            await markEventAsProcessed(
                eventId,
                "BOOKING_CONFIRMED_INVALID",
                traceId,
                { rejected: true }
            );
            return { status: "OK", rejected: true };
        }
        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        await _updateCitaStatus(
            bookingId,
            BOOKING_STATUS.CONFIRMED,
            traceId
        );
        await markEventAsProcessed(eventId, "BOOKING_CONFIRMED", traceId, {
            bookingId,
        });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingConfirmed", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: BOOKING CANCELED -- RECTIFICATIVA via eventLog
// ============================================================================
export async function wixBookingsV2_onBookingCanceled(rawBody) {
    const traceId = makeTraceId("whook-cancel");
    try {
        const event = await _verifyAndDecodeWebhook(
            rawBody,
            "BOOKING_CANCELED"
        );
        if (!event)
            return {
                status: "REJECTED",
                reason: "JWT_VERIFICATION_FAILED",
            };
        const eventId =
            event?.eventId ||
            event?._id ||
            `cancel-${event?.booking?.id || Date.now()}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", {
                eventId,
                eventType: "BOOKING_CANCELED",
            });
            return { status: "OK", duplicate: true };
        }
        const valid = validateEventStructure(event, ["booking.id"]);
        if (!valid) {
            log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
            await markEventAsProcessed(
                eventId,
                "BOOKING_CANCELED_INVALID",
                traceId,
                { rejected: true }
            );
            return { status: "OK", rejected: true };
        }
        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        // Si la cita previa estaba PAID, generar rectificativa.
        // EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
        const previousCita = await wixData
            .query(BUSINESS_COLLECTIONS.CITAS_F2)
            .eq("bookingId", bookingId)
            .limit(1)
            .find(STRONG_READ)
            .then((r) => r?.items?.[0] || null)
            .catch(() => null);
        if (
            previousCita &&
            String(previousCita.paymentStatus || "").toUpperCase() ===
                PAYMENT_STATUS.PAID
        ) {
            // EVE-11: buscar por bookingId con fallback a linkedBookingIds.
            const originalMovement =
                await _findOriginalOnlineMovement(bookingId);
            if (originalMovement) {
                // EVE-10/18: lectura normalizada con keys reales CMS.
                const fiscalRead =
                    _readOriginalMovementFiscal(originalMovement);
                try {
                    const emisor = await _getEmisorFiscal();
                    const amountOriginal = Math.abs(fiscalRead.totalAmount);
                    // EVE-13/14: WIX_PAYMENTS + CHANNEL_TYPE.ONLINE.
                    const eventResult = await registrarEventoEconomico({
                        eventType: EVENT_TYPE.RECTIFICATIVA,
                        movementType: MOVEMENT_TYPE.REEMBOLSO,
                        paymentMethod:
                            fiscalRead.paymentMethod ||
                            PAYMENT_METHOD.WIX_PAYMENTS,
                        totalAmount: -amountOriginal,
                        taxableBaseOrNonSubjectAmount: -Math.abs(
                            fiscalRead.base
                        ),
                        taxAmount: -Math.abs(fiscalRead.cuota),
                        taxRate: fiscalRead.tipo,
                        operationDescription: `Rectificacion cancelacion booking ${bookingId}`,
                        invoiceNumber: fiscalRead.numSerieFactura,
                        invoiceIssueDate: new Date().toLocaleDateString(
                            "sv-SE",
                            { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }
                        ),
                        invoiceType: TIPO_FACTURA.R1,
                        correctionType: "I",
                        previousInvoiceId:
                            fiscalRead.numSerieFactura || null,
                        previousInvoiceNumber:
                            fiscalRead.numSerieFactura || null,
                        previousInvoiceIssueDate:
                            fiscalRead.fechaExpedicionFactura || null,
                        correctionReason: CORRECTION_REASON.NUMERO_SERIE,
                        issuerTaxId: emisor.issuerTaxId,
                        issuerLegalName: emisor.issuerLegalName,
                        recipientTaxId: fiscalRead.nifDestinatario,
                        recipientLegalName: fiscalRead.recipientLegalName,
                        fiscalRole: FISCAL_ROLE.EMISOR,
                        channelType: CHANNEL_TYPE.ONLINE,
                        linkedBookingIds: bookingId,
                        transactionId: `RECT-${bookingId}`,
                        orderId: fiscalRead.orderId || null,
                        traceId,
                    });
                    if (
                        eventResult.status !== "SUCCESS" &&
                        eventResult.status !== "PARTIAL"
                    ) {
                        throw new Error(
                            eventResult.error?.message ||
                                "EVENTLOG_RECT_FAIL"
                        );
                    }
                } catch (rectErr) {
                    log.error(
                        "Rectification ledger failed; queuing recovery",
                        {
                            bookingId,
                            traceId,
                            error: rectErr?.message,
                        }
                    );
                    // EVE-13: WIX_PAYMENTS en recovery.
                    await queueFiscalRecovery({
                        bookingIds: bookingId,
                        totalAmount: -Math.abs(fiscalRead.totalAmount),
                        paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
                        transactionId: `RECT-${bookingId}`,
                        orderId: fiscalRead.orderId || null,
                        origin: "WIX_BOOKINGS_CANCEL_WEBHOOK",
                        operationDescription: `Rectificacion cancelacion booking ${bookingId}`,
                        resourceId: "online",
                        movementType: MOVEMENT_TYPE.REEMBOLSO,
                        traceId,
                        lastError: rectErr?.message || "RECT_FAIL",
                    });
                }
            }
        }
        await _updateCitaStatus(
            bookingId,
            BOOKING_STATUS.CANCELED,
            traceId
        );
        await markEventAsProcessed(eventId, "BOOKING_CANCELED", traceId, {
            bookingId,
        });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingCanceled", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER PAYMENT STATUS UPDATED -- via eventLog
// ============================================================================
export async function wixEcom_onOrderPaymentStatusUpdated(rawBody) {
    const traceId = makeTraceId("whook-pay-status");
    try {
        const event = await _verifyAndDecodeWebhook(
            rawBody,
            "ORDER_PAYMENT_STATUS_UPDATED"
        );
        if (!event)
            return {
                status: "REJECTED",
                reason: "JWT_VERIFICATION_FAILED",
            };
        const eventId = event?.eventId || event?._id;
        if (eventId) {
            const alreadyProcessed = await isEventProcessed(eventId);
            if (alreadyProcessed) {
                log.info("EVENT_DUPLICATE_IGNORED", {
                    eventId,
                    eventType: "ORDER_PAYMENT_STATUS_UPDATED",
                });
                return { status: "OK", duplicate: true };
            }
        }
        const order =
            event?.order ||
            event?.data?.order ||
            event?.entity ||
            event ||
            {};
        const orderId = String(order?._id || order?.id || "").trim();
        if (!orderId || orderId === "unknown") {
            log.warn("PAYMENT_WEBHOOK_MISSING_ORDER_ID", {
                traceId,
                eventId,
            });
            return { status: "OK" };
        }
        const paymentStatusRaw = order.paymentStatus || "";
        const paymentStatus = String(paymentStatusRaw).toUpperCase();
        const isPaidStatus = [
            "PAID",
            "FULLY_PAID",
            "PAID_FULL",
        ].includes(paymentStatus);
        if (!isPaidStatus) return { status: "OK" };
        const lineItems = Array.isArray(order.lineItems)
            ? order.lineItems
            : [];
        const bookingsAppId = APP_IDS.BOOKINGS;
        const bookingLineItems = lineItems.filter(
            (item) => item?.catalogReference?.appId === bookingsAppId
        );
        const bookingIds = _normalizeBookingIds(
            bookingLineItems.map(
                (item) => item?.catalogReference?.catalogItemId
            )
        );
        const linkedBookingIds = bookingIds.join(",");
        const orderTotal =
            Number(
                order?.priceSummary?.total?.amount ??
                    order?.totals?.total?.amount ??
                    0
            ) || 0;
        const lineItemsTotal = lineItems.reduce((sum, item) => {
            const itemPrice =
                Number(
                    item?.price?.amount ??
                        item?.price ??
                        item?.totalPrice?.amount ??
                        0
                ) || 0;
            return sum + itemPrice * (Number(item?.quantity) || 1);
        }, 0);
        const finalLedgerAmount =
            orderTotal > 0 ? orderTotal : lineItemsTotal;
        const transactionId = `ORDER-${orderId}`;
        // EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
        const existingLedgerRes = await withTimeout(
            wixData
                .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("transactionId", transactionId)
                .limit(1)
                .find(STRONG_READ),
            API_TIMEOUT_MS,
            "checkExistingLedgerPreflight"
        ).catch(() => ({ items: [] }));
        if (existingLedgerRes?.items?.length > 0) {
            if (bookingIds.length) {
                // SSOT v20.1: reutilizar la cabecera del ledger existente para
                // no perder el enlace fiscal cashMovementId en el webhook duplicado.
                const existingCashMovementId =
                    existingLedgerRes.items[0]?.cabeceraId ||
                    existingLedgerRes.items[0]?._id ||
                    null;
                await _executeWithRetry(
                    async () => {
                        await _markCitasPaidByBookingIds(
                            bookingIds,
                            orderId,
                            existingCashMovementId,
                            traceId
                        );
                    },
                    WEBHOOK_RETRIES,
                    WEBHOOK_RETRY_DELAY_MS
                );
            }
            if (eventId) {
                await markEventAsProcessed(
                    eventId,
                    "ORDER_PAYMENT_STATUS_UPDATED",
                    traceId,
                    { orderId, idempotent: true }
                );
            }
            return { status: "OK" };
        }
        if (bookingIds.length) {
            await _executeWithRetry(
                async () => {
                    await _markCitasPendingLedgerByBookingIds(
                        bookingIds,
                        orderId,
                        traceId
                    );
                },
                WEBHOOK_RETRIES,
                WEBHOOK_RETRY_DELAY_MS
            );
        }
        if (finalLedgerAmount <= 0) {
            if (bookingIds.length) {
                await _executeWithRetry(
                    async () => {
                        // Zero-amount orders have no ledger cash movement; the
                        // projection is explicitly null-linked (auditoria 5.2).
                        await _markCitasPaidByBookingIds(
                            bookingIds,
                            orderId,
                            null,
                            traceId
                        );
                    },
                    WEBHOOK_RETRIES,
                    WEBHOOK_RETRY_DELAY_MS
                );
            }
            if (eventId) {
                await markEventAsProcessed(
                    eventId,
                    "ORDER_PAYMENT_STATUS_UPDATED",
                    traceId,
                    { orderId, zeroAmount: true }
                );
            }
            return { status: "OK" };
        }
        const orderConcept =
            bookingIds.length > 0
                ? lineItems.length > bookingIds.length
                    ? `Pedido Mixto Cita + Tienda ${orderId}`
                    : `Reserva Online ${orderId}`
                : `Venta Online Tienda ${orderId}`;
        // SSOT v20.1 / auditoria 5.3: fiscalidad online coherente. El importe
        // del ledger es IVA INCLUIDO, por lo que base y cuota se derivan del
        // total con el tipo general (IVA_RATES.GENERAL).
        const onlineTaxRate = IVA_RATES.GENERAL;
        const onlineTaxableBase =
            Math.round((finalLedgerAmount / (1 + onlineTaxRate)) * 100) / 100;
        const onlineTaxAmount =
            Math.round((finalLedgerAmount - onlineTaxableBase) * 100) / 100;
        // Extraer datos fiscales AEAT.
        const fiscalData = _extractFiscalDataFromOrder(order);
        const emisor = await _getEmisorFiscal();
        // Registrar evento canonico.
        let eventResult;
        try {
            // EVE-13/14: WIX_PAYMENTS + CHANNEL_TYPE.ONLINE.
            eventResult = await registrarEventoEconomico({
                eventType: EVENT_TYPE.VENTA_LINEA,
                movementType: MOVEMENT_TYPE.VENTA_ONLINE,
                paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
                channelType: CHANNEL_TYPE.ONLINE,
                resourceId: "online",
                totalAmount: finalLedgerAmount,
                taxableBaseOrNonSubjectAmount:
                    fiscalData.withholdingBase > 0
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
                invoiceType: fiscalData.isB2B
                    ? TIPO_FACTURA.F1
                    : TIPO_FACTURA.F2,
                issuerTaxId: emisor.issuerTaxId,
                issuerLegalName: emisor.issuerLegalName,
                recipientTaxId: fiscalData.recipientTaxId,
                recipientLegalName: fiscalData.recipientLegalName,
                recipientAddress: fiscalData.recipientAddress,
                isB2B: fiscalData.isB2B,
                bankReconciliationReference:
                    fiscalData.bankReconciliationReference,
                fiscalRole: fiscalData.fiscalRole || FISCAL_ROLE.EMISOR,
                vatAccrualStatus: VAT_ACCRUAL_STATUS.DEVENGADO,
                linkedBookingIds: linkedBookingIds || null,
                transactionId,
                orderId,
                breakdown: [
                    {
                        taxableBaseOrNonSubjectAmount:
                            fiscalData.withholdingBase > 0
                                ? fiscalData.withholdingBase
                                : onlineTaxableBase,
                        taxRate: onlineTaxRate,
                        chargedTaxAmount: onlineTaxAmount,
                        operationDescription: orderConcept,
                        units: 1,
                        magnitude: 1,
                    },
                ],
                traceId,
            });
        } catch (err) {
            log.error("registrarEventoEconomico fallo", {
                orderId,
                traceId,
                error: err?.message,
            });
            eventResult = {
                status: "ERROR",
                error: { message: err?.message },
            };
        }
        const ledgerOk =
            eventResult?.status === "SUCCESS" ||
            eventResult?.status === "PARTIAL";
        // SSOT v20.1 / auditoria 5.2: una cita no puede proyectarse como
        // pagada sin la referencia del movimiento fiscal append-only.
        const cashMovementId = ledgerOk
            ? eventResult?.data?.cabeceraId || null
            : null;
        if (ledgerOk && bookingIds.length && !cashMovementId) {
            log.error("LEDGER_REFERENCE_MISSING", { orderId, traceId });
            await logAuditEventWithTimeout(
                "LEDGER_REFERENCE_MISSING",
                "ERROR",
                `Ledger registrado sin cabecera para orden ${orderId}`,
                { orderId, traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
            return {
                status: "ERROR",
                error: {
                    code: "LEDGER_REFERENCE_MISSING",
                    message:
                        "Ledger registered without cash movement reference.",
                },
            };
        }
        if (ledgerOk) {
            // [FIX-56] Inventario DESPUES del ledger.
            try {
                await recordOnlineInventoryOrderInternal(order, traceId);
            } catch (inventoryError) {
                log.error("Online inventory mirror failed", {
                    orderId,
                    traceId,
                    error:
                        inventoryError?.message || String(inventoryError),
                });
                await logAuditEventWithTimeout(
                    "INVENTORY_MIRROR_FAILED",
                    "ERROR",
                    `Inventario no descontado para orden ${orderId} tras ledger OK`,
                    {
                        orderId,
                        traceId,
                        error:
                            inventoryError?.message ||
                            String(inventoryError),
                    },
                    traceId,
                    orderId,
                    "backend/events.js"
                );
            }
            if (bookingIds.length) {
                await _executeWithRetry(
                    async () => {
                        await _markCitasPaidByBookingIds(
                            bookingIds,
                            orderId,
                            cashMovementId,
                            traceId
                        );
                    },
                    WEBHOOK_RETRIES,
                    WEBHOOK_RETRY_DELAY_MS
                );
            }
            if (eventId) {
                await markEventAsProcessed(
                    eventId,
                    "ORDER_PAYMENT_STATUS_UPDATED",
                    traceId,
                    { orderId }
                );
            }
            return { status: "OK" };
        }
        // EVE-13: WIX_PAYMENTS en recovery.
        await queueFiscalRecovery({
            bookingIds: linkedBookingIds,
            totalAmount: finalLedgerAmount,
            paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
            transactionId,
            orderId,
            origin: "WIX_ECOM_PAYMENT_WEBHOOK",
            operationDescription: orderConcept,
            resourceId: "online",
            movementType: MOVEMENT_TYPE.VENTA_ONLINE,
            traceId,
            lastError:
                eventResult?.error?.message || "LEDGER_REGISTRATION_FAILED",
        });
        await logAuditEventWithTimeout(
            "LEDGER_REGISTRATION_FAILED",
            "ERROR",
            `Ledger registration queued for order ${orderId}`,
            {
                orderId,
                bookingIds,
                ledgerError: eventResult?.error || "Unknown error",
                traceId,
            },
            traceId,
            orderId,
            "backend/events.js"
        );
        return { status: "OK" };
    } catch (error) {
        const normalized = _handleError(
            error,
            "wixEcom_onOrderPaymentStatusUpdated",
            traceId
        );
        await logAuditEventWithTimeout(
            "WEBHOOK_CRITICAL_ERROR",
            "ERROR",
            `Critical error in webhook: ${normalized.message}`,
            { error: normalized.message, traceId },
            traceId,
            "system",
            "backend/events.js"
        );
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER REFUNDED -- via eventLog (EVE-12: dedupe anadido)
// ============================================================================
export async function wixEcom_onOrderRefunded(rawBody) {
    const traceId = makeTraceId("whook-refund");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_REFUNDED");
        if (!event)
            return {
                status: "REJECTED",
                reason: "JWT_VERIFICATION_FAILED",
            };
        const orderId =
            String(event?.orderId || event?.order?._id || "").trim() ||
            "unknown";
        const refundObj = event?.refund || event?.data?.refund || null;
        if (!refundObj || orderId === "unknown") return { status: "OK" };
        const rawAmount =
            typeof refundObj?.amount === "object" &&
            refundObj?.amount !== null
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
                traceId,
                orderId,
                "backend/events.js"
            );
            return { status: "OK" };
        }
        // EVE-12: dedupe por eventId. Sin esto, un replay de Wix duplica
        // rectificativa, inventario y marcas de reembolso.
        const eventId =
            event?.eventId || event?._id || `refund-${refundId}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", {
                eventId,
                eventType: "ORDER_REFUNDED",
            });
            return { status: "OK", duplicate: true };
        }
        const transactionId = `REFUND-${orderId}-${refundId}`;
        const originalTransactionId = `ORDER-${orderId}`;
        // EVE-19/20: dataLegacyAdapter + STRONG_READ. Sin suppressAuth.
        const originalMovementRes = await withTimeout(
            wixData
                .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("transactionId", originalTransactionId)
                .limit(1)
                .find(STRONG_READ),
            API_TIMEOUT_MS,
            "queryOriginalMovement"
        ).catch(() => ({ items: [] }));
        const originalMovement = originalMovementRes.items?.[0];
        if (!originalMovement) {
            // EVE-13: WIX_PAYMENTS en recovery.
            await queueFiscalRecovery({
                bookingIds: "",
                totalAmount: -refundAmount,
                paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                operationDescription: `Refund - Order ${orderId}`,
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
                traceId,
                orderId,
                "backend/events.js"
            );
            // EVE-12: marcar como procesado tras encolar recovery.
            await markEventAsProcessed(
                eventId,
                "ORDER_REFUNDED",
                traceId,
                { orderId, refundId, queued: true }
            );
            return { status: "OK" };
        }
        // EVE-10/18: lectura normalizada con keys reales CMS.
        const fiscalRead = _readOriginalMovementFiscal(originalMovement);
        const originalAmount = Math.abs(fiscalRead.totalAmount);
        const linkedBookingIds = _normalizeBookingIds(
            fiscalRead.linkedBookingIds
        );
        // Path canonico restockInfo.
        let refundRestockInfo = event?.sideEffects?.restockInfo || null;
        if (!refundRestockInfo) {
            const fallbackPath =
                (event?.data?.sideEffects?.restockInfo &&
                    "event.data.sideEffects") ||
                (refundObj?.sideEffects?.restockInfo &&
                    "refund.sideEffects") ||
                null;
            if (fallbackPath) {
                log.warn("REFUND_RESTOCK_INFO_FALLBACK_PATH", {
                    orderId,
                    refundId,
                    fallbackPath,
                    hint: "Path canonico: event.sideEffects.restockInfo",
                    traceId,
                });
                refundRestockInfo =
                    (fallbackPath === "event.data.sideEffects" &&
                        event.data.sideEffects.restockInfo) ||
                    (fallbackPath === "refund.sideEffects" &&
                        refundObj.sideEffects.restockInfo) ||
                    null;
            }
        }
        const refundOrder =
            event?.order ||
            event?.data?.order ||
            {
                _id: orderId,
                lineItems:
                    event?.lineItems || event?.data?.lineItems || [],
            };
        try {
            const inventoryRefund =
                await recordOnlineInventoryRefundInternal(
                    refundOrder,
                    refundObj,
                    refundRestockInfo,
                    traceId
                );
            if (
                inventoryRefund?.status === "SKIPPED" &&
                inventoryRefund?.reason !== "NO_CONFIRMED_RESTOCK"
            ) {
                await logAuditEventWithTimeout(
                    "REFUND_INVENTORY_TRACE_SKIPPED",
                    "WARN",
                    `Inventory trace skipped for refund ${refundId}`,
                    {
                        orderId,
                        refundId,
                        reason: inventoryRefund.reason,
                        traceId,
                    },
                    traceId,
                    orderId,
                    "backend/events.js"
                );
            }
        } catch (inventoryRefundError) {
            await logAuditEventWithTimeout(
                "REFUND_INVENTORY_TRACE_FAILED",
                "ERROR",
                `Inventory trace failed for refund ${refundId}`,
                {
                    orderId,
                    refundId,
                    error:
                        inventoryRefundError?.message ||
                        String(inventoryRefundError),
                    traceId,
                },
                traceId,
                orderId,
                "backend/events.js"
            );
        }
        // Registrar RECTIFICATIVA via eventLog.
        const emisor = await _getEmisorFiscal();
        const todayDate = new Date().toLocaleDateString("sv-SE", {
            timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        });
        let eventResult;
        try {
            // EVE-13/14: WIX_PAYMENTS + CHANNEL_TYPE.ONLINE.
            // EVE-17: breakdown unificado a forma canonica de venta.
            eventResult = await registrarEventoEconomico({
                eventType: EVENT_TYPE.RECTIFICATIVA,
                movementType: MOVEMENT_TYPE.REEMBOLSO,
                paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
                channelType: CHANNEL_TYPE.ONLINE,
                resourceId: "online",
                totalAmount: -refundAmount,
                taxableBaseOrNonSubjectAmount: -Math.abs(fiscalRead.base),
                taxAmount: -Math.abs(fiscalRead.cuota),
                taxRate: fiscalRead.tipo,
                operationDescription: `Refund - Order ${orderId}`,
                invoiceNumber: fiscalRead.numSerieFactura,
                invoiceIssueDate: todayDate,
                invoiceType: TIPO_FACTURA.R1,
                correctionType: "I",
                previousInvoiceId: fiscalRead.numSerieFactura || null,
                previousInvoiceNumber: fiscalRead.numSerieFactura || null,
                previousInvoiceIssueDate:
                    fiscalRead.fechaExpedicionFactura || null,
                correctionReason: CORRECTION_REASON.OTRAS,
                issuerTaxId: emisor.issuerTaxId,
                issuerLegalName: emisor.issuerLegalName,
                recipientTaxId: fiscalRead.nifDestinatario,
                recipientLegalName: fiscalRead.recipientLegalName,
                fiscalRole: FISCAL_ROLE.EMISOR,
                linkedBookingIds: linkedBookingIds.join(",") || null,
                transactionId,
                orderId,
                refundId,
                // EVE-17: claves unificadas a forma canonica de venta.
                breakdown: [
                    {
                        taxableBaseOrNonSubjectAmount: -Math.abs(
                            fiscalRead.base
                        ),
                        taxRate: fiscalRead.tipo,
                        chargedTaxAmount: -Math.abs(fiscalRead.cuota),
                        operationDescription: `Refund - Order ${orderId}`,
                        units: 1,
                        magnitude: -1,
                    },
                ],
                traceId,
            });
        } catch (err) {
            log.error("registrarEventoEconomico refund fallo", {
                orderId,
                refundId,
                traceId,
                error: err?.message,
            });
            eventResult = {
                status: "ERROR",
                error: { message: err?.message },
            };
        }
        const ledgerOk =
            eventResult?.status === "SUCCESS" ||
            eventResult?.status === "PARTIAL";
        if (!ledgerOk) {
            // EVE-13: WIX_PAYMENTS en recovery.
            await queueFiscalRecovery({
                bookingIds: linkedBookingIds.join(","),
                totalAmount: -refundAmount,
                paymentMethod: PAYMENT_METHOD.WIX_PAYMENTS,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                operationDescription: `Refund - Order ${orderId}`,
                resourceId: "online",
                movementType: MOVEMENT_TYPE.REEMBOLSO,
                traceId,
                lastError:
                    eventResult?.error?.message ||
                    "REFUND_LEDGER_REGISTRATION_FAILED",
            });
            await logAuditEventWithTimeout(
                "REFUND_LEDGER_REGISTRATION_FAILED",
                "ERROR",
                `Refund ledger queued for order ${orderId}`,
                { orderId, refundId, traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
            // EVE-12: marcar como procesado tras encolar recovery.
            await markEventAsProcessed(
                eventId,
                "ORDER_REFUNDED",
                traceId,
                { orderId, refundId, ledgerQueued: true }
            );
            return { status: "OK" };
        }
        // EVE-19/20: dataLegacyAdapter + STRONG_READ.
        const refundsRes = await withTimeout(
            wixData
                .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("orderId", orderId)
                .eq("movementType", MOVEMENT_TYPE.REEMBOLSO)
                .limit(100)
                .find(STRONG_READ),
            API_TIMEOUT_MS,
            "queryRefundsForOrder"
        );
        const refundedTotal = (refundsRes?.items || []).reduce(
            (sum, movement) =>
                sum +
                Math.abs(
                    Number(
                        movement?.accountingAmount ??
                            movement?.totalAmount ??
                            0
                    )
                ),
            0
        );
        const fullyRefunded =
            originalAmount > 0 && refundedTotal >= originalAmount;
        await _markCitasRefundedByBookingIds(
            linkedBookingIds,
            orderId,
            refundId,
            fullyRefunded,
            traceId
        );
        // EVE-12: marcar como procesado tras completar exitosamente.
        await markEventAsProcessed(eventId, "ORDER_REFUNDED", traceId, {
            orderId,
            refundId,
            fullyRefunded,
        });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderRefunded", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER CANCELED
// ============================================================================
export async function wixEcom_onOrderCanceled(rawBody) {
    const traceId = makeTraceId("whook-order-cancel");
    try {
        const event = await _verifyAndDecodeWebhook(
            rawBody,
            "ORDER_CANCELED"
        );
        if (!event)
            return {
                status: "REJECTED",
                reason: "JWT_VERIFICATION_FAILED",
            };
        const order = event?.order || event?.data?.order || event || {};
        const orderId =
            String(order?._id || order?.id || "").trim() || "unknown";
        if (orderId === "unknown") return { status: "OK" };
        const eventId =
            event?.eventId || event?._id || `cancel-order-${orderId}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", {
                eventId,
                eventType: "ORDER_CANCELED",
            });
            return { status: "OK", duplicate: true };
        }
        const lineItems = Array.isArray(order.lineItems)
            ? order.lineItems
            : [];
        const bookingsAppId = APP_IDS.BOOKINGS;
        const bookingIds = _normalizeBookingIds(
            lineItems
                .filter(
                    (item) =>
                        item?.catalogReference?.appId === bookingsAppId
                )
                .map((item) => item?.catalogReference?.catalogItemId)
        );
        for (const bId of bookingIds) {
            await _updateCitaStatus(
                bId,
                BOOKING_STATUS.CANCELED,
                traceId
            );
        }
        await markEventAsProcessed(eventId, "ORDER_CANCELED", traceId, {
            orderId,
            bookingIds,
        });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderCanceled", traceId);
        return { status: "OK" };
    }
}
