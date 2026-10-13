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
    if (!_isGuidOrNull(pristineSlot && pristineSlot.serviceId)) missing.push("serviceId");
    if (!_isGuidOrNull(pristineSlot && pristineSlot.scheduleId)) missing.push("scheduleId");
    if (!startIso) missing.push("startDate");
    else if (!/Z$/.test(startIso)) missing.push("startDate must be ISO UTC with Z");
    if (!endIso) missing.push("endDate");
    else if (!/Z$/.test(endIso)) missing.push("endDate must be ISO UTC with Z");
    if (!_isGuidOrNull(pristineSlot && pristineSlot.resource && pristineSlot.resource.id)) {
        missing.push("resource.id");
    }
    if (!_isGuidOrNull(pristineSlot && pristineSlot.location && pristineSlot.location.id)) {
        missing.push("location.id");
    }
    if (locationType !== "OWNER_BUSINESS") missing.push("location.locationType must be OWNER_BUSINESS");
    if (missing.length > 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Pristine slot " + phase + " violates contract: " + missing.join("; "),
            { traceId: traceId, phase: phase, missing: missing }
        );
    }
    return true;
}

// =============================================================================
// BLOCK 13 - SAGA ORCHESTRATOR
// =============================================================================
export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId;
        this.steps = [];
        this.completedSteps = [];
    }
    addStep(name, executeFn, compensateFn) {
        this.steps.push({ name: name, executeFn: executeFn, compensateFn: compensateFn });
    }
    async execute() {
        for (let i = 0; i < this.steps.length; i++) {
            const step = this.steps[i];
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                const result = await step.executeFn();
                this.completedSteps.push(Object.assign({}, step, { result: result }));
            } catch (error) {
                log.error("Saga step failed: " + step.name, {
                    traceId: this.traceId,
                    error: error && error.message
                });
                await this._compensate();
                throw error;
            }
        }
        return this.completedSteps.map(function (s) { return s.result; });
    }
    async _compensate() {
        const reversed = [].concat(this.completedSteps).reverse();
        for (let i = 0; i < reversed.length; i++) {
            const step = reversed[i];
            if (step.compensateFn) {
                try {
                    log.info("Saga compensating: " + step.name, { traceId: this.traceId });
                    await step.compensateFn(step.result);
                } catch (compErr) {
                    log.error("Saga compensation failed: " + step.name, {
                        traceId: this.traceId,
                        error: compErr && compErr.message
                    });
                }
            }
        }
    }
}

