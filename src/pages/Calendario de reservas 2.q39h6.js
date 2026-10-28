/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5023-STRICT-ORIGIN
 * BASE: v5022-MINIMAL.
 *
 * FIXES v5023:
 *   CAL-40 (P0): eliminado `allowOpaqueOrigin: true`. El HTML del calendario
 *     rechaza orígenes opacos (blob:, data:, filesystem:) y "null"; mantener
 *     la opción habilitada en el bridge creaba una asimetría de política
 *     que permitía aceptar en el bridge lo que el HTML rechazaba. Ahora
 *     ambos extremos son fail-closed y solo aceptan HTTPS de la allowlist.
 *   CAL-41 (P1): handleNavigation() ahora reconoce "PRIVACY" pero solo
 *     navega si URLS.PRIVACY_POLICY está definido. Se evita navegar a
 *     /politica-de-privacidad (no confirmada como ruta real). Si el
 *     consumidor (widgetBridge → reply MM_NAV) recibe false, responde
 *     INVALID_NAV_TARGET; el HTML ignora esa reply (no tiene branch para
 *     MM_NAV), por lo que el botón queda como no-op silencioso en lugar
 *     de romper la navegación.
 *
 * FIXES HEREDADOS v5022: CAL-37, CAL-38, CAL-39.
 * FIXES HEREDADOS v5021: CAL-36 (migración SDK).
 * FIXES HEREDADOS v5020: CAL-32..CAL-35.
 * FIXES HEREDADOS v5019: CAL-29..CAL-31.
 * FIXES HEREDADOS v5018: CAL-25..CAL-28.
 * FIXES HEREDADOS v5016: CAL-22..CAL-24.
 * FIXES HEREDADOS v5015: CAL-20, CAL-21.
 * FIXES HEREDADOS v5013: CAL-18.
 * FIXES HEREDADOS v5010: CLEAN-10..CLEAN-14.
 * FIXES HEREDADOS v5009: CAL-15..CAL-17.
 */
import { location } from "@wix/site-location";
import { window } from "@wix/site-window";
import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots,
} from "backend/reservas.web.js";
import {
    MESSAGE_TYPES,
    URLS,
    UI,
    BOOKINGS_ADDON_CONFIG,
    CHANNEL_TYPE,
    PAYMENT_METHOD,
    makeTraceId,
    _safeTrim,
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

// CAL-28: clave de idempotencia estable por carga de página.
const BOOKING_REQUEST_ID = `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const MAX_ADDONS_PER_BOOKING =
    Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;
const VALID_PAYMENT_METHODS = Object.freeze(new Set(Object.values(PAYMENT_METHOD)));

/* =============================================================================
 * HELPERS DE ERROR
 * ==========================================================================*/
const PUBLIC_ERROR_MESSAGE = "No se ha podido completar la operación. Inténtalo de nuevo.";

function normalizeServiceLookup(value) {
    let raw = _safeTrim(value, 200);
    if (!raw) return "";
    try {
        raw = decodeURIComponent(raw);
    } catch (_) {
        return "";
    }
    raw = raw.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "").normalize("NFC");
    if (!raw || /[\/\\\u0000-\u001F]/.test(raw)) return "";
    if (_looksLikeGuid(raw)) return raw.toLowerCase();
    if (!/^[\p{L}\p{N}]+(?:[._:-]?[\p{L}\p{N}]+)*$/u.test(raw)) return "";
    return raw.toLocaleLowerCase("es-ES");
}

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
    const query = location.query || {};
    const path = Array.isArray(location.path) ? location.path : [];
    const rawServiceId = _safeTrim(query.serviceId || "");
    const queryServiceId = _looksLikeGuid(rawServiceId) ? rawServiceId : "";
    const querySlug = normalizeServiceLookup(query.slug || (!queryServiceId ? rawServiceId : ""));

    let routeSlug = "";
    const calendarIndex = path.findIndex(
        (segment) => String(segment || "").toLowerCase() === "booking-calendar",
    );
    if (calendarIndex >= 0) {
        const candidate = normalizeServiceLookup(path[calendarIndex + 1]);
        if (candidate && candidate.toLowerCase() !== "calendario-2") {
            routeSlug = candidate;
        }
    }

    return {
        serviceId: queryServiceId,
        slug: querySlug || (!queryServiceId ? routeSlug : ""),
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
    if (currentService) {
        return {
            ...currentService,
            serviceId: currentServiceId,
            slug: currentSlug,
            referral: params.referral,
            addOnIds: params.addOnIds,
        };
    }
    const lookup = currentSlug || currentServiceId;
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await withTimeout(
                () => getServiceBySlugOrId(lookup),
                45000,
                "loadServiceContext",
            );
            if (!result || result.status !== "SUCCESS" || !result.data) {
                const error = new Error(
                    (result && result.error && result.error.message) || "No se pudo cargar el servicio.",
                );
                error.code = result?.error?.code || "SERVICE_LOOKUP_FAILED";
                throw error;
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
        } catch (error) {
            lastError = error;
            const code = String(error?.code || "").toUpperCase();
            const message = String(error?.message || "").toUpperCase();
            const retryable = /TIMEOUT|TRANSIENT|NETWORK|TEMPORARY|UNAVAILABLE|INTERNAL|ECONN|FETCH|HTTP.?5\d\d|CONNECTION RESET|SOCKET/.test(
                code + " " + message,
            );
            if (!retryable || attempt === maxAttempts) throw error;
            const delayMs = Math.min(4000, 500 * 2 ** (attempt - 1));
            console.warn("[calendario-2] Reintentando lectura de servicio", {
                traceId: params.traceId || null,
                attempt,
                nextAttempt: attempt + 1,
                delayMs,
                code: code || null,
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError || new Error("SERVICE_LOOKUP_FAILED");
}

/* =============================================================================
 * HELPERS DE MENSAJE
 * ==========================================================================*/
// CAL-41: "PRIVACY" solo navega si URLS.PRIVACY_POLICY existe. Si no, devuelve
// false y el caller responde INVALID_NAV_TARGET (que el HTML ignora). No se
// inventa la ruta /politica-de-privacidad, que no está confirmada.
function handleNavigation(payload) {
    const target = _safeTrim(payload?.target).toUpperCase();

    if (target === "SERVICIOS") {
        location.to(URLS?.SERVICIOS || "/reserva-online");
        return true;
    }

    if (target === "PRIVACY") {
        const privacyUrl = URLS?.PRIVACY_POLICY;

        if (!privacyUrl) {
            return false;
        }

        location.to(privacyUrl);
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
function getAddonId(item) {
    if (typeof item === "string" || typeof item === "number") {
        return _safeTrim(item);
    }
    if (item && typeof item === "object") {
        return _safeTrim(
            item.addonId || item._id || item.id || item.referenceId || item.value
        );
    }
    return "";
}

function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    const normalized = Array.from(new Set(
        value.map(getAddonId).filter(Boolean)
    ));
    if (normalized.length > MAX_ADDONS_PER_BOOKING) {
        console.warn("[calendario-2] addOnIds por encima del limite; se trunca", {
            received: normalized.length,
            max: MAX_ADDONS_PER_BOOKING,
        });
    }
    return normalized.slice(0, MAX_ADDONS_PER_BOOKING);
}

function filterAllowedAddonIds(ids, service) {
    const catalog = Array.isArray(service && service.addOnOptions)
        ? service.addOnOptions
        : [];
    const allowed = new Set(catalog.map(getAddonId).filter(Boolean));
    return ids.filter((id) => allowed.has(id));
}

function resolveChannelType(bookingData) {
    const raw = _safeTrim(bookingData && bookingData.channelType).toUpperCase();
    if (raw === CHANNEL_TYPE.ONLINE || raw === CHANNEL_TYPE.PRESENCIAL) {
        return raw;
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
    if (!currentServiceId && !currentSlug) {
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
            (UI && UI.BOOKING_API_TIMEOUT_MS) || 150000,
            "processDualBooking"
        );
        const bookingResult = normalizePublicError(result || resultError("EMPTY_BOOKING_RESPONSE"));

        const requiresPayment = Boolean(
            bookingResult &&
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.requiresPayment === true
        );
        const checkoutUrl = requiresPayment
            ? _safeTrim(bookingResult.data && bookingResult.data.checkoutUrl || "")
            : "";

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
                location.to(checkoutUrl);
                return;
            }
            try {
                await window.openLightbox("ConfirmacionReserva", {
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
$w.onReady(() => {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);
    if (!resolved) {
        console.error("[calendario-2] Servicio no valido", { traceId });
        return;
    }
    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;

    let widget;
    try {
        widget = $w("#html1");
    } catch (error) {
        console.error("[calendario-2] Widget HTML no disponible", {
            traceId,
            message: error && error.message,
        });
        return;
    }
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        console.error("[calendario-2] Widget HTML no disponible", { traceId });
        return;
    }
    try {
        // CAL-40: SIN allowOpaqueOrigin. El HTML del calendario rechaza
        // orígenes opacos (blob:, data:, filesystem:, "null"), así que el
        // bridge aplica la misma política. Ambos extremos son fail-closed
        // sobre HTTPS + allowlist de sufijos.
        bridge = createWidgetBridge(widget, {
            traceId,
            onContextReady: async (message, bridgeApi) => {
                try {
                    return await loadServiceContext(params);
                } catch (error) {
                    const code = error && error.code
                        ? error.code
                        : "SERVICE_LOAD_FAILED";
                    notifyContextError(
                        bridgeApi,
                        code,
                        "No se pudo cargar el servicio. Inténtalo de nuevo.",
                        traceId
                    );
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
