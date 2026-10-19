/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5008-CMS-ALIGNED
 * BASE: v5007-CMS-FINAL + alineacion con CMS KEY FIELDS y bookingSaga v5015.
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 *
 * ALINEACION:
 *   - widget HTML protocolo v1 (messageId unico, addOnIds, slotF1/slotF2)
 *   - backend/reservas.web.js v10.4-SSOT-CONSISTENT (getServiceBySlugOrId,
 *     getAvailableDays, getAvailableSlots, getCertifiedDualSlots)
 *   - backend/citasManager.web.js v10.7-SSOT-FAIL-CLOSED (processDualBooking)
 *   - backend/booking/bookingSaga.js v5015-CMS-ALIGNED
 *   - CMS ServiciosCatalogo KEY FIELDS (title, slug, price, location,
 *     addOnOptions via DTO canonico {addonId, name, price})
 *   - CMS ComplementosCatalogo KEY FIELDS (addonId = GUID fisico real)
 *
 * CONTRATO BOOK (raiz, sin legacy, sin alias):
 *   serviceId, slug,
 *   slotF1 {localStartDate, localEndDate, slotRef},
 *   slotF2 {localStartDate, localEndDate, slotRef} | null,
 *   resourceId, addOnIds[] (max 5 = BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA),
 *   email, firstName, lastName, phone,
 *   channelType ("ONLINE"|"PRESENCIAL"), rgpdConsent, traceId
 *   paymentMethod SOLO si es miembro valido de PAYMENT_METHOD enum
 *
 * NOTAS DE CONTRATO:
 *   - bookedAddOns PROHIBIDO desde frontend (SAGA-18). Solo addOnIds.
 *   - pairToken NO se envia. Saga v5015 lo recalcula (SAGA-30).
 *   - channelType es el discriminador de flujo. paymentMethod es opcional
 *     y solo se incluye si pertenece al enum PAYMENT_METHOD real.
 *   - resourceId se normaliza en frontend antes de enviar al backend.
 *     String vacio o no-GUID se convierte a null (consulta sin filtro).
 *
 * FIXES v5008-CMS-ALIGNED:
 *   CAL-12 (P0): eliminado bloque huerfano de normalizeAddOnIds que rompia
 *     el parseo del modulo (SyntaxError por return a nivel de modulo).
 *   CAL-13 (P1): normalizeSlot devuelve {localStartDate, localEndDate,
 *     slotRef}. El slotRef se conserva como referencia del widget; la
 *     revalidacion en backend se hace por fechas.
 *   CAL-14 (P2): validateBookingSlot usa isValidBookingSlot compartido
 *     para consistencia con bookingSaga._validateCreateBookingResponse.
 *
 * FIXES HEREDADOS v5007-CMS-FINAL: CAL-07..CAL-11.
 * FIXES HEREDADOS v5006-CMS-FINAL: CAL-01..CAL-06.
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
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    withTimeout,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;
let activeBookingMessageId = "";
let bookingInFlight = false;

/* CAL-01 heredado: canales canonicos (espejo CHANNEL_TYPE, Biblia 6.3). */
const CHANNEL_ONLINE = "ONLINE";
const CHANNEL_PRESENCIAL = "PRESENCIAL";

/* CAL-03 heredado: mismo limite que bookingSaga.MAX_ADDONS_PER_BOOKING. */
const MAX_ADDONS_PER_BOOKING =
    Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;

/* CAL-08: miembros validos del enum PAYMENT_METHOD (Biblia 6.3). */
const VALID_PAYMENT_METHODS = Object.freeze(new Set([
    "EFECTIVO",
    "TARJETA",
    "BIZUM",
    "TRANSFERENCIA",
    "WIX_PAYMENTS",
    "OTRO",
    "TARJETA_REGALO",
]));

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
function getMessageType(message) {
    return String((message && message.type) || "").trim().toUpperCase();
}

function getPayload(message) {
    if (
        message &&
        message.payload &&
        typeof message.payload === "object" &&
        !Array.isArray(message.payload)
    ) {
        return message.payload;
    }
    return {};
}

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

function isValidDateYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parts = value.split("-").map(Number);
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function normalizeAvailabilityResult(result) {
    if (!result || typeof result !== "object") {
        return createResultError(
            "EMPTY_AVAILABILITY_RESPONSE",
            "No se recibio disponibilidad."
        );
    }
    if (result.status === "ERROR") return result;
    const data = result.data;
    if (Array.isArray(data)) return { ...result, data };
    if (data && Array.isArray(data.days)) return { ...result, data: data.days };
    if (data && Array.isArray(data.slots)) return { ...result, data: data.slots };
    return createResultError(
        "INVALID_AVAILABILITY_RESPONSE",
        "La respuesta no contiene fechas ni horarios validos."
    );
}

// =============================================================================
// ADD-ONS NORMALIZATION (CAL-02 + CAL-03 + CAL-07 + CAL-12)
// =============================================================================
function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    const normalized = Array.from(
        new Set(
            value
                .map((item) => {
                    if (typeof item === "string") return _safeTrim(item);
                    if (item && typeof item === "object") {
                        return _safeTrim(item.addonId || item.addOnId || "");
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
// RESOURCE ID NORMALIZATION (CAL-09)
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
// CHANNEL TYPE RESOLUTION (CAL-01)
// =============================================================================
function resolveChannelType(bookingData) {
    const raw = _safeTrim(
        (bookingData && bookingData.channelType) ||
        (bookingData && bookingData.paymentMethod) ||
        ""
    ).toUpperCase();
    if (raw === CHANNEL_ONLINE || raw === CHANNEL_PRESENCIAL) return raw;
    if (raw) {
        console.warn("[calendario-2] channelType/paymentMethod no reconocido", {
            raw,
        });
    }
    return null;
}

// =============================================================================
// SLOT NORMALIZATION (CAL-13)
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
// BOOKING REQUEST PAYLOAD (CAL-01 + CAL-04 + CAL-05 + CAL-08)
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
// AVAILABILITY HANDLER (CAL-09)
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
    const resourceId = normalizeResourceId(payload.resourceId);
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
            if (!isValidDateYmd(dateYmd)) {
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
        requestSequence: Number(payload.requestSequence) || 0,
    });
}

// =============================================================================
// BOOKING HANDLER
// =============================================================================
async function handleBooking(message, reply, traceId) {
    const bookingData = getPayload(message);
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
    const requestPayload = buildBookingRequestPayload(
        bookingData,
        bookingData.traceId || traceId
    );
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
            onContextReady: async () => loadServiceContext(params),
            onWidgetMessage: async (message, reply) => {
                const type = getMessageType(message);
                const payload = getPayload(message);
                if (type === MESSAGE_TYPES.NAV) {
                    handleNavigation(payload);
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
                    message: error && error.message,
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