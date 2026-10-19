/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5011
 * BASE: v5010-CLEAN + allowOpaqueOrigin en bridge
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 *
 * FIXES v5011:
 *   CAL-18 (P0): allowOpaqueOrigin: true en createWidgetBridge. Mismo
 *     motivo que SVC-15-01 en servicio-2. Sin este flag, el widget de
 *     calendario no puede completar el handshake cuando el navegador
 *     asigna un origin opaco al iframe.
 *
 * FIXES HEREDADOS v5010: CLEAN-10..CLEAN-14.
 * FIXES HEREDADOS v5009: CAL-15..CAL-17 (D1/D2/D3).
 * FIXES HEREDADOS v5008: CAL-12..CAL-14.
 * FIXES HEREDADOS v5007: CAL-07..CAL-11.
 * FIXES HEREDADOS v5006: CAL-01..CAL-06.
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

const MAX_ADDONS_PER_BOOKING =
    Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;

const VALID_PAYMENT_METHODS = Object.freeze(
    new Set(Object.values(PAYMENT_METHOD))
);

// =============================================================================
// URL PARAMS Y SERVICE CONTEXT
// =============================================================================
function parseUrlParams() {
    const query = wixLocation.query || {};
    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "")
            .split(",")
            .map(_safeTrim)
            .filter(Boolean),
    };
}

function resolveServiceFromParams(params) {
    if (params.serviceId && _looksLikeGuid(params.serviceId)) {
        return { serviceId: params.serviceId, slug: params.slug || null };
    }
    if (params.slug) {
        return { serviceId: null, slug: params.slug };
    }
    return null;
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);
    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            (result && result.error && result.error.message) ||
            "No se pudo cargar el servicio."
        );
    }
    currentService = result.data;
    currentServiceId =
        _safeTrim(result.data.serviceId || "") || currentServiceId || null;
    currentSlug =
        _safeTrim(result.data.slug || "") || currentSlug || null;
    return {
        ...result.data,
        serviceId: currentServiceId,
        slug: currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds,
    };
}

// =============================================================================
// MESSAGE HANDLING HELPERS
// =============================================================================
function createResultError(code, message) {
    return { status: "ERROR", data: null, error: { code, message } };
}

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
        return createResultError(
            "EMPTY_AVAILABILITY_RESPONSE",
            "No se recibio disponibilidad."
        );
    }
    if (result.status === "ERROR") return result;
    if (Array.isArray(result.data)) return result;
    return createResultError(
        "INVALID_AVAILABILITY_RESPONSE",
        "La respuesta no contiene fechas ni horarios validos."
    );
}

// =============================================================================
// ADD-ONS NORMALIZATION
// =============================================================================
function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    const normalized = Array.from(
        new Set(
            value
                .map((item) => {
                    if (typeof item === "string") return _safeTrim(item);
                    if (item && typeof item === "object") {
                        return _safeTrim(item.addonId || "");
                    }
                    return "";
                })
                .filter(Boolean)
        )
    );
    if (normalized.length > MAX_ADDONS_PER_BOOKING) {
        console.warn("[calendario-2] addOnIds por encima del limite; se trunca", {
            received: normalized.length,
            max: MAX_ADDONS_PER_BOOKING,
        });
    }
    return normalized.slice(0, MAX_ADDONS_PER_BOOKING);
}

// =============================================================================
// RESOURCE ID NORMALIZATION
// =============================================================================
function normalizeResourceId(value) {
    const trimmed = _safeTrim(value || "");
    if (!trimmed) return null;
    if (!_looksLikeGuid(trimmed)) {
        const error = new Error("El profesional seleccionado no es valido.");
        error.code = "INVALID_RESOURCE_ID";
        throw error;
    }
    return trimmed;
}

// =============================================================================
// CHANNEL TYPE RESOLUTION
// =============================================================================
function resolveChannelType(bookingData) {
    const raw = _safeTrim(
        (bookingData && bookingData.channelType) ||
        (bookingData && bookingData.paymentMethod) ||
        ""
    ).toUpperCase();
    if (raw === CHANNEL_TYPE.ONLINE || raw === CHANNEL_TYPE.PRESENCIAL) {
        return raw;
    }
    if (raw) {
        console.warn("[calendario-2] channelType/paymentMethod no reconocido", {
            raw,
        });
    }
    return null;
}

// =============================================================================
// SLOT NORMALIZATION
// =============================================================================
function normalizeSlot(slot) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
    const localStartDate = _safeTrim(slot.localStartDate || "");
    const localEndDate = _safeTrim(slot.localEndDate || "");
    const slotRef =
        slot.slotRef &&
        typeof slot.slotRef === "object" &&
        !Array.isArray(slot.slotRef)
            ? slot.slotRef
            : null;
    if (!localStartDate || !localEndDate || !slotRef) return null;
    return { localStartDate, localEndDate, slotRef };
}

