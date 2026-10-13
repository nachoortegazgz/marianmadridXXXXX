/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5013-CMS-FINAL
BASE: v5012-ALIGNED-UTILS06 + correcciones P0/P1 de alineacion CMS y Biblia
RESPONSIBILITY: Orquestador transaccional de reservas (simple y dual con gap)
  sobre Bookings Writer V2. Saga con pasos compensables: locks -> createBooking
  F1/F2 -> checkout/confirm -> persistencia CitasF2.
STANDARDS: G10 ASCII estricto. Cero suppressHooks/suppressAuth.
CONTRATO: Reserva dual = DOS createBooking independientes unidos por pairToken.
  Multiservice Booking PROHIBIDO (BIBLIA 3.6). F2 es NO_FEE (BIBLIA 11.2).
VERIFICACION OFICIAL (dev.wix.com, Bookings Writer V2):
  - cancelBooking/declineBooking exigen revision como STRING (formato int64).
  - confirmOrDeclineBooking: solo con checkout propio (rama presencial). Con
    Wix eCommerce checkout el estado se sincroniza desde la orden; la rama
    online de esta saga NUNCA lo llama.
  - createBooking crea con paymentStatus=UNDEFINED ignorando el especificado.
FIXES APLICADOS v5013-CMS-FINAL:
  SAGA-22 (P0): _validateLinkedPhaseService ya NO rechaza el servicio F2 por
    clientHidden=true. Los servicios F2 son ocultos por diseno (BIBLIA,
    resumen ejecutivo: 24 servicios F2 ocultos). El check anterior bloqueaba
    TODA reserva dual. La visibilidad publica se controla en los entry points
    de reservas.web.js sobre el servicio padre, nunca sobre el F2 enlazado.
  SAGA-23 (P0): _detectAddons lee la key fisica real "addonId" de
    ComplementosCatalogo (CMS KEY FIELDS), con fallback a "addOnId" (matriz
    legacy) y "_id"/"id" (Multi Reference sin expandir). Antes solo leia
    addOnId y rechazaba TODA reserva con add-ons contra catalogo no vacio.
  SAGA-24 (P1): duracion de F2 con precedencia totalDuration >
    phase1Duration > phase2Duration. exposureDuration se retira de la cadena:
    es el gap del PADRE, nunca la duracion propia del servicio F2.
  SAGA-25 (P1): F2 NO_FEE real (BIBLIA 11.2): skipAvailabilityValidation=true
    + skipSelectedPaymentOptionValidation=true, sin selectedPaymentOption y
    sin bookedAddOns en F2 (los add-ons pertenecen a F1). El checkout eCom
    incluye SOLO el bookingId de F1 (F2 no es facturable).
  SAGA-26 (P1): compensacion envia revision como STRING (contrato oficial
    de cancelBooking/declineBooking verificado en dev.wix.com).
  SAGA-27 (P1): CONFIRMED sale de NON_CANCELABLE_STATUSES en la compensacion
    inmediata de saga. BIBLIA 11.2: si F2 falla se cancela F1 aunque este
    confirmada. Estados terminales reales (CANCELED/REFUNDED/DECLINED/DONE/
    COMPLETE) siguen excluidos.
  SAGA-28 (P1): la compensacion en ControlOperativo proyecta los campos
    fisicos reales (CMS KEY FIELDS): kind, status, attempts, maxAttempts,
    nextRetryAt, lastError, serviceId, ademas de payloadJson. El job
    runPendingCompensationsJob puede consultar sin parsear JSON.
  SAGA-29 (P1): _deleteCitasByPairToken -> _cancelCitasByPairToken. CitasF2
    es ledger con beforeRemove BLOQUEADO (cms.v8 12.1): el remove nunca
    prosperaba y dejaba filas PENDING huerfanas. Ahora se marcan CANCELLED
    via _updateCitaSafe (append-only friendly).
  SAGA-30 (P1): suppliedPairToken solo se acepta desde metaCita (reanudacion
    server-side). El pairToken enviado por el cliente se ignora y se loguea
    (RELEASE CHECKLIST: "no confiar en pairToken enviado por frontend").
  SAGA-31 (P2): requestedChannel/isOnline se calculan una sola vez. Se
    persiste channelType en meta de CitasF2 (consumidor: citasManager
    _isOnlinePaymentAllowed).
  SAGA-32 (P2): contactDetails completo (bookingCore minimiza) y
    meta.rgpdConsent/meta.paymentMethod persistidos para auditoria y
    ownership por email.
  SAGA-33 (P2): import muerto _buildPairFingerprint eliminado (SAGA-19 lo
    sustituyo por _buildPairTokenDeterministic).
