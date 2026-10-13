/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5005-CONSOLIDATED
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 *
 * Alineado con:
 *   - widget HTML (protocolo v1, messageId unico, addOnIds, slotF1/slotF2)
 *   - backend/reservas.web.js (getServiceBySlugOrId, getAvailableDays, getAvailableSlots, getCertifiedDualSlots)
 *   - backend/citasManager.web.js (processDualBooking)
 *   - CMS ServiciosCatalogo (field keys title, description, price, location, addOnOptions, staffOptions)
 *   - CMS ComplementosCatalogo (field key addonId = GUID del complemento)
 *
 * Contrato BOOK (raiz, sin legacy, sin alias):
 *   serviceId, slug,
 *   slotF1 {localStartDate, localEndDate, slotRef},
 *   slotF2 {localStartDate, localEndDate, slotRef} | null,
 *   resourceId, addOnIds[], email, firstName, lastName, phone,
 *   paymentMethod, rgpdConsent
 */

import wixLocation from "wix-location-frontend";
import wixWindowFrontend from "wix-window-frontend";

import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots
} from "backend/reservas.web.js";

import {
    MESSAGE_TYPES,
    URLS,
    UI,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;
let activeBookingMessageId = "";
let bookingInFlight = false;

function parseUrlParams() {
    const query = wixLocation.query || {};

    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "")
            .split(",")
            .map(_safeTrim)
            .filter(Boolean)
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

function getMessageType(message) {
    return String(message?.type || "").trim().toUpperCase();
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
    return {
        status: "ERROR",
        data: null,
        error: { code, message }
    };
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);

    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(result?.error?.message || "No se pudo cargar el servicio.");
    }

    currentService = result.data;

    currentServiceId = _safeTrim(
        result.data.serviceId || currentServiceId || ""
    ) || null;

    currentSlug = _safeTrim(
        result.data.slug || currentSlug || ""
    ) || null;

    return {
        ...result.data,
        serviceId: result.data.serviceId || currentServiceId,
        slug: result.data.slug || currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds
    };
}

function handleNavigation(payload) {
    const target = _safeTrim(payload?.target || "").toUpperCase();

    if (target === "SERVICIOS") {
        wixLocation.to(URLS?.SERVICIOS || "/reserva-online");
        return true;
    }
    if (target === "PRIVACY") {
        wixLocation.to(URLS?.PRIVACY_POLICY || "/politica-de-privacidad");
        return true;
    }
    return false;
}

function normalizeAvailabilityResult(result) {
    if (!result || typeof result !== "object") {
        return createResultError(
            "EMPTY_AVAILABILITY_RESPONSE",
            "No se recibió disponibilidad."
        );
    }

    if (result.status === "ERROR") {
        return result;
    }

    const data = result.data;

    if (Array.isArray(data)) {
        return {
            ...result,
            data
        };
    }

    if (data && Array.isArray(data.days)) {
        return {
            ...result,
            data: data.days
        };
    }

    if (data && Array.isArray(data.slots)) {
        return {
            ...result,
            data: data.slots
        };
    }

    return createResultError(
        "INVALID_AVAILABILITY_RESPONSE",
        "La respuesta no contiene fechas ni horarios válidos."
    );
}

async function handleAvailability(payload, reply) {
    if (!payload || typeof payload !== "object") {
        reply(
            MESSAGE_TYPES.AVAIL,
            {
                ...createResultError(
                    "INVALID_AVAILABILITY_REQUEST",
                    "La solicitud de disponibilidad no es válida."
                ),
                action: "",
                requestSequence: 0
            }
        );
        return;
    }

    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = normalizeAddOnIds(payload.addOnIds || payload.bookedAddOns);
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
                    "El año o mes solicitado no es válido."
                );
            } else {
                result = await withTimeout(
                    getAvailableDays(
                        currentServiceId || currentSlug,
                        _safeTrim(payload.resourceId || "") || null,
                        year,
                        month,
                        addOnIds
                    ),
                    UI?.FRONTEND_API_TIMEOUT_MS || 60000,
                    "getAvailableDays"
                );
            }
        } else if (action === "slots") {
            const dateYmd = _safeTrim(payload.dateYmd || "");

            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
                result = createResultError(
                    "INVALID_DATE",
                    "La fecha solicitada no es válida."
                );
            } else {
                result = await withTimeout(
                    currentService?.allowCombine
                        ? getCertifiedDualSlots(
                            currentServiceId || currentSlug,
                            _safeTrim(payload.resourceId || "") || null,
                            dateYmd,
                            addOnIds
                        )
                        : getAvailableSlots(
                            currentServiceId || currentSlug,
                            _safeTrim(payload.resourceId || "") || null,
                            dateYmd,
                            addOnIds
                        ),
                    UI?.FRONTEND_API_TIMEOUT_MS || 60000,
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
            error?.message || "No se pudo obtener disponibilidad."
        );
    }

    const normalizedResult = normalizeAvailabilityResult(result);

    reply(
        MESSAGE_TYPES.AVAIL,
        {
            ...normalizedResult,
            action,
            requestSequence: Number(payload.requestSequence) || 0
        }
    );
}

function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];

    return Array.from(
        new Set(
            value
                .map((item) => {
                    if (typeof item === "string") {
                        return _safeTrim(item);
                    }

                    if (item && typeof item === "object") {
                        return _safeTrim(item.addOnId || "");
                    }

                    return "";
                })
                .filter(Boolean)
        )
    ).slice(0, 20);
}

function normalizeSlot(slot) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
        return null;
    }

    const localStartDate = _safeTrim(slot.localStartDate || "");
    const localEndDate = _safeTrim(slot.localEndDate || "");
    const slotRef =
        slot.slotRef &&
        typeof slot.slotRef === "object" &&
        !Array.isArray(slot.slotRef)
            ? slot.slotRef
            : null;

    if (!localStartDate || !localEndDate || !slotRef) {
        return null;
    }

    return {
        localStartDate,
        localEndDate,
        slotRef
    };
}

function isValidBookingSlot(slot) {
    return Boolean(
        slot &&
        slot.localStartDate &&
        slot.localEndDate &&
        slot.slotRef
    );
}

function buildBookingRequestPayload(bookingData, fallbackTraceId) {
    const slotF1 = normalizeSlot(bookingData.slotF1);
    const slotF2 = bookingData.slotF2
        ? normalizeSlot(bookingData.slotF2)
        : null;

    const addOnIds = normalizeAddOnIds(bookingData.addOnIds);

    return {
        serviceId: currentServiceId || null,
        slug: currentSlug || null,
        slotF1,
        slotF2,
        resourceId: _safeTrim(bookingData.resourceId || "") || null,
        addOnIds,
        email: _safeTrim(bookingData.email || ""),
        firstName: _safeTrim(bookingData.firstName || ""),
        lastName: _safeTrim(bookingData.lastName || ""),
        phone: _safeTrim(bookingData.phone || ""),
        paymentMethod: _safeTrim(bookingData.paymentMethod || "") || null,
        rgpdConsent: bookingData.rgpdConsent === true,
        traceId: _safeTrim(fallbackTraceId || "") || makeTraceId("calendario-book")
    };
}

async function handleBooking(message, reply, traceId) {
    const bookingData = getPayload(message);

    if (!bookingData || typeof bookingData !== "object" || Array.isArray(bookingData)) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Los datos de la reserva no son validos."
            )
        );
        return;
    }

    const messageId = _safeTrim(message?.messageId || "");

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

    activeBookingMessageId = messageId;
    bookingInFlight = true;

    const requestPayload = buildBookingRequestPayload(
        bookingData,
        bookingData.traceId || traceId
    );

    if (!requestPayload.serviceId && !requestPayload.slug) {
        bookingInFlight = false;

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
        bookingInFlight = false;

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_SLOT_F1",
                "El horario seleccionado no es válido."
            )
        );
        return;
    }

    if (requestPayload.slotF2 && !isValidBookingSlot(requestPayload.slotF2)) {
        bookingInFlight = false;

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_SLOT_F2",
                "La segunda fase del horario no es válida."
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
        bookingInFlight = false;

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_CONTACT_DATA",
                "Faltan datos obligatorios de contacto o consentimiento."
            )
        );
        return;
    }

    try {
        const result = await withTimeout(
            processDualBooking(requestPayload),
            UI?.FRONTEND_API_TIMEOUT_MS || 60000,
            "processDualBooking"
        );

        const bookingResult = result || createResultError(
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
            if (bookingResult.data.requiresPayment && bookingResult.data.checkoutUrl) {
                wixLocation.to(bookingResult.data.checkoutUrl);
                return;
            }
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    {
                        booking: bookingResult.data || null,
                        bookingId: bookingResult.data.bookingId,
                        service: currentService,
                        traceId
                    }
                );
            } catch (lightboxError) {
                console.error(
                    "[calendario-2] No se pudo abrir ConfirmacionReserva",
                    { traceId, message: lightboxError?.message }
                );
            }
        }
    } catch (error) {
        bookingInFlight = false;

        const timeout =
            error?.code === "TIMEOUT" ||
            String(error?.message || "").toUpperCase().includes("TIMEOUT");

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                timeout
                    ? "La reserva esta tardando demasiado. Intentalo de nuevo."
                    : "No se pudo completar la reserva."
            )
        );
    }
}

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
                    console.warn(
                        "[calendario-2] Mensaje no soportado",
                        { traceId, type }
                    );
                }
            },

            onError: (error) => {
                console.error(
                    "[calendario-2] Error de comunicacion",
                    { traceId, message: error?.message }
                );
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error(
            "[calendario-2] Error de inicializacion",
            { traceId, message: error?.message }
        );
    }
});