function isValidBookingSlot(slot) {
    return Boolean(
        slot && slot.localStartDate && slot.localEndDate && slot.slotRef
    );
}

// =============================================================================
// BOOKING REQUEST PAYLOAD
// =============================================================================
function buildBookingRequestPayload(bookingData, fallbackTraceId) {
    const slotF1 = normalizeSlot(bookingData.slotF1);
    const slotF2 = bookingData.slotF2
        ? normalizeSlot(bookingData.slotF2)
        : null;
    const addOnIds = normalizeAddOnIds(bookingData.addOnIds);
    const channelType = resolveChannelType(bookingData);
    const rawPaymentMethod = _safeTrim(
        bookingData.paymentMethod || ""
    ).toUpperCase();
    const paymentMethod = VALID_PAYMENT_METHODS.has(rawPaymentMethod)
        ? rawPaymentMethod
        : null;
    const payload = {
        serviceId: currentServiceId || null,
        slug: currentSlug || null,
        slotF1,
        slotF2,
        resourceId: normalizeResourceId(bookingData.resourceId),
        addOnIds,
        email: _safeTrim(bookingData.email || ""),
        firstName: _safeTrim(bookingData.firstName || ""),
        lastName: _safeTrim(bookingData.lastName || ""),
        phone: _safeTrim(bookingData.phone || ""),
        channelType,
        rgpdConsent: bookingData.rgpdConsent === true,
        traceId:
            _safeTrim(fallbackTraceId || "") ||
            makeTraceId("calendario-book"),
    };
    if (paymentMethod) {
        payload.paymentMethod = paymentMethod;
    }
    return payload;
}

// =============================================================================
// AVAILABILITY HANDLER
// =============================================================================
async function handleAvailability(payload, reply) {
    if (!payload || typeof payload !== "object") {
        reply(MESSAGE_TYPES.AVAIL, {
            ...createResultError(
                "INVALID_AVAILABILITY_REQUEST",
                "La solicitud de disponibilidad no es valida."
            ),
            action: "",
            requestSequence: 0,
        });
        return;
    }
    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = normalizeAddOnIds(payload.addOnIds);
    const requestSequence = Number(payload.requestSequence) || 0;

    let resourceId;
    try {
        resourceId = normalizeResourceId(payload.resourceId);
    } catch (error) {
        reply(MESSAGE_TYPES.AVAIL, {
            ...createResultError(
                (error && error.code) || "INVALID_RESOURCE_ID",
                (error && error.message) ||
                    "El profesional seleccionado no es valido."
            ),
            action,
            requestSequence,
        });
        return;
    }

    let result;
    try {
        if (action === "days") {
            const year = Number(payload.year);
            const month = Number(payload.month);
            if (
                !Number.isInteger(year) ||
                !Number.isInteger(month) ||
                month < 1 ||
                month > 12
            ) {
                result = createResultError(
                    "INVALID_DATE_RANGE",
                    "El periodo solicitado no es valido."
                );
            } else {
                result = await withTimeout(
                    getAvailableDays(
                        currentServiceId || currentSlug,
                        resourceId,
                        year,
                        month,
                        addOnIds
                    ),
                    (UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000,
                    "getAvailableDays"
                );
            }
        } else if (action === "slots") {
            const dateYmd = _safeTrim(payload.dateYmd || "");
            if (!isDateYmd(dateYmd)) {
                result = createResultError(
                    "INVALID_DATE",
                    "La fecha solicitada no es valida."
                );
            } else {
                result = await withTimeout(
                    currentService && currentService.allowCombine
                        ? getCertifiedDualSlots(
                            currentServiceId || currentSlug,
                            resourceId,
                            dateYmd,
                            addOnIds
                        )
                        : getAvailableSlots(
                            currentServiceId || currentSlug,
                            resourceId,
                            dateYmd,
                            addOnIds
                        ),
                    (UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000,
                    "getAvailableSlots"
                );
            }
        } else {
            result = createResultError(
                "INVALID_AVAILABILITY_REQUEST",
                "Solicitud de disponibilidad no valida."
            );
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            (error && error.message) || "No se pudo obtener disponibilidad."
        );
    }
    const normalizedResult = normalizeAvailabilityResult(result);
    reply(MESSAGE_TYPES.AVAIL, {
        ...normalizedResult,
        action,
        requestSequence,
    });
}

// =============================================================================
// BOOKING HANDLER
// =============================================================================
async function handleBooking(message, reply, traceId) {
    const bookingData = _getPayload(message);
    if (
        !bookingData ||
        typeof bookingData !== "object" ||
        Array.isArray(bookingData)
    ) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Los datos de la reserva no son validos."
            )
        );
        return;
    }
    const messageId = _safeTrim((message && message.messageId) || "");
    if (!messageId) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "MISSING_MESSAGE_ID",
                "La solicitud de reserva no tiene identificador."
            )
        );
        return;
    }
    if (bookingInFlight) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "DUPLICATE_REQUEST",
                "La solicitud anterior sigue en curso."
            )
        );
        return;
    }
    if (messageId === activeBookingMessageId) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "DUPLICATE_REQUEST",
                "Esta solicitud ya fue procesada."
            )
        );
        return;
    }

    if (!currentServiceId) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "SERVICE_NOT_READY",
                "El servicio aun se esta cargando. Intentalo de nuevo."
            )
        );
        return;
    }

    let requestPayload;
    try {
        requestPayload = buildBookingRequestPayload(
            bookingData,
            bookingData.traceId || traceId
        );
    } catch (error) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                (error && error.code) || "INVALID_RESOURCE_ID",
                (error && error.message) ||
                    "El profesional seleccionado no es valido."
            )
        );
        return;
    }

    if (!requestPayload.channelType) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_CHANNEL_TYPE",
                "Selecciona una modalidad de reserva valida."
            )
        );
        return;
    }
    if (!requestPayload.serviceId && !requestPayload.slug) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "MISSING_SERVICE",
                "No se pudo identificar el servicio."
            )
        );
        return;
    }
    if (!isValidBookingSlot(requestPayload.slotF1)) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_SLOT_F1",
                "El horario seleccionado no es valido."
            )
        );
        return;
    }
    if (
        requestPayload.slotF2 &&
        !isValidBookingSlot(requestPayload.slotF2)
    ) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_SLOT_F2",
                "La segunda fase del horario no es valida."
            )
        );
        return;
    }
    if (
        !requestPayload.email ||
        !requestPayload.firstName ||
        !requestPayload.phone ||
        requestPayload.rgpdConsent !== true
    ) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_CONTACT_DATA",
                "Faltan datos obligatorios de contacto o consentimiento."
            )
        );
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
        const bookingResult =
            result ||
            createResultError(
                "EMPTY_BOOKING_RESPONSE",
                "No se recibio respuesta de la reserva."
            );
        reply(MESSAGE_TYPES.BOOK, bookingResult);
        bookingInFlight = false;
        if (
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.bookingId
        ) {
            if (
                bookingResult.data.requiresPayment &&
                bookingResult.data.checkoutUrl
            ) {
                wixLocation.to(bookingResult.data.checkoutUrl);
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
                console.error(
                    "[calendario-2] No se pudo abrir ConfirmacionReserva",
                    { traceId, message: lightboxError && lightboxError.message }
                );
            }
        }
    } catch (error) {
        bookingInFlight = false;
        const timeout =
            (error && error.code === "TIMEOUT") ||
            String((error && error.message) || "")
                .toUpperCase()
                .includes("TIMEOUT");
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_STATUS_UNCERTAIN" : "BOOKING_FAILED",
                timeout
                    ? "La solicitud sigue procesandose. No la envies de nuevo todavia."
                    : "No se pudo completar la reserva."
            )
        );
    }
}