FIXES HEREDADOS v5012-ALIGNED-UTILS06: SAGA-18..SAGA-21.
FIXES HEREDADOS v5011/v5010.x/v5009: SAGA-02..SAGA-17, D3 (ver historial).
PENDIENTES (fuera de este pase):
  - Migracion dataLegacyAdapter -> backend/dataAccess (mutations).
  - DEPENDENCIA DE DESPLIEGUE: requiere reservas.web.js v10-CMS-FINAL que
    exporte _resolveServiceIdInternal y _resolveStaffForSlotInternal.
=============================================================================
*/
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
import wixData from "backend/dataLegacyAdapter";
import {
    COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONCURRENCY,
    SDK_CONFIG,
    SLOT_SEARCH,
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    CHANNEL_TYPE,
    COMPENSATION_KIND,
    COMPENSATION_STATUS,
    APP_IDS,
    BOOKING_FIELDS
} from "backend/internalConfig";
import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _stableSerialize,
    _hashKey,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _normalizeLocalIsoStr,
    _executeWithRetry,
    withTimeout
} from "public/mmUtils";
import { computeGapMinutes } from "backend/booking/bookingUtils";
import { logger } from "backend/logger";
import {
    cancelBookingElevated,
    confirmOrDeclineBookingElevated,
    createCheckoutElevated,
    getCheckoutUrlElevated,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    _renewLock,
    _initTransaction,
    _completeTransaction,
    _failTransaction,
    _persistBooking,
    _updateCitaSafe,
    _forceStaffInPristineSlot,
    _resolveScheduleIdForResource,
    _buildLockKeys,
    _buildBookedAddOns,
    createBookingError,
    normalizeError,
    ERROR_CODES,
    _extractCheckoutId,
    _buildPairTokenDeterministic
} from "backend/booking/bookingCore";
export { _extractCheckoutId };
import {
    _resolveServiceIdInternal,
    _invalidateCachesInternal,
    _getServiceBySlugOrIdInternal,
    _resolveStaffForSlotInternal
} from "backend/reservas.web.js";

const log = logger;

// =============================================================================
// CONSTANTES
// =============================================================================
const LOCK_TTL_MS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX) || 300000;
const HEARTBEAT_MS = Number(CONCURRENCY && CONCURRENCY.MS_LATIDO) || 15000;
const CITAS_COL = COLLECTIONS.CITAS_F2;
const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;
const COMPENSACIONES_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL) || 120
);
const BOOKING_CREATION_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.BOOKING_CREATION_MS) || 25000;
const CHECKOUT_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.CHECKOUT_MS) || 20000;
const API_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.API_MS) || 15000;
const MAX_ADDONS_PER_BOOKING = 5;
const MAX_COMPENSATION_ATTEMPTS = 5;
const COMPENSATION_RETRY_DELAY_MS = 60000;
const SKIP_AVAILABILITY_VALIDATION = false;
const PAYMENT_STATUS_NOT_PAID = _safeTrim(PAYMENT_STATUS.NOT_PAID);
const PAYMENT_STATUS_PENDING = _safeTrim(PAYMENT_STATUS.PENDING_PAYMENT);
const BOOKING_STATUS_CONFIRMED = _safeTrim(BOOKING_STATUS.CONFIRMED);
const BOOKING_STATUS_PENDING_PAYMENT = _safeTrim(
    BOOKING_STATUS.PENDING_PAYMENT || BOOKING_STATUS.PENDING
);
const CHANNEL_ONLINE = _safeTrim(CHANNEL_TYPE.ONLINE).toUpperCase();
const CHANNEL_PRESENCIAL = _safeTrim(CHANNEL_TYPE.PRESENCIAL).toUpperCase();
const BOOKING_PAYMENT_OPTION_ONLINE = "ONLINE";
// SAGA-27: CONFIRMED ya NO es no-cancelable en la compensacion inmediata de
// saga. BIBLIA 11.2: si F2 falla, F1 se cancela aunque Wix la haya confirmado
// al crearla. Solo los estados terminales reales quedan excluidos.
const NON_CANCELABLE_STATUSES = new Set(
    [
        BOOKING_STATUS.CANCELED,
        BOOKING_STATUS.REFUNDED,
        BOOKING_STATUS.DECLINED,
        "DONE",
        "COMPLETE"
    ]
        .map(function (v) { return _safeTrim(v).toUpperCase(); })
        .filter(Boolean)
);

// =============================================================================
// BLOCK 1 - PAIR TOKEN UNIFICADO (SAGA-02 + SAGA-19 + SAGA-30)
// =============================================================================
function _resolveStablePairToken(params) {
    const emailHash = _hashKey(_safeTrim(params.email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(params.serviceId),
        resourceId: _safeTrim(params.resourceId),
        f1Start: _safeTrim(params.f1Start),
        f2Start: _safeTrim(params.f2Start || "")
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt" + hash.slice(0, 32);
}

/**
 * SAGA-19: usa _buildPairTokenDeterministic (unica serializacion canonica).
 * Captura errores de _buildPairFingerprint (fechas invalidas, fases
 * solapadas) y los traduce a INVALID_PAYLOAD con mensaje claro.
 * SAGA-30: suppliedPairToken solo llega aqui desde metaCita (reanudacion
 * server-side). El pairToken del cliente se ignora en el call site.
 */
function _resolveUnifiedPairToken(params) {
    const supplied = _safeTrim(params.suppliedPairToken);
    if (supplied) return { pairToken: supplied, source: "SUPPLIED" };
    if (params.isDual && _looksLikeGuid(params.resourceId)) {
        let pairToken;
        try {
            pairToken = _buildPairTokenDeterministic({
                serviceId: params.serviceId,
                linkedPhases: params.linkedPhases,
                dateYmd: _safeTrim(params.f1Start).slice(0, 10),
                f1Start: params.f1Start,
                f1End: params.f1End,
                f2Start: params.f2Start,
                f2End: params.f2End,
                resourceId: params.resourceId
            });
        } catch (error) {
            log.error("SAGA-19: pair fingerprint rejected the dual payload", {
                traceId: params.traceId,
                error: error && error.message,
                serviceId: params.serviceId,
                linkedPhases: params.linkedPhases
            });
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Dual booking has invalid slot dates for pairToken fingerprint",
                { traceId: params.traceId }
            );
        }
        return { pairToken: pairToken, source: "FINGERPRINT" };
    }
    if (params.isDual) {
        log.warn(
            "SAGA-02: dual without supplied pairToken and without resourceId. " +
            "Falling back to STABLE token.",
            { traceId: params.traceId, serviceId: params.serviceId }
        );
    }
    return {
        pairToken: _resolveStablePairToken({
            serviceId: params.serviceId,
            resourceId: params.resourceId,
            f1Start: params.f1Start,
            f2Start: params.f2Start,
            email: params.email
        }),
        source: params.isDual ? "STABLE_DEGRADED" : "STABLE"
    };
}

// =============================================================================
// BLOCK 2 - PERSISTED META NORMALIZATION
// =============================================================================
export function _normalizePersistedMeta(meta) {
    if (!meta) return {};
    try {
        if (typeof meta === "string") {
            const parsed = JSON.parse(meta);
            return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
        }
        return (typeof meta === "object" && !Array.isArray(meta)) ? meta : {};
    } catch (_) {
        return {};
    }
}

// =============================================================================
// BLOCK 3 - UTILIDADES
// =============================================================================
function _isGuidOrNull(value) {
    const v = _safeTrim(value);
    if (!v) return null;
    return _looksLikeGuid(v) ? v : null;
}

function _extractRelationId(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value);
    if (Array.isArray(value)) return _extractRelationId(value[0]);
    if (typeof value === "object") return _safeTrim(value._id || value.id || "");
    return "";
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
    const keys = Array.isArray(lockKeys) ? lockKeys : [];
    for (let i = 0; i < keys.length; i++) {
        try {
            await _unlockSlotKey(keys[i], lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll: failed", {
                key: keys[i],
                error: e && e.message
            });
        }
    }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION (SAGA-26/27/28 + revision guard v5010.3)
// =============================================================================
async function _compensateCreatedBookings(createdBookings, traceId) {
    const list = Array.isArray(createdBookings) ? createdBookings : [];
    for (let i = 0; i < list.length; i++) {
        const booking = list[i];
        const bookingId = (booking && booking.bookingId) || (booking && booking.id);
        if (!bookingId) continue;
        const status = _safeTrim(
            (booking && booking[BOOKING_FIELDS.STATUS]) || (booking && booking.status)
        ).toUpperCase();
        if (status && NON_CANCELABLE_STATUSES.has(status)) {
            log.warn("Skipping compensation for terminal-state booking", {
                bookingId: bookingId,
                status: status,
                phase: (booking && booking.phase) || null,
                traceId: traceId
            });
            continue;
        }
        const revisionRaw = (booking && booking.revision !== undefined)
            ? booking.revision
            : ((booking && booking.revisionNumber !== undefined) ? booking.revisionNumber : NaN);
        const revision = Number(revisionRaw);
        const hasValidRevision = Number.isInteger(revision) && revision > 0;
        if (!hasValidRevision) {
            log.error("Compensation will require manual intervention: revision missing", {
                bookingId: String(bookingId),
                phase: (booking && booking.phase) || null,
                traceId: traceId,
                rawRevision: (booking && booking.revision !== undefined)
                    ? booking.revision
                    : ((booking && booking.revisionNumber !== undefined) ? booking.revisionNumber : "MISSING")
            });
        }
        // SAGA-26: la API oficial exige revision como STRING (formato int64).
        const cancelBody = hasValidRevision ? { revision: String(revision) } : {};
        try {
            if (!hasValidRevision) {
                throw new Error("REVISION_MISSING: manual compensation required");
            }
            await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return cancelBookingElevated(bookingId, cancelBody); },
                        API_TIMEOUT_MS,
                        "cancelBookingCompensation"
                    );
                },
                2,
                300
            );
            log.info("Compensated booking cancelled", {
                bookingId: bookingId,
                revision: revision,
                traceId: traceId
            });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing in ControlOperativo", {
                bookingId: bookingId,
                revision: hasValidRevision ? revision : null,
                traceId: traceId,
                error: cancelErr && cancelErr.message
            });
            const compDedupeKey = "COMP_" + COMPENSATION_KIND.CANCEL_BOOKING + "_" + bookingId;
            const lastErrorMessage = (cancelErr && cancelErr.message) || "UNKNOWN";
            try {
                // SAGA-28: campos fisicos reales de ControlOperativo
                // (CMS KEY FIELDS) + payloadJson para el detalle de fase.
                await wixData.insert(COMPENSACIONES_COL, {
                    controlType: CONTROL_TYPE.SYSTEM_FLAG,
                    dedupeKey: compDedupeKey,
                    bookingId: String(bookingId),
                    serviceId: _safeTrim(booking && booking.serviceId) || "",
                    kind: COMPENSATION_KIND.CANCEL_BOOKING,
                    status: _safeTrim(COMPENSATION_STATUS && COMPENSATION_STATUS.PENDING) || "PENDING",
                    attempts: 0,
                    maxAttempts: MAX_COMPENSATION_ATTEMPTS,
                    nextRetryAt: new Date(Date.now() + COMPENSATION_RETRY_DELAY_MS),
                    lastError: lastErrorMessage,
                    payloadJson: JSON.stringify({
                        compensationKind: COMPENSATION_KIND.CANCEL_BOOKING,
                        phase: (booking && booking.phase) || "UNKNOWN",
                        compensationStatus: COMPENSATION_STATUS.PENDING,
                        revision: hasValidRevision ? revision : null,
                        attempts: 0,
                        lastError: lastErrorMessage
                    }),
                    traceId: _safeTrim(traceId) || makeTraceId("comp")
                });
            } catch (queueErr) {
                log.error("Failed to queue compensation in ControlOperativo", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr && queueErr.message
                });
            }
        }
    }
}

// =============================================================================
// BLOCK 5 - SELECTIVE ELEVATION + TIMEOUT (FIX-37)
// =============================================================================
async function _createBookingWithSelectiveElevation(booking, options, traceId) {
    try {
        return await withTimeout(
            function () { return bookings.createBooking(booking, options); },
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking"
        );
    } catch (err) {
        const code = _safeTrim(
            (err && err.code) ||
            (err && err.details && err.details.applicationError && err.details.applicationError.code)
        ).toUpperCase();
        const isAccessDenied =
            code === "ACCESS_DENIED" ||
            String((err && err.message) || "").toUpperCase().indexOf("ACCESS_DENIED") >= 0;
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            function () { return auth.elevate(bookings.createBooking)(booking, options); },
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA (FIX-42 + SAGA-PATCH-05)
// =============================================================================
function _validateCreateBookingResponse(booking, phase, traceId) {
    const id = _safeTrim((booking && booking.id) || (booking && booking._id));
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase: phase,
            traceId: traceId,
            hasId: Boolean(booking && booking.id),
            hasUnderscoreId: Boolean(booking && booking._id)
        });
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            "Booking " + phase + " created but no valid ID returned",
            { traceId: traceId, phase: phase }
        );
    }
    const revisionRaw = (booking && booking.revision !== undefined)
        ? booking.revision
        : ((booking && booking.revisionNumber !== undefined) ? booking.revisionNumber : null);
    const revisionNum = Number(revisionRaw);
    const revision = (Number.isFinite(revisionNum) && revisionNum > 0) ? revisionNum : null;
    if (revision === null) {
        log.warn("CreateBooking returned no revision; manual compensation path if rollback needed", {
            phase: phase,
            traceId: traceId,
            bookingId: id
        });
    }
    return {
        bookingId: id,
        revision: revision,
        status: _safeTrim(booking && booking.bookingStatus) ||
            _safeTrim(booking && booking.status) || null
    };
}

// =============================================================================
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED (FIX-38)
// =============================================================================
function _checkDoubleBookingFlag(booking, phase, traceId) {
    if (booking && booking.doubleBooked === true) {
        log.warn("DOUBLE_BOOKING_DETECTED", {
            phase: phase,
            traceId: traceId,
            bookingId: (booking && booking.id) || (booking && booking._id)
        });
        return true;
    }
    return false;
}

// =============================================================================
// BLOCK 8 - VALIDACION EXPLICITA DE GAP MAXIMO (FIX-34)
// =============================================================================
function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    const f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    const f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);
    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: invalid dates",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    const f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);
    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: could not convert to UTC",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    const rawDiffMinutes = (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;
    if (rawDiffMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: F2 starts before F1 ends (" +
            rawDiffMinutes.toFixed(2) + " min)",
            { traceId: traceId, gapMinutes: rawDiffMinutes }
        );
    }
    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);
    if (gapMinutes === null || gapMinutes > MINUTOS_MAX_HUECO_DUAL) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: gap " + (gapMinutes === null ? "N/A" : gapMinutes.toFixed(2)) +
            " min exceeds MAX (" + MINUTOS_MAX_HUECO_DUAL + ")",
            { traceId: traceId, gapMinutes: gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL }
        );
    }
    return { gapMinutes: gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (SAGA-10 + SAGA-21 + SAGA-22/24)
// =============================================================================
/**
 * SAGA-22: el servicio F2 (linkedPhases) esta OCULTO por diseno
 * (clientHidden=true). NO se rechaza aqui. La visibilidad publica se
 * controla en los entry points de reservas.web.js sobre el servicio padre.
 *
 * SAGA-24: precedencia de duracion propia del servicio F2:
 *   1. totalDuration  (duracion real reservable del servicio F2)
 *   2. phase1Duration (el F2 no es dual: su fase 1 es su duracion)
 *   3. phase2Duration (fallback remoto)
 * exposureDuration NO aplica: es el gap del servicio PADRE.
 */
async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    const linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service: invalid GUID",
            { traceId: traceId, linkedPhases: linkedServiceId }
        );
    }
    const res = await wixData
        .query(SERVICIOS_COL)
        .eq("serviceId", linkedServiceId)
        .limit(1)
        .find()
        .catch(function () { return { items: [] }; });
    const service = (res && res.items && res.items[0]) || null;
    if (!service) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " not found in catalog",
            { traceId: traceId }
        );
    }
    // SAGA-22: clientHidden=true en F2 es ESPERADO. No se rechaza.
    if (service.clientHidden !== true) {
        log.info("Linked phase service is not hidden (verificar configuracion)", {
            linkedServiceId: linkedServiceId,
            traceId: traceId
        });
    }
    const serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " is not APPOINTMENT (type=" + serviceType + ")",
            { traceId: traceId }
        );
    }
    // SAGA-24: duracion propia del F2.
    const phase2Duration = Number(
        service.totalDuration ||
        service.phase1Duration ||
        service.phase2Duration ||
        0
    );
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has invalid duration (" + phase2Duration + ")",
            { traceId: traceId }
        );
    }
    const parentLoc = _safeTrim(parentLocationId);
    const f2Loc = _extractRelationId(service.locationId) || _safeTrim(service.location);
    if (
        parentLoc &&
        f2Loc &&
        _looksLikeGuid(parentLoc) &&
        _looksLikeGuid(f2Loc) &&
        parentLoc !== f2Loc
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has incompatible locationId",
            { traceId: traceId }
        );
    }
    return { service: service, phase2Duration: phase2Duration };
}

// =============================================================================
// BLOCK 10 - COMPENSACION DE PERSISTENCIA CMS (SAGA-29)
// =============================================================================
/**
 * SAGA-29: CitasF2 es ledger con beforeRemove BLOQUEADO (cms.v8 12.1).
 * La compensacion marca las filas del par como CANCELLED en lugar de
 * intentar un remove que el hook siempre rechazaria.
 */
async function _cancelCitasByPairToken(pairToken, traceId) {
    const token = _safeTrim(pairToken);
    if (!token) return;
    try {
        const res = await wixData
            .query(CITAS_COL)
            .eq(BOOKING_FIELDS.PAIR_TOKEN, token)
            .limit(10)
            .find({ consistencyMode: "strong" });
        const items = (res && res.items) || [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const bookingId = _safeTrim(item.bookingId);
            if (!bookingId) continue;
            const updateResult = await _updateCitaSafe(
                bookingId,
                function (cita) {
                    let meta = cita && cita.meta;
                    if (typeof meta === "string") {
                        try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
                    }
                    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
                    return Object.assign({}, cita, {
                        bookingStatus: "CANCELLED",
                        meta: Object.assign({}, meta, {
                            compensated: true,
                            compensatedAt: new Date().toISOString(),
                            compensationTraceId: _safeTrim(traceId)
                        })
                    });
                },
                traceId,
                "saga_compensate_cita"
            );
            if (updateResult && updateResult.updated) {
                log.info("Compensated CitaF2 marked CANCELLED", {
                    citaId: item._id,
                    bookingId: bookingId,
                    traceId: traceId
                });
            } else {
                log.error("Failed to compensate CitaF2", {
                    citaId: item._id,
                    bookingId: bookingId,
                    traceId: traceId,
                    reason: (updateResult && updateResult.reason) || "UNKNOWN"
                });
            }
        }
    } catch (err) {
        log.error("_cancelCitasByPairToken failed", {
            pairToken: token,
            traceId: traceId,
            error: err && err.message
        });
    }
}

// =============================================================================
// BLOCK 11 - ADDONS (SAGA-18 + SAGA-23)
// =============================================================================
/**
 * SAGA-18: deteccion y validacion de add-ons.
 *
 * Contrato de entrada unificado:
 *   - Frontend envia SOLO `addOnIds` (array de GUIDs).
 *   - metaCita.addOnIds para reanudacion de flujos persistidos.
 *   - NO se aceptan `bookedAddOns` ni `nativeAddonIds` desde el payload.
 *
 * Contrato de catalogo (SAGA-23):
 *   - serviceConfig.addOnOptions a RAIZ del DTO de reservas.web.js.
 *   - Key fisica real en ComplementosCatalogo: "addonId" (CMS KEY FIELDS).
 *     Fallbacks de lectura: "addOnId" (matriz legacy) y "_id"/"id"
 *     (referencia Multi Reference resuelta o sin resolver).
 *
 * Contrato de salida:
 *   - Array de GUIDs validados, deduplicado, orden de solicitud.
 *   - bookingCore._buildBookedAddOns los transforma a [{ addOnId }] para
 *     el body de createBooking (nivel raiz).
 *   - meta de CitasF2 persiste exactamente la misma lista como `addOnIds`.
 */
function _detectAddons(unsafePayload, metaCita, serviceConfig, traceId) {
    const rawAddons =
        (unsafePayload && unsafePayload.addOnIds) ||
        (metaCita && metaCita.addOnIds) ||
        [];
    const requested = Array.isArray(rawAddons)
        ? rawAddons
            .map(function (id) { return _safeTrim(id); })
            .filter(function (id) { return _looksLikeGuid(id); })
        : [];
    const unique = Array.from(new Set(requested));
    if (unique.length > MAX_ADDONS_PER_BOOKING) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Too many addOnIds requested (" + unique.length +
            "). Max: " + MAX_ADDONS_PER_BOOKING,
            { traceId: traceId, addonCount: unique.length, max: MAX_ADDONS_PER_BOOKING }
        );
    }
    const catalogAddons = Array.isArray(serviceConfig && serviceConfig.addOnOptions)
        ? serviceConfig.addOnOptions
        : [];
    if (catalogAddons.length === 0) {
        if (unique.length > 0) {
            log.info("SAGA-18: addons detected without catalog (passthrough)", {
                traceId: traceId,
                addonCount: unique.length,
                addOnIds: unique
            });
        }
        return unique;
    }
    const allowedSet = new Set();
    for (let c = 0; c < catalogAddons.length; c++) {
        const addon = catalogAddons[c];
        // SAGA-23: addonId es la key fisica real (CMS KEY FIELDS).
        const addonId = _safeTrim(
            (addon && (addon.addonId || addon.addOnId)) || _extractRelationId(addon)
        );
        if (addonId && _looksLikeGuid(addonId)) allowedSet.add(addonId);
    }
    if (unique.length === 0) return [];
    const unmapped = [];
    const validated = [];
    for (let u = 0; u < unique.length; u++) {
        if (allowedSet.has(unique[u])) validated.push(unique[u]);
        else unmapped.push(unique[u]);
    }
    if (unmapped.length > 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Requested addOnIds not in catalog: " + unmapped.join(", "),
            { traceId: traceId, unmapped: unmapped, catalogSize: allowedSet.size }
        );
    }
    return validated;
}

// =============================================================================
// BLOCK 12 - UBICACION OWNER_BUSINESS (SAGA-03)
// =============================================================================
function _resolveBookingLocation(params) {
    const validatedSlotF1 = params.validatedSlotF1;
    const validatedSlotF2 = params.validatedSlotF2;
    const serviceConfig = params.serviceConfig;
    const resolvedId =
        _isGuidOrNull(validatedSlotF1 && validatedSlotF1.location && validatedSlotF1.location.id) ||
        _isGuidOrNull(validatedSlotF2 && validatedSlotF2.location && validatedSlotF2.location.id) ||
        _isGuidOrNull(_extractRelationId(serviceConfig && serviceConfig.locationId)) ||
        _isGuidOrNull(params.parentLocationId);
    if (!resolvedId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking location is missing.",
            { traceId: params.traceId }
        );
    }
    const sourceLocationType = _safeTrim(
        validatedSlotF1 && validatedSlotF1.location && validatedSlotF1.location.locationType
    ).toUpperCase();
    if (sourceLocationType && sourceLocationType !== "OWNER_BUSINESS") {
        log.info("SAGA-03: overriding locationType", {
            traceId: params.traceId,
            from: sourceLocationType,
            to: "OWNER_BUSINESS",
            locationId: resolvedId
        });
    }
    return Object.freeze({ id: resolvedId, locationType: "OWNER_BUSINESS" });
}

function _assertPristineSlotContract(pristineSlot, phase, traceId) {
    const startIso = _safeTrim(pristineSlot && pristineSlot.startDate);
    const endIso = _safeTrim(pristineSlot && pristineSlot.endDate);
    const locationType = _safeTrim(
        pristineSlot && pristineSlot.location && pristineSlot.location.locationType
    ).toUpperCase();
    const missing = [];
    if (!_isGuidOrNull(pristineSlot && pristineSlot.serviceId