// =============================================================================
// BLOCK 14 - EXECUTE BOOKING SAGA
// =============================================================================
export async function executeBookingSaga(unsafePayload) {
    const traceId = (unsafePayload && unsafePayload.traceId) || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(
        (unsafePayload && unsafePayload.metaCita) ||
        (unsafePayload && unsafePayload.meta) ||
        {}
    );
    let heartbeatInterval = null;
    let lockKeys = [];
    let lockOwnerId = "";
    const createdBookings = [];
    let pairToken = "";
    try {
        // ---------------- PHASE 0: VALIDATION AND RESOLUTION ----------------
        const email = _safeTrim(
            (unsafePayload && unsafePayload.email) ||
            metaCita.email ||
            (unsafePayload && unsafePayload.contactDetails && unsafePayload.contactDetails.email)
        );
        if (!email) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Email is required",
                { traceId: traceId }
            );
        }
        const rgpdConsent =
            (unsafePayload && unsafePayload.rgpdConsent === true) ||
            metaCita.rgpdConsent === true;
        if (!rgpdConsent) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "RGPD consent is required",
                { traceId: traceId }
            );
        }
        // SAGA-31: canal calculado UNA sola vez para toda la saga.
        const requestedChannel = _safeTrim(
            (unsafePayload && unsafePayload.channelType) ||
            (unsafePayload && unsafePayload.paymentMethod) ||
            metaCita.channelType ||
            CHANNEL_PRESENCIAL
        ).toUpperCase();
        const isOnline = requestedChannel === CHANNEL_ONLINE;
        const rawPaymentMethod = _safeTrim(
            (unsafePayload && unsafePayload.paymentMethod) || metaCita.paymentMethod || ""
        );

        const rawServiceId = _safeTrim(
            (unsafePayload && unsafePayload.serviceId) || metaCita.serviceId || ""
        );
        const serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(
                ERROR_CODES.SERVICE_NOT_FOUND,
                "Service not found",
                { traceId: traceId, rawServiceId: rawServiceId }
            );
        }
        const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
        const serviceConfig = (serviceRes && serviceRes.data) || {};
        const linkedPhasesRaw = _extractRelationId(serviceConfig.linkedPhases);
        const isDual =
            serviceConfig.allowCombine === true &&
            !!linkedPhasesRaw &&
            _looksLikeGuid(linkedPhasesRaw);
        const linkedPhases = isDual ? linkedPhasesRaw : null;
        const parentLocationId =
            _extractRelationId(serviceConfig.locationId) || _safeTrim(serviceConfig.location);
        const requestedResourceId = _safeTrim(
            (unsafePayload && unsafePayload.resourceId) || metaCita.resourceId
        );
        const slotF1Input = (unsafePayload && unsafePayload.slotF1) || {};
        const slotF2Input = (unsafePayload && unsafePayload.slotF2) || {};
        // SAGA-20: solo localStartDate / localEndDate. Sin fallback start/end.
        const f1LocalStart = _normalizeLocalIsoStr(
            slotF1Input.localStartDate || metaCita.f1Start
        );
        const f1LocalEnd = _normalizeLocalIsoStr(
            slotF1Input.localEndDate || metaCita.f1End
        );
        if (!f1LocalStart || !f1LocalEnd) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "F1 slot localStartDate and localEndDate are required",
                { traceId: traceId }
            );
        }
        const f1StartMs = Date.parse(f1LocalStart);
        const f1EndMs = Date.parse(f1LocalEnd);
        if (
            Number.isNaN(f1StartMs) ||
            Number.isNaN(f1EndMs) ||
            !(f1EndMs > f1StartMs)
        ) {
            throw createBookingError(
                ERROR_CODES.INVALID_DATES,
                "F1 slot has invalid or non-positive duration",
                { traceId: traceId }
            );
        }
        let f2LocalStart = "";
        let f2LocalEnd = "";
        if (isDual) {
            f2LocalStart = _normalizeLocalIsoStr(
                slotF2Input.localStartDate || metaCita.f2Start
            );
            f2LocalEnd = _normalizeLocalIsoStr(
                slotF2Input.localEndDate || metaCita.f2End
            );
            if (!f2LocalStart && !f2LocalEnd) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Dual booking requires F2 slot dates",
                    { traceId: traceId }
                );
            }
            const linkedValidation = await _validateLinkedPhaseService(
                linkedPhases,
                parentLocationId,
                traceId
            );
            if (!f2LocalStart) {
                const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                if (!f1EndUtc) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_DATES,
                        "Could not compute F1 end UTC for F2",
                        { traceId: traceId }
                    );
                }
                const exposureMs = Math.max(
                    0,
                    Number(serviceConfig.exposureDuration || 0)
                ) * 60 * 1000;
                const linkedPhase2Ms = Math.max(
                    0,
                    Number(linkedValidation.phase2Duration || 30)
                ) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + linkedPhase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }
            _validateDualGap(f1LocalEnd, f2LocalStart, traceId);
        }
        // SAGA-18/23: solo addOnIds desde payload / metaCita.
        const detectedAddonIds = _detectAddons(
            unsafePayload,
            metaCita,
            serviceConfig,
            traceId
        );

        // ---------------- PHASE 1: REAL-TIME REVALIDATION ----------------
        const resourceValidation = await _resolveStaffForSlotInternal({
            serviceId: serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            addOnIds: detectedAddonIds,
            traceId: traceId
        });
        if (!resourceValidation || resourceValidation.status !== "SUCCESS") {
            throw createBookingError(
                (resourceValidation && resourceValidation.error && resourceValidation.error.code) ||
                ERROR_CODES.SLOT_UNAVAILABLE,
                (resourceValidation && resourceValidation.error && resourceValidation.error.message) ||
                "Slot no longer available",
                { traceId: traceId }
            );
        }
        const finalResourceId = resourceValidation.data.resourceId;
        const validatedSlotF1 = resourceValidation.data.slotF1;
        const validatedSlotF2 = resourceValidation.data.slotF2;
        if (isDual && validatedSlotF1 && validatedSlotF2) {
            _validateDualGap(
                _normalizeLocalIsoStr(validatedSlotF1.localEndDate || f1LocalEnd),
                _normalizeLocalIsoStr(validatedSlotF2.localStartDate || f2LocalStart),
                traceId
            );
        }

        // ---------------- PHASE 2: PAIR TOKEN (SAGA-30) ----------------
        const clientSuppliedPairToken = _safeTrim(unsafePayload && unsafePayload.pairToken);
        if (clientSuppliedPairToken) {
            log.info("SAGA-30: client-supplied pairToken ignored; recomputing in backend", {
                traceId: traceId,
                ignoredPairToken: clientSuppliedPairToken
            });
        }
        const tokenResolution = _resolveUnifiedPairToken({
            suppliedPairToken: _safeTrim(metaCita.pairToken),
            isDual: isDual,
            serviceId: serviceId,
            linkedPhases: linkedPhases,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: f2LocalStart,
            f2End: f2LocalEnd,
            resourceId: finalResourceId || requestedResourceId,
            email: email,
            traceId: traceId
        });
        pairToken = tokenResolution.pairToken;
        lockOwnerId = pairToken;
        log.info("SAGA-02: pairToken resolved", {
            traceId: traceId,
            source: tokenResolution.source,
            isDual: isDual,
            pairToken: pairToken
        });
        const bookingLocation = _resolveBookingLocation({
            validatedSlotF1: validatedSlotF1,
            validatedSlotF2: validatedSlotF2,
            serviceConfig: serviceConfig,
            parentLocationId: parentLocationId,
            traceId: traceId
        });

        // ------------- IDEMPOTENCY GATE (SAGA-PATCH-02) -------------
        const payloadHash = _hashKey(_stableSerialize({
            serviceId: serviceId,
            resourceId: finalResourceId || requestedResourceId,
            f1LocalStart: f1LocalStart,
            f1LocalEnd: f1LocalEnd,
            f2LocalStart: f2LocalStart,
            f2LocalEnd: f2LocalEnd,
            email: email,
            addOnIds: detectedAddonIds
        }));
        const txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult || !txResult.success) {
            const txError = txResult && txResult.error;
            if (txError === ERROR_CODES.PAIR_TOKEN_PAYLOAD_MISMATCH) {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken",
                    { traceId: traceId }
                );
            }
            if (txError === ERROR_CODES.TRANSACTION_PREVIOUSLY_FAILED) {
                throw createBookingError(
                    ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed",
                    { traceId: traceId }
                );
            }
            if (
                txResult &&
                txResult.existing &&
                txResult.existing.status === "COMPLETED"
            ) {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true
                };
            }
            throw createBookingError(
                ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout",
                { traceId: traceId }
            );
        }

        // ---------------- LOCKS + HEARTBEAT ----------------
        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd
        }];
        if (isDual && f2LocalStart) {
            phases.push({
                rawSlot: Object.assign({}, validatedSlotF2, { serviceId: linkedPhases }),
                localStart: f2LocalStart,
                localEnd: f2LocalEnd
            });
        }
        lockKeys = _buildLockKeys(phases, finalResourceId);
        const saga = new BookingSagaOrchestrator(traceId);
        saga.addStep(
            "LockSlots",
            async function () {
                for (let li = 0; li < lockKeys.length; li++) {
                    const lockResult = await _lockSlotKeyOrFail(
                        lockKeys[li],
                        lockOwnerId,
                        LOCK_TTL_MS
                    );
                    if (!lockResult || !lockResult.ok) {
                        throw createBookingError(
                            ERROR_CODES.TOKEN_BUSY,
                            "Lock failed: " + ((lockResult && lockResult.message) || "unknown"),
                            { traceId: traceId, lockKey: lockKeys[li] }
                        );
                    }
                }
                heartbeatInterval = setInterval(function () {
                    lockKeys.forEach(function (key) {
                        _renewLock(key, lockOwnerId, LOCK_TTL_MS).catch(function (err) {
                            log.warn("heartbeat: lock renewal failed", {
                                key: key,
                                traceId: traceId,
                                error: err && err.message
                            });
                        });
                    });
                }, HEARTBEAT_MS);
                return { lockKeys: lockKeys };
            },
            async function () {
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
                await _bestEffortUnlockAll(lockKeys, lockOwnerId);
            }
        );

        // ---------------- CREATE BOOKINGS F1 -> F2 ----------------
        // SAGA-14/15/18: los add-ons viajan como bookedAddOns a NIVEL RAIZ
        // del body de createBooking de F1, NUNCA dentro de bookedEntity.slot.
        // SAGA-25: F2 es NO_FEE -> sin bookedAddOns, sin selectedPaymentOption
        // y con skipAvailabilityValidation + skipSelectedPaymentOptionValidation.
        saga.addStep(
            "CreateBookings",
            async function () {
                // SAGA-32: contactDetails completo (bookingCore minimiza).
                const contactDetails = {
                    firstName: _safeTrim(
                        (unsafePayload && unsafePayload.firstName) || metaCita.firstName || ""
                    ),
                    lastName: _safeTrim(
                        (unsafePayload && unsafePayload.lastName) || metaCita.lastName || ""
                    ),
                    email: email,
                    phone: _safeTrim(
                        (unsafePayload && unsafePayload.phone) || metaCita.phone || ""
                    )
                };
                const f1Options = Object.freeze({
                    flowControlSettings: Object.freeze({
                        skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION
                    })
                });
                const bookedAddOns = _buildBookedAddOns(detectedAddonIds);
                const pristineF1 = await _forceStaffInPristineSlot(
                    Object.assign({}, validatedSlotF1, { location: bookingLocation }),
                    finalResourceId,
                    serviceId,
                    serviceConfig.phase1Duration
                );
                if (!pristineF1) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_PAYLOAD,
                        "Failed to build pristine slot F1",
                        { traceId: traceId }
                    );
                }
                pristineF1.location = bookingLocation;
                _assertPristineSlotContract(pristineF1, "F1", traceId);
                const bookingBodyF1 = {
                    bookedEntity: { slot: pristineF1 },
                    contactDetails: contactDetails,
                    totalParticipants: 1
                };
                if (bookedAddOns.length > 0) bookingBodyF1.bookedAddOns = bookedAddOns;
                if (isOnline) bookingBodyF1.selectedPaymentOption = BOOKING_PAYMENT_OPTION_ONLINE;
                const resF1 = await _createBookingWithSelectiveElevation(
                    bookingBodyF1,
                    f1Options,
                    traceId
                );
                const bookingF1 = (resF1 && resF1.booking) || resF1;
                const f1Meta = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                createdBookings.push({
                    bookingId: f1Meta.bookingId,
                    revision: f1Meta.revision,
                    status: f1Meta.status,
                    phase: "F1",
                    serviceId: serviceId
                });
                let bookingF2 = null;
                let f2Meta = null;
                let pristineF2 = null;
                if (isDual && f2LocalStart && validatedSlotF2) {
                    pristineF2 = await _forceStaffInPristineSlot(
                        Object.assign({}, validatedSlotF2, { location: bookingLocation }),
                        finalResourceId,
                        linkedPhases,
                        serviceConfig.phase2Duration
                    );
                    if (!pristineF2) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Failed to build pristine slot F2",
                            { traceId: traceId }
                        );
                    }
                    pristineF2.location = bookingLocation;
                    _assertPristineSlotContract(pristineF2, "F2", traceId);
                    // SAGA-25: F2 NO_FEE. Sin add-ons ni selectedPaymentOption.
                    const bookingBodyF2 = {
                        bookedEntity: { slot: pristineF2 },
                        contactDetails: contactDetails,
                        totalParticipants: 1
                    };
                    const f2Options = Object.freeze({
                        flowControlSettings: Object.freeze({
                            skipAvailabilityValidation: true,
                            skipSelectedPaymentOptionValidation: true
                        })
                    });
                    const resF2 = await _createBookingWithSelectiveElevation(
                        bookingBodyF2,
                        f2Options,
                        traceId
                    );
                    bookingF2 = (resF2 && resF2.booking) || resF2;
                    f2Meta = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                    _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                    createdBookings.push({
                        bookingId: f2Meta.bookingId,
                        revision: f2Meta.revision,
                        status: f2Meta.status,
                        phase: "F2",
                        serviceId: linkedPhases
                    });
                }
                return {
                    bookingF1: bookingF1,
                    bookingF2: bookingF2,
                    createdBookings: createdBookings,
                    scheduleIdF1: _safeTrim(pristineF1 && pristineF1.scheduleId) || null,
                    scheduleIdF2: _safeTrim(pristineF2 && pristineF2.scheduleId) || null,
                    revisionF1: f1Meta.revision,
                    revisionF2: (f2Meta && f2Meta.revision) || null
                };
            },
            async function () {
                await _compensateCreatedBookings(createdBookings, traceId);
            }
        );

        // ---------------- CHECKOUT / CONFIRM ----------------
        // Restriccion oficial (dev.wix.com): confirmOrDeclineBooking SOLO con
        // checkout propio. La rama online NO lo llama: Wix Bookings sincroniza
        // el estado desde la orden eCom (webhook -> events.js).
        saga.addStep(
            isOnline ? "CreateCheckout" : "ConfirmPresencial",
            async function () {
                if (isOnline) {
                    // SAGA-25: el checkout incluye SOLO F1. F2 es NO_FEE y no
                    // debe generar linea facturable en la orden eCom.
                    let bookingF1Id = null;
                    for (let fi = 0; fi < createdBookings.length; fi++) {
                        if (createdBookings[fi].phase === "F1") {
                            bookingF1Id = createdBookings[fi].bookingId;
                            break;
                        }
                    }
                    if (!bookingF1Id) {
                        throw createBookingError(
                            ERROR_CODES.CHECKOUT_FAILED,
                            "F1 booking is required to create the checkout",
                            { traceId: traceId }
                        );
                    }
                    const checkoutPayload = {
                        lineItems: [{
                            catalogReference: {
                                appId: APP_IDS.BOOKINGS,
                                catalogItemId: bookingF1Id,
                                options: {}
                            },
                            quantity: 1
                        }],
                        channelType: "WEB"
                    };
                    const checkoutRes = await withTimeout(
                        function () { return createCheckoutElevated(checkoutPayload); },
                        CHECKOUT_TIMEOUT_MS,
                        "createCheckout"
                    );
                    const checkoutUrl = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () {
                                    return getCheckoutUrlElevated(_extractCheckoutId(checkoutRes));
                                },
                                API_TIMEOUT_MS,
                                "getCheckoutUrl"
                            );
                        },
                        2,
                        300
                    );
                    return {
                        requiresPayment: true,
                        checkoutUrl: checkoutUrl,
                        bookingIds: [bookingF1Id]
                    };
                }
                for (let ci = 0; ci < createdBookings.length; ci++) {
                    const booking = createdBookings[ci];
                    const confirmResult = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () {
                                    return confirmOrDeclineBookingElevated(
                                        booking.bookingId,
                                        { paymentStatus: PAYMENT_STATUS_NOT_PAID }
                                    );
                                },
                                API_TIMEOUT_MS,
                                "confirmOrDecline"
                            );
                        },
                        2,
                        300
                    );
                    _checkDoubleBookingFlag(
                        confirmResult,
                        "CONFIRM_" + booking.phase,
                        traceId
                    );
                    booking.status =
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.status) ||
                        _safeTrim(confirmResult && confirmResult.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.status) ||
                        BOOKING_STATUS_CONFIRMED;
                }
                return {
                    requiresPayment: false,
                    bookingIds: createdBookings.map(function (b) { return b.bookingId; })
                };
            },
            async function () { }
        );

        const paymentStatus = isOnline ? PAYMENT_STATUS_PENDING : PAYMENT_STATUS_NOT_PAID;
        const citaStatus = isOnline ? BOOKING_STATUS_PENDING_PAYMENT : BOOKING_STATUS_CONFIRMED;

        // ---------------- PERSIST CITAS_F2 ----------------
        saga.addStep(
            "PersistCitas",
            async function () {
                const checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
                let checkoutStepResult = null;
                let createBookingsResult = {};
                for (let si = 0; si < saga.completedSteps.length; si++) {
                    const cs = saga.completedSteps[si];
                    if (cs.name === checkoutStepName) checkoutStepResult = cs.result;
                    if (cs.name === "CreateBookings") createBookingsResult = cs.result || {};
                }
                const resolvedCheckoutUrl =
                    (checkoutStepResult && checkoutStepResult.checkoutUrl) || null;
                let bookingF1Id = null;
                let bookingF2Id = null;
                for (let bi = 0; bi < createdBookings.length; bi++) {
                    if (createdBookings[bi].phase === "F1") bookingF1Id = createdBookings[bi].bookingId;
                    if (createdBookings[bi].phase === "F2") bookingF2Id = createdBookings[bi].bookingId;
                }
                const revisionF1 = Number(createBookingsResult.revisionF1) || 1;
                const revisionF2 = Number(createBookingsResult.revisionF2) || 1;
                let scheduleIdF1 = _isGuidOrNull(createBookingsResult.scheduleIdF1);
                if (!scheduleIdF1) {
                    scheduleIdF1 = await _resolveScheduleIdForResource(
                        finalResourceId,
                        validatedSlotF1
                    );
                }
                if (!scheduleIdF1) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_PAYLOAD,
                        "Unable to resolve scheduleId for F1",
                        { traceId: traceId, bookingId: bookingF1Id }
                    );
                }
                const persistedContactDetails = {
                    firstName: _safeTrim(
                        (unsafePayload && unsafePayload.firstName) || metaCita.firstName || ""
                    ),
                    lastName: _safeTrim(
                        (unsafePayload && unsafePayload.lastName) || metaCita.lastName || ""
                    ),
                    email: email,
                    phone: _safeTrim(
                        (unsafePayload && unsafePayload.phone) || metaCita.phone || ""
                    )
                };
                // SAGA-31: meta incluye channelType (consumidor: citasManager
                // _isOnlinePaymentAllowed) y datos de auditoria del payload.
                await _persistBooking({
                    bookingId: bookingF1Id,
                    revision: revisionF1,
                    serviceId: serviceId,
                    scheduleId: scheduleIdF1,
                    resourceId: finalResourceId,
                    startDate: getUtcDateFromMadridLocal(f1LocalStart),
                    endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                    bookingType: isDual ? BOOKING_TYPE.DUALF1 : BOOKING_TYPE.SIMPLE,
                    bookingStatus: citaStatus,
                    paymentStatus: paymentStatus,
                    pairToken: pairToken,
                    contactDetails: persistedContactDetails,
                    meta: {
                        pairToken: pairToken,
                        pairTokenSource: tokenResolution.source,
                        f1Start: f1LocalStart,
                        f1End: f1LocalEnd,
                        f2Start: f2LocalStart || null,
                        f2End: f2LocalEnd || null,
                        checkoutUrl: resolvedCheckoutUrl,
                        addOnIds: detectedAddonIds,
                        channelType: isOnline ? CHANNEL_ONLINE : CHANNEL_PRESENCIAL,
                        paymentMethod: rawPaymentMethod || null,
                        rgpdConsent: true,
                        locationType: "OWNER_BUSINESS",
                        writerRevision: revisionF1
                    },
                    traceId: traceId
                }, traceId);
                if (isDual && bookingF2Id) {
                    let scheduleIdF2 = _isGuidOrNull(createBookingsResult.scheduleIdF2);
                    if (!scheduleIdF2) {
                        scheduleIdF2 = await _resolveScheduleIdForResource(
                            finalResourceId,
                            validatedSlotF2
                        );
                    }
                    if (!scheduleIdF2) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Unable to resolve scheduleId for F2",
                            { traceId: traceId, bookingId: bookingF2Id }
                        );
                    }
                    await _persistBooking({
                        bookingId: bookingF2Id,
                        revision: revisionF2,
                        serviceId: linkedPhases,
                        scheduleId: scheduleIdF2,
                        resourceId: finalResourceId,
                        startDate: getUtcDateFromMadridLocal(f2LocalStart),
                        endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                        bookingType: BOOKING_TYPE.DUALF2,
                        bookingStatus: citaStatus,
                        paymentStatus: paymentStatus,
                        pairToken: pairToken,
                        contactDetails: persistedContactDetails,
                        meta: {
                            pairToken: pairToken,
                            pairTokenSource: tokenResolution.source,
                            linkedF1BookingId: bookingF1Id,
                            addOnIds: detectedAddonIds,
                            channelType: isOnline ? CHANNEL_ONLINE : CHANNEL_PRESENCIAL,
                            noFee: true,
                            locationType: "OWNER_BUSINESS",
                            writerRevision: revisionF2
                        },
                        traceId: traceId
                    }, traceId);
                }
                return {
                    bookingF1Id: bookingF1Id,
                    bookingF2Id: bookingF2Id || null,
                    resolvedCheckoutUrl: resolvedCheckoutUrl,
                    citaStatus: citaStatus,
                    isOnline: isOnline,
                    revisionF1: revisionF1,
                    revisionF2: revisionF2
                };
            },
            async function () {
                // SAGA-29: marcar CANCELLED (CitasF2 es append-only).
                await _cancelCitasByPairToken(pairToken, traceId);
            }
        );

        // ---------------- EXECUTE ----------------
        const sagaStartTime = Date.now();
        try {
            await saga.execute();
            let persistStepResult = null;
            for (let pi = 0; pi < saga.completedSteps.length; pi++) {
                if (saga.completedSteps[pi].name === "PersistCitas") {
                    persistStepResult = saga.completedSteps[pi].result;
                }
            }
            const finalResult = {
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                bookingId: null,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                resourceId: finalResourceId,
                location: bookingLocation,
                requiresPayment: isOnline,
                checkoutUrl: (persistStepResult && persistStepResult.resolvedCheckoutUrl) || null,
                status: (persistStepResult && persistStepResult.citaStatus) || citaStatus,
                paymentStatus: paymentStatus,
                channelType: isOnline ? CHANNEL_ONLINE : CHANNEL_PRESENCIAL,
                addOnIds: detectedAddonIds
            };
            for (let fi = 0; fi < createdBookings.length; fi++) {
                if (createdBookings[fi].phase === "F1") {
                    finalResult.bookingId = createdBookings[fi].bookingId;
                    break;
                }
            }
            try {
                await _completeTransaction(pairToken, finalResult, traceId);
            } catch (completeErr) {
                log.error("_completeTransaction failed; compensating full saga", {
                    pairToken: pairToken,
                    traceId: traceId,
                    error: completeErr && completeErr.message
                });
                try { await _cancelCitasByPairToken(pairToken, traceId); } catch (_) { /* best effort */ }
                try { await _compensateCreatedBookings(createdBookings, traceId); } catch (_) { /* best effort */ }
                throw completeErr;
            }
            const madridDateYMD = f1LocalStart.slice(0, 10);
            setTimeout(function () {
                _invalidateCachesInternal(serviceId, madridDateYMD, finalResourceId, traceId)
                    .catch(function (e) {
                        log.warn("Post-commit cache invalidation failed", {
                            traceId: traceId,
                            error: e && e.message
                        });
                    });
            }, 0);
            log.info("executeBookingSaga completed", {
                traceId: traceId,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                bookingIds: finalResult.bookingIds,
                locationType: bookingLocation.locationType,
                addonCount: detectedAddonIds.length,
                requiresPayment: isOnline,
                elapsedMs: Date.now() - sagaStartTime
            });
            return { status: "SUCCESS", data: finalResult, error: null };
        } catch (sagaErr) {
            try {
                const normSaga = normalizeError(sagaErr);
                await _failTransaction(pairToken, (normSaga && normSaga.code) || "SAGA_FAILED");
            } catch (failErr) {
                log.warn("_failTransaction could not be recorded", {
                    pairToken: pairToken,
                    traceId: traceId,
                    error: failErr && failErr.message
                });
            }
            throw sagaErr;
        }
    } catch (error) {
        const norm = normalizeError(error);
        log.error("executeBookingSaga failed", {
            code: norm.code,
            error: norm.message,
            traceId: traceId
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
                message: norm.message
            }
        };
    } finally {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
    }
}