// =============================================================================
// PAGE INITIALIZATION
// =============================================================================
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
    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error("[calendario-2] Widget HTML no disponible", { traceId });
        return;
    }
    try {
        bridge = createWidgetBridge(widget, {
            traceId,
            // CAL-18: mismo motivo que SVC-15-01. Wix HTML Components se
            // sirven en iframes sandboxed; event.origin puede llegar como
            // "" o "null". La pagina no puede forzarlo. allowOpaqueOrigin:
            // true es la relajacion minima; los origins no opacos siguen
            // validados por sufijo y la seguridad la aportan las capas
            // superiores (messageId/version/payload limits + business rules
            // + citasManager DTO allowlist + saga + CMS auth.elevate).
            allowOpaqueOrigin: true,
            onContextReady: async () => loadServiceContext(params),
            onWidgetMessage: async (message, reply) => {
                const type = _getMessageType(message);
                const payload = _getPayload(message);
                if (type === MESSAGE_TYPES.NAV) {
                    const handled = handleNavigation(payload);
                    if (!handled) {
                        reply(
                            MESSAGE_TYPES.NAV,
                            createResultError(
                                "INVALID_NAV_TARGET",
                                "Destino de navegacion no reconocido."
                            )
                        );
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
                if (
                    type !== MESSAGE_TYPES.READY &&
                    type !== MESSAGE_TYPES.CONTEXT
                ) {
                    console.warn("[calendario-2] Mensaje no soportado", {
                        traceId,
                        type,
                    });
                }
            },
            onError: (error) => {
                console.error("[calendario-2] Error de comunicacion", {
                    traceId,
                    code: error && error.code,
                    message: error && error.message,
                    detail: error && error.detail,
                });
            },
        });
        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error("[calendario-2] Error de inicializacion", {
            traceId,
            message: error && error.message,
        });
    }
});