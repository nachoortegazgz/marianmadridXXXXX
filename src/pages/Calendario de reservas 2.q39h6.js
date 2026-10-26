/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5017-HARDENED
 * BASE: v5016-CONTEXT-ERROR-ALIGNED + parches de seguridad y UX.
 *
 * FIXES v5017:
 *   CAL-25 (P0): buildBookingRequestPayload filtra addOnIds contra el catálogo
 *     del servicio (filterAllowedAddonIds). Sin esto, un cliente manipulado
 *     podía enviar IDs inexistentes y contaminar la reserva.
 *   CAL-26 (P1): si requiresPayment=true y falta checkoutUrl, se responde
 *     CHECKOUT_URL_MISSING ANTES del reply SUCCESS. Antes el HTML mostraba
 *     "Redirigiendo al pago..." y el usuario quedaba bloqueado sin navegación.
 *   CAL-27 (P2): loadServiceContext cachea currentService para evitar
 *     re-consultar el backend en re-handshakes (MM_READY tardío). Alineado con
 *     servicio-2.js v5019.
 *   CAL-28 (P3): BOOKING_REQUEST_ID estable se incluye en el payload de
 *     processDualBooking como `bookingRequestId`. Permite deduplicación en
 *     backend cuando citasManager.web.js lo honre; hasta entonces es un campo
 *     informativo que no rompe el flujo.
 *
 * FIXES HEREDADOS v5016: CAL-22, CAL-23, CAL-24.
 * FIXES HEREDADOS v5015: CAL-20, CAL-21.
 * FIXES HEREDADOS v5013: CAL-18.
 * FIXES HEREDADOS v5010: CLEAN-10..CLEAN-14.
 * FIXES HEREDADOS v5009: CAL-15..CAL-17.
 */
import wixLocation from "wix-location-frontend";
import wixWindowFrontend from "wix-window-frontend";
import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots,
} from "backend/reservas.web.js";
import {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    URLS,
    UI,
    BOOKINGS_ADDON_CONFIG,
    CHANNEL_TYPE,
    PAYMENT_METHOD,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    isDateYmd,
    withTimeout,
    _getMessageType,
    _getPayload,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;
let activeBookingMessageId = "";
let bookingInFlight = false;

// CAL-28: clave de idempotencia estable por carga de página. Reutilizable en
// reintentos dentro de la misma sesión, para permitir deduplicación backend
// cuando citasManager.web.js honre `bookingRequestId`. Una recarga de página
// genera una clave nueva (nueva intención del usuario).
const BOOKING_REQUEST_ID = `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const MAX_ADDONS_PER_BOOKING =
    Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;
const VALID_PAYMENT_METHODS = Object.freeze(new Set(Object.values(PAYMENT_METHOD)));

/* =============================================================================
 * HELPERS DE ERROR
 * ==========================================================================*/
const PUBLIC_ERROR_MESSAGE = "No se ha podido completar la operación. Inténtalo de nuevo.";

function resultError(code) {
    return { status: "ERROR", data: null, error: { code, message: PUBLIC_ERROR_MESSAGE } };
}

function normalizePublicError(result) {
    if (!result || result.status !== "ERROR" || !result.error) return result;
    return {
        ...result,
        error: { ...result.error, message: PUBLIC_ERROR_MESSAGE },
    };
}

function bridgeLogError(traceId, error) {
    console.error("[calendario-2] Error de comunicacion", {
        traceId,
        code: error && error.code,
        message: error && error.message,
        detail: error && error.detail,
    });
}

/**
 * CAL-22: notifica al widget un error de contexto para que deje de mostrar
 * "Cargando servicio..." indefinidamente. Usa el postMessage del bridge, que
 * adjunta el bridgeId correcto y valida el mensaje contra el protocolo.
 * Silencioso ante cualquier fallo: el throw original sigue propagándose para
 * que el bridge lo registre.
 */
function notifyContextError(bridgeApi, code, message, traceId) {
    if (!bridgeApi || typeof bridgeApi.postMessage !== "function") {
        console.warn("[calendario-2] notifyContextError sin bridge disponible", {
            traceId, code, message,
        });
        return;
    }
    try {
        bridgeApi.postMessage(
            {
                error: {
                    code: code || "SERVICE_LOAD_FAILED",
                    message: message || "No se pudo cargar el servicio.",
                },
            },
            MESSAGE_TYPES.CONTEXT
        );
        console.info("[calendario-2] Error de contexto notificado al widget", {
            traceId, code: code || "SERVICE_LOAD_FAILED",
        });
    } catch (notifyError) {
        console.warn("[calendario-2] No se pudo notificar el error al widget", {
            traceId, message: notifyError && notifyError.message,
        });
    }
}

/* =============================================================================
 * SERVICE CONTEXT
 * ==========================================================================*/
function parseUrlParams() {
    const query = wixLocation.query || {};
    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "").split(",").map(_safeTrim).filter(Boolean),
    };
}

function resolveServiceFromParams(params) {
    if (params.serviceId && _looksLikeGuid(params.serviceId)) {
        return { serviceId: params.serviceId, slug: params.slug || null };
    }
    if (params.slug) return { serviceId: null, slug: params.slug };
    return null;
}

async function loadServiceContext(params) {
    // CAL-27: cache por sesión de página. Evita re-consultar el backend en
    // re-handshakes (MM_READY tardío) o en navegaciones internas del widget.
    if (currentService) {
        return {
            ...currentService,
            serviceId: currentServiceId,
            slug: currentSlug,
            referral: params.referral,
            addOnIds: params.addOnIds,
        };
    }
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);
    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error((result && result.error && result.error.message) || "No se pudo cargar el servicio.");
    }
    currentService = result.data;
    currentServiceId = _safeTrim(result.data.serviceId || "") || currentServiceId || null;
    currentSlug = _safeTrim(result.data.slug || "") || currentSlug || null;
    return {
        ...result.data,
        serviceId: currentServiceId,
        slug: currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds,
    };
}

/* =============================================================================
 * HELPERS DE MENSAJE
 * ==========================================================================*/
function handleNavigation(payload) {
    const target = _safeTrim((payload && payload.target) || "").toUpperCase();
    if (target === "SERVICIOS") {
        wixLocation.to((URLS && URLS.SERVICIOS) || "/reserva-online");
        return true;
    }
    if (target === "PRIVACY") {
        wixLocation.to((URLS && URLS.PRIVACY_POLICY) || "/politica-de-privacidad");
        return true;
    }
    return false;
}

function normalizeAvailabilityResult(result) {
    if (!result || typeof result !== "object") {
        return resultError("EMPTY_AVAILABILITY_RESPONSE");
    }
    if (result.status === "ERROR") return normalizePublicError(result);
    if (Array.isArray(result.data)) return result;
    return resultError("INVALID_AVAILABILITY_RESPONSE");
}

/* =============================================================================
 * NORMALIZACIÓN DE ENTRADA
 * ==========================================================================*/
function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    const normalized = Array.from(new Set(value.map((item) => {
        if (typeof item === "string") return _safeTrim(item);
        if (item && typeof item === "object") return _safeTrim(item.addonId || "");
        return "";
    }).filter(Boolean)));
    if (normalized.length > MAX_ADDONS_PER_BOOKING) {
        console.warn("[calendario-2] addOnIds por encima del limite; se trunca", {
            received: normalized.length,
            max: MAX_ADDONS_PER_BOOKING,
        });
    }
    return normalized.slice(0, MAX_ADDONS_PER_BOOKING);
}

function filterAllowedAddonIds(ids, service) {
    const catalog = Array.isArray(service && service.addOnOptions) ? service.addOnOptions : [];
    const allowed = new Set(catalog.map((a) => _safeTrim(a && a.addonId)).filter(Boolean));
    return ids.filter((id) => allowed.has(id));
}

function resolveChannelType(bookingData) {
    const raw = _safeTrim(
        (bookingData && bookingData.channelType) ||
        (bookingData && bookingData.paymentMethod) ||
        ""
    ).toUpperCase();
    if (raw === CHANNEL_TYPE.ONLINE || raw === CHANNEL_TYPE.PRESENCIAL) return raw;
    if (raw) {
        console.warn("[calendario-2] channelType/paymentMethod no reconocido", { raw });
    }
    return null;
}

function normalizeSlot(slot) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
    const localStartDate = _safeTrim(slot.localStartDate || "");
    const localEndDate = _safeTrim(slot.localEndDate || "");
    const slotRef = slot.slotRef && typeof slot.slotRef === "object" && !Array.isArray(slot.slotRef)
        ? slot.slotRef
        : null;
    if (!localStartDate || !localEndDate || !slotRef) return null;
    return { localStartDate, localEndDate, slotRef };
}

function isValidBookingSlot(slot) {
    return Boolean(slot && slot.localStartDate && slot.localEndDate && slot.slotRef);
}

/* =============================================================================
 * BOOKING PAYLOAD
 * ==========================================================================*/
function buildBookingRequestPayload(bookingData, fallbackTraceId) {
    const slotF1 = normalizeSlot(bookingData.slotF1);
    const slotF2 = bookingData.slotF2 ? normalizeSlot(bookingData.slotF2) : null;
    // CAL-25 (P0): defensa en profundidad. El cliente puede haber sido
    // manipulado en devtools; filtramos contra el catálogo del servicio
    // cargado (ya validado en handleAvailability, pero buildBookingRequestPayload
    // no lo estaba). Sin este filtro, un addOnIds inyectado llegaba tal cual
    // a processDualBooking.
    const addOnIds = filterAllowedAddonIds(
        normalizeAddOnIds(bookingData.addOnIds),
        currentService
    );
    const channelType = resolveChannelType(bookingData);
    const rawPaymentMethod = _safeTrim(bookingData.paymentMethod || "").toUpperCase();
    const paymentMethod = VALID_PAYMENT_METHODS.has(rawPaymentMethod) ? rawPaymentMethod : null;

    const payload = {
        serviceId: currentServiceId || null,
        slug: currentSlug || null,
        slotF1,
        slotF2,
        addOnIds,
        email: _safeTrim(bookingData.email || ""),
        firstName: _safeTrim(bookingData.firstName || ""),
        lastName: _safeTrim(bookingData.lastName || ""),
        phone: _safeTrim(bookingData.phone || ""),
        appointmentNote: _safeTrim(bookingData.appointmentNote || bookingData.preferences || "").slice(0, 200),
        channelType,
        rgpdConsent: bookingData.rgpdConsent === true,
        traceId: _safeTrim(fallbackTraceId || "") || makeTraceId("calendario-book"),
        // CAL-28: clave de idempotencia cliente. Informativa hasta que
        // citasManager.web.js la use para deduplicar; no rompe nada si se ignora.
        bookingRequestId: BOOKING_REQUEST_ID,
    };
    if (paymentMethod) payload.paymentMethod = paymentMethod;
    return payload;
}

/* =============================================================================
 * AVAILABILITY HANDLER
 * ==========================================================================*/
async function handleAvailability(payload, reply) {
    if (!payload || typeof payload !== "object") {
        reply(MESSAGE_TYPES.AVAIL, {
            ...resultError("INVALID_AVAILABILITY_REQUEST"),
            action: "",
            requestSequence: 0,
        });
        return;
    }
    const action = _safeTrim(payload.action || "").toLowerCase();
    let addOnIds = normalizeAddOnIds(payload.addOnIds);
    addOnIds = filterAllowedAddonIds(addOnIds, currentService);
    const requestSequence = Number(payload.requestSequence) || 0;

    // La disponibilidad se calcula para todos los profesionales elegibles.
    // Cualquier resourceId enviado por un widget antiguo se ignora.
    let result;
    try {
        if (action === "days") {
            const year = Number(payload.year);
            const month = Number(payload.month);
            if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
                result = resultError("INVALID_DATE_RANGE");
            } else {
                result = await withTimeout(
                    getAvailableDays(currentServiceId || currentSlug, null, year, month, addOnIds),
                    (UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000,
                    "getAvailableDays"
                );
            }
        } else if (action === "slots") {
            const dateYmd = _safeTrim(payload.dateYmd || "");
            if (!isDateYmd(dateYmd)) {
                result = resultError("INVALID_DATE");
            } else {
                result = await withTimeout(
                    currentService && currentService.allowCombine
                        ? getCertifiedDualSlots(currentServiceId || currentSlug, null, dateYmd, addOnIds)
                        : getAvailableSlots(currentServiceId || currentSlug, null, dateYmd, addOnIds),
                    (UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000,
                    "getAvailableSlots"
                );
            }
        } else {
            result = resultError("INVALID_AVAILABILITY_REQUEST");
        }
    } catch (error) {
        result = resultError("AVAILABILITY_FAILED");
    }
    const normalizedResult = normalizeAvailabilityResult(result);
    reply(MESSAGE_TYPES.AVAIL, { ...normalizedResult, action, requestSequence });
}

/* =============================================================================
 * BOOKING HANDLER
 * ==========================================================================*/
async function handleBooking(message, reply, traceId) {
    const bookingData = _getPayload(message);
    if (!bookingData || typeof bookingData !== "object" || Array.isArray(bookingData)) {
        reply(MESSAGE_TYPES.BOOK, resultError("INVALID_BOOKING_PAYLOAD"));
        return;
    }
    const messageId = _safeTrim((message && message.messageId) || "");
    if (!messageId) {
        reply(MESSAGE_TYPES.BOOK, resultError("MISSING_MESSAGE_ID"));
        return;
    }
    if (bookingInFlight) {
        reply(MESSAGE_TYPES.BOOK, resultError("DUPLICATE_REQUEST"));
        return;
    }
    if (messageId === activeBookingMessageId) {
        reply(MESSAGE_TYPES.BOOK, resultError("DUPLICATE_REQUEST"));
        return;
    }
    if (!currentServiceId) {
        reply(MESSAGE_TYPES.BOOK, resultError("SERVICE_NOT_READY"));
        return;
    }

    let requestPayload;
    try {
        requestPayload = buildBookingRequestPayload(bookingData, bookingData.traceId || traceId);
    } catch (error) {
        reply(MESSAGE_TYPES.BOOK, resultError(error.code || "INVALID_RESOURCE_ID"));
        return;
    }

    if (!requestPayload.channelType) {
        reply(MESSAGE_TYPES.BOOK, resultError("INVALID_CHANNEL_TYPE"));
        return;
    }
    if (!requestPayload.serviceId && !requestPayload.slug) {
        reply(MESSAGE_TYPES.BOOK, resultError("MISSING_SERVICE"));
        return;
    }
    if (!isValidBookingSlot(requestPayload.slotF1)) {
        reply(MESSAGE_TYPES.BOOK, resultError("INVALID_SLOT_F1"));
        return;
    }
    if (requestPayload.slotF2 && !isValidBookingSlot(requestPayload.slotF2)) {
        reply(MESSAGE_TYPES.BOOK, resultError("INVALID_SLOT_F2"));
        return;
    }
    if (!requestPayload.email || !requestPayload.firstName || !requestPayload.phone || requestPayload.rgpdConsent !== true) {
        reply(MESSAGE_TYPES.BOOK, resultError("INVALID_CONTACT_DATA"));
        return;
    }

    activeBookingMessageId = messageId;
    bookingInFlight = true;
    try {
        const result = await withTimeout(
            processDualBooking(requestPayload),
            (UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000,
            "processDualBooking"
        );
        const bookingResult = normalizePublicError(result || resultError("EMPTY_BOOKING_RESPONSE"));

        // CAL-23: distingue "reserva creada + redirigiendo a pago" de
        // "reserva confirmada". El HTML usa `paymentPending` para mostrar el
        // mensaje correcto.
        const requiresPayment = Boolean(
            bookingResult &&
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.requiresPayment === true
        );
        const checkoutUrl = requiresPayment
            ? _safeTrim(bookingResult.data && bookingResult.data.checkoutUrl || "")
            : "";

        // CAL-26 (P1): si la reserva requiere pago pero no hay checkoutUrl,
        // se responde ERROR ANTES de mostrar "Redirigiendo al pago...". Sin
        // este guard, el usuario quedaba bloqueado con un mensaje falso.
        if (requiresPayment && !checkoutUrl) {
            console.error("[calendario-2] requiresPayment sin checkoutUrl", {
                traceId,
                bookingId: (bookingResult.data && bookingResult.data.bookingId) || null,
            });
            reply(MESSAGE_TYPES.BOOK, {
                status: "ERROR",
                data: null,
                error: {
                    code: "CHECKOUT_URL_MISSING",
                    message:
                        "No se ha podido iniciar el pago online. Si el problema persiste, contacta con el salón.",
                },
            });
            bookingInFlight = false;
            return;
        }

        const replyEnvelope = {
            ...bookingResult,
            data: bookingResult.data
                ? { ...bookingResult.data, paymentPending: requiresPayment }
                : bookingResult.data,
        };

        reply(MESSAGE_TYPES.BOOK, replyEnvelope);
        bookingInFlight = false;

        if (
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.bookingId
        ) {
            if (requiresPayment) {
                // checkoutUrl garantizado por el guard anterior
                wixLocation.to(checkoutUrl);
                return;
            }
            try {
                await wixWindowFrontend.openLightbox("ConfirmacionReserva", {
                    booking: bookingResult.data || null,
                    bookingId: bookingResult.data.bookingId,
                    service: currentService,
                    traceId,
                });
            } catch (lightboxError) {
                console.error("[calendario-2] No se pudo abrir ConfirmacionReserva", {
                    traceId,
                    message: lightboxError && lightboxError.message,
                });
            }
        }
    } catch (error) {
        bookingInFlight = false;
        const timeout = (error && error.code === "TIMEOUT") ||
            String((error && error.message) || "").toUpperCase().includes("TIMEOUT");
        reply(
            MESSAGE_TYPES.BOOK,
            resultError(
                timeout ? "BOOKING_STATUS_UNCERTAIN" : "BOOKING_FAILED")
        );
    }
}

/* =============================================================================
 * PAGE INITIALIZATION
 * ==========================================================================*/
$w.onReady(async () => {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);
    if (!resolved) {
        console.error("[calendario-2] Servicio no valido", { traceId });
        return;
    }
    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;
    const widget = $w("#html1");
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        console.error("[calendario-2] Widget HTML no disponible", { traceId });
        return;
    }
    try {
        bridge = createWidgetBridge(widget, {
            traceId,
            allowOpaqueOrigin: true, // iframes Wix → origin opaco
            // CAL-22: si loadServiceContext falla, notifica al widget antes
            // de propagar el error al bridge. Evita el "Cargando servicio..."
            // indefinido en el HTML.
            onContextReady: async (message, bridgeApi) => {
                try {
                    return await loadServiceContext(params);
                } catch (error) {
                    const code = error && error.code
                        ? error.code
                        : "SERVICE_LOAD_FAILED";
                    const message =
                        (error && error.message) ||
                        "No se pudo cargar el servicio.";
                    notifyContextError(bridgeApi, code, message, traceId);
                    throw error;
                }
            },
            onWidgetMessage: async (message, reply) => {
                const type = _getMessageType(message);
                const payload = _getPayload(message);
                if (type === MESSAGE_TYPES.NAV) {
                    if (!handleNavigation(payload)) {
                        reply(MESSAGE_TYPES.NAV, resultError("INVALID_NAV_TARGET"));
                    }
                    return;
                }
                if (type === MESSAGE_TYPES.AVAIL) {
                    await handleAvailability(payload, reply);
                    return;
                }
                if (type === MESSAGE_TYPES.BOOK) {
                    await handleBooking(message, reply, traceId);
                    return;
                }
                if (type !== MESSAGE_TYPES.READY && type !== MESSAGE_TYPES.CONTEXT) {
                    console.warn("[calendario-2] Mensaje no soportado", { traceId, type });
                }
            },
            onError: (error) => bridgeLogError(traceId, error),
        });
        if (!bridge) throw new Error("No se pudo inicializar el bridge.");
    } catch (error) {
        console.error("[calendario-2] Error de inicializacion", { traceId, message: error && error.message });
    }
});