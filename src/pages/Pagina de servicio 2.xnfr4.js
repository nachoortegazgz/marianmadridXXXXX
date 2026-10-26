/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5021-URL-FIRST-CONTEXT
 * APIS: wix-location-frontend; wix-pricing-plans-frontend; backend/reservas.web.js; public/mmUtils; public/widgetBridge.
 *
 * RES-62 (P0): la URL es la fuente primaria de resolución: slug explícito,
 * slug de /service-page/{slug}, GUID serviceId y, como último recurso, ruta.
 * El backend resuelve el candidato contra ServiciosCatalogo y solo se prueba
 * el siguiente candidato cuando el anterior devuelve SERVICE_NOT_FOUND.
 * Se elimina la dependencia de getAppPageData() para cargar el contexto.
 */

import wixLocation from "wix-location-frontend";
import { checkout } from "wix-pricing-plans-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";

import {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    URLS,
    BOOKINGS_ADDON_CONFIG,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _safePathSlugOrId,
    _looksLikeGuid,
    toFiniteNumber,
    _getMessageType,
    _getPayload,
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set([
    "servicios",
    "service",
    "service-page",
    "servicio",
    "servicio-2",
]);

const MAX_ADDONS_PER_BOOKING =
    Number(
        BOOKINGS_ADDON_CONFIG &&
            BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA,
    ) || 5;

const WIDGET_ERROR_MESSAGES = Object.freeze({
    WIDGET_HANDSHAKE_TIMEOUT:
        "El componente de reserva tardó demasiado en cargar. Recarga la página.",
    WIDGET_CONTEXT_TIMEOUT:
        "No se pudieron recuperar los datos del servicio a tiempo. Recarga la página.",
    WIDGET_CONTEXT_FAILED:
        "No se pudieron cargar los datos del servicio.",
    WIDGET_PROTOCOL_VERSION_UNSUPPORTED:
        "Versión del componente no soportada. Recarga la página.",
    WIDGET_MESSAGE_TYPE_NOT_ALLOWED:
        "Mensaje no permitido por el protocolo.",
    WIDGET_MESSAGE_TYPE_MISSING:
        "Mensaje sin tipo. Recarga la página.",
    WIDGET_MESSAGE_TOO_LARGE:
        "El mensaje superó el tamaño permitido.",
    WIDGET_PAYLOAD_TOO_COMPLEX:
        "El mensaje era demasiado complejo.",
    WIDGET_MESSAGE_ID_INVALID:
        "Identificador de mensaje inválido.",
    WIDGET_MESSAGE_REJECTED:
        "Mensaje rechazado por el protocolo.",
    WIDGET_MESSAGE_HANDLER_FAILED:
        "Error interno al procesar el mensaje del componente.",
    WIDGET_MESSAGE_LISTENER_FAILED:
        "Error interno en un listener del componente.",
    WIDGET_BRIDGE_DESTROYED:
        "El componente de reserva ya no está activo.",
    WIDGET_INVALID_HTML_COMPONENT:
        "El componente de reserva no está disponible.",
});

let bridge = null;
let resolvedService = null;

/* =========================================================================
 * ERRORES
 * ========================================================================= */

function bridgeError(
    code,
    message,
    traceId,
    detail = null,
) {
    const causeMessage =
        detail?.causeMessage ||
        message ||
        "No se pudo cargar el servicio.";

    console.error("[servicio-2] Error del bridge", {
        traceId,
        code: code || null,
        message: causeMessage,
        causeCode: detail?.causeCode || null,
        causeStack: detail?.causeStack || null,
    });

    if (
        code === "WIDGET_ORIGIN_OPAQUE_REJECTED" ||
        code === "WIDGET_ORIGIN_REJECTED"
    ) {
        showError(
            "No se pudo conectar el componente de reserva. Recarga la página.",
        );
        return;
    }

    const humanMessage = code
        ? WIDGET_ERROR_MESSAGES[code]
        : "";
    if (humanMessage) {
        showError(humanMessage);
        return;
    }

    showError(causeMessage);
}

function serviceLookupError(result) {
    const code =
        result?.error?.code ||
        "SERVICE_LOOKUP_FAILED";

    const message =
        result?.error?.message ||
        "Servicio no encontrado.";

    const error = new Error(message);
    error.code = code;

    return error;
}

function showError(message) {
    const safeMessage =
        _safeTrim(message) ||
        "No se pudo cargar el servicio.";

    console.error("[servicio-2] Error:", safeMessage);

    try {
        const banner = $w("#errorBanner");

        if (!banner) {
            return;
        }

        banner.text = `Error: ${safeMessage}`;

        if (typeof banner.show === "function") {
            banner.show();
        }
    } catch (error) {
        console.warn(
            "[servicio-2] No se pudo mostrar el error:",
            error?.message || String(error),
        );
    }
}

/* =========================================================================
 * UTILIDADES
 * ========================================================================= */

function text(value, fallback = "") {
    return _safeTrim(value) || fallback;
}

function getServiceId(service) {
    return _safeTrim(service?.serviceId || "");
}

function getServiceSlug(service) {
    return _safeSlugOrId(service?.slug || "");
}

function getAddonId(item) {
    if (typeof item === "string") {
        return _safeTrim(item);
    }

    if (item && typeof item === "object") {
        return _safeTrim(
            item.addonId || item._id || item.id || "",
        );
    }

    return "";
}

function normalizeRecommendations(raw) {
    if (Array.isArray(raw)) return raw;

    if (typeof raw === "string" && raw.trim()) {
        const trimmed = raw.trim();

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
        } catch (_) {
            // No era JSON; continuar con la interpretación por líneas.
        }

        return trimmed
            .split(/\r?\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
    }

    return [];
}

/* =========================================================================
 * NORMALIZACION DEL SERVICIO
 * ========================================================================= */

function normalizeCatalogEntry(data) {
    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
    ) {
        throw new Error(
            "La entrada de catálogo recibida no es válida.",
        );
    }

    const catalogEntryType = text(
        data.catalogEntryType,
        "SERVICE",
    ).toUpperCase();

    const slug = getServiceSlug(data);

    if (!slug) {
        throw new Error(
            "La entrada de catálogo no tiene un slug válido.",
        );
    }

    if (
        !["SERVICE", "PRICING_PLAN"].includes(
            catalogEntryType,
        )
    ) {
        throw new Error(
            "Tipo de catálogo no compatible.",
        );
    }

    const currencyValue = text(
        data.currency,
        "EUR",
    ).toUpperCase();

    const common = {
        catalogEntryType,
        slug,
        title: text(data.title, "Servicio"),
        description: text(data.description),
        tagLine: text(data.tagLine),
        location: text(data.location),
        price: Math.max(
            0,
            toFiniteNumber(data.price),
        ),
        currency: /^[A-Z]{3}$/.test(currencyValue)
            ? currencyValue
            : "EUR",
        mainMedia: data.mainMedia || "",
        recommendations: normalizeRecommendations(
            data.recommendations ?? data.recomendaciones
        ),
        clientHidden: data.clientHidden === true,
    };

    if (catalogEntryType === "PRICING_PLAN") {
        const pricingPlanId = _safeTrim(
            data.pricingPlanId,
        );

        const sessionCount = Number(
            data.sessionCount,
        );

        if (!_looksLikeGuid(pricingPlanId)) {
            throw new Error(
                "El plan no tiene un identificador de Pricing Plans válido.",
            );
        }

        if (
            !Number.isSafeInteger(sessionCount) ||
            sessionCount < 1
        ) {
            throw new Error(
                "El plan debe incluir un número válido de sesiones.",
            );
        }

        return {
            ...common,
            pricingPlanId,
            sessionCount,
            serviceId: "",
            totalDuration: 0,
            addOnOptions: [],
            allowCombine: false,
            phase1Duration: 0,
            exposureDuration: 0,
            phase2Duration: 0,
            linkedPhases: "",
            primaryActionLabel: text(
                data.primaryActionLabel,
                "Comprar bono",
            ),
        };
    }

    const serviceId = getServiceId(data);

    if (!_looksLikeGuid(serviceId)) {
        throw new Error(
            "El servicio no tiene un identificador válido.",
        );
    }

    return {
        ...common,
        serviceId,
        pricingPlanId: "",
        sessionCount: 0,
        totalDuration: Math.max(
            0,
            toFiniteNumber(data.totalDuration),
        ),
        addOnOptions: Array.isArray(
            data.addOnOptions,
        )
            ? data.addOnOptions
            : [],
        allowCombine: data.allowCombine === true,
        phase1Duration: Math.max(
            0,
            toFiniteNumber(data.phase1Duration),
        ),
        exposureDuration: Math.max(
            0,
            toFiniteNumber(data.exposureDuration),
        ),
        phase2Duration: Math.max(
            0,
            toFiniteNumber(data.phase2Duration),
        ),
        linkedPhases:
            _safeTrim(data.linkedPhases) || "",
        primaryActionLabel: text(
            data.primaryActionLabel,
            "Reservar cita",
        ),
    };
}

/* =========================================================================
 * RESOLUCION DEL SERVICIO
 * ========================================================================= */

function resolveServiceLookups() {
    const query = wixLocation.query || {};
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const candidates = [];
    const seen = new Set();

    const addCandidate = (value) => {
        const candidate = _safeSlugOrId(value);
        if (!candidate || EXCLUDED_PATHS.has(candidate.toLowerCase())) return;
        const key = candidate.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
    };

    // 1. Explicit slug parameter from links generated by this site.
    addCandidate(query.slug);

    // 2. Canonical Wix Bookings route: /service-page/{public-slug}.
    const servicePageIndex = path.findIndex(
        (segment) => String(segment || "").toLowerCase() === "service-page",
    );
    if (servicePageIndex >= 0) {
        addCandidate(_safePathSlugOrId(path[servicePageIndex + 1]));
    }

    // 3. Stable GUID fallback. It is lower priority than a public slug and
    //    avoids treating a generic static page path as a catalog identifier.
    const queryServiceId = _safeTrim(query.serviceId);
    if (_looksLikeGuid(queryServiceId)) addCandidate(queryServiceId);

    // 4. Non-standard/custom service routes: try the last path segment last.
    for (let index = path.length - 1; index >= 0; index -= 1) {
        addCandidate(_safePathSlugOrId(path[index]));
    }

    return candidates;
}

async function loadService(lookupValue, traceId) {
    try {
        const result =
            await getServiceBySlugOrId(lookupValue);

        if (
            !result ||
            result.status !== "SUCCESS" ||
            !result.data ||
            typeof result.data !== "object" ||
            Array.isArray(result.data)
        ) {
            throw serviceLookupError(result);
        }

        const service = normalizeCatalogEntry(
            result.data,
        );

        console.log("servicio encontrado:", service);

        console.info(
            "[servicio-2] Servicio cargado",
            {
                traceId,
                lookupValue,
                serviceId: service.serviceId || null,
                slug: service.slug,
                catalogEntryType:
                    service.catalogEntryType,
            },
        );

        return service;
    } catch (error) {
        console.error(
            "[servicio-2] Error cargando servicio",
            {
                traceId,
                lookupValue,
                code:
                    error?.code ||
                    "SERVICE_LOAD_FAILED",
                message:
                    error?.message ||
                    String(error),
                stack: error?.stack || null,
            },
        );

        throw error;
    }
}

async function loadServiceWithRetry(lookupValue, traceId) {
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await loadService(lookupValue, traceId);
        } catch (error) {
            lastError = error;
            const code = String(error?.code || "").toUpperCase();
            const message = String(error?.message || error || "").toUpperCase();
            const retryable =
                /TIMEOUT|TRANSIENT|NETWORK|TEMPORARY|UNAVAILABLE|INTERNAL|RATE.?LIMIT|ECONN|FETCH|HTTP.?5\d\d|FAILED TO FETCH|REQUEST FAILED|CONNECTION RESET|SOCKET/.test(
                    code + " " + message,
                );

            if (!retryable || attempt === maxAttempts) throw error;

            const delayMs = Math.min(4000, 500 * 2 ** (attempt - 1));
            console.warn("[servicio-2] Reintentando lectura de servicio", {
                traceId, lookupValue, attempt, nextAttempt: attempt + 1,
                delayMs, code: code || null,
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw lastError || new Error("SERVICE_LOOKUP_FAILED");
}

async function loadServiceFromCandidates(candidates, traceId) {
    let lastNotFound = null;
    for (const candidate of candidates) {
        try {
            return await loadServiceWithRetry(candidate, traceId);
        } catch (error) {
            const code = String(error?.code || "").toUpperCase();
            // Fallback only for a definitive miss. Never mask rate limits,
            // transient failures, hidden services, or malformed catalog DTOs.
            if (code !== "SERVICE_NOT_FOUND") throw error;
            lastNotFound = error;
            console.warn("[servicio-2] Candidato no encontrado; probando el siguiente", {
                traceId, candidate, code,
            });
        }
    }
    throw lastNotFound || Object.assign(
        new Error("No se encontró el servicio en ServiciosCatalogo."),
        { code: "SERVICE_NOT_FOUND" },
    );
}

/* =========================================================================
 * RESERVAS Y COMPLEMENTOS
 * ========================================================================= */

function getAllowedAddOnIds(service) {
    const options =
        service &&
        Array.isArray(service.addOnOptions)
            ? service.addOnOptions
            : [];

    return new Set(
        options
            .map(getAddonId)
            .filter(Boolean),
    );
}

function getAddOnIds(payload, service) {
    if (
        !Array.isArray(
            payload?.addOnIds,
        )
    ) {
        return [];
    }

    const allowedIds =
        getAllowedAddOnIds(service);

    return Array.from(
        new Set(
            payload.addOnIds
                .map(getAddonId)
                .filter(Boolean),
        ),
    )
        .filter((id) => allowedIds.has(id))
        .slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
    if (
        service.catalogEntryType !== "SERVICE" ||
        !_looksLikeGuid(getServiceId(service))
    ) {
        throw new Error(
            "Solo los servicios reservables pueden abrir el calendario de citas.",
        );
    }

    const base = text(
        URLS?.CALENDARIO_2,
        "/booking-calendar/calendario-2",
    );

    const query = new URLSearchParams({
        slug: getServiceSlug(service),
        serviceId: getServiceId(service),
        referral: "servicio-2",
    });

    const addOnIds = getAddOnIds(
        payload,
        service,
    );

    if (addOnIds.length > 0) {
        query.set(
            "addOnIds",
            addOnIds.join(","),
        );
    }

    return `${base}?${query.toString()}`;
}

function getServicesUrl() {
    return text(
        URLS?.SERVICIOS,
        "/reserva-online",
    );
}

/* =========================================================================
 * INICIALIZACION DE LA PAGINA
 * ========================================================================= */

$w.onReady(async () => {
    const traceId = makeTraceId("servicio");

    let widget;

    try {
        widget = $w("#htmlWidgetCustomService");
    } catch (error) {
        showError(
            "El widget del servicio no está disponible.",
        );
        return;
    }

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        showError(
            "El widget del servicio no está disponible.",
        );
        return;
    }

    let lookupCandidates = [];
    let lookupValue = "";
    let resolveLookupReady;
    const lookupReady = new Promise((resolve) => {
        resolveLookupReady = resolve;
    });

    // Registrar el listener antes de cualquier API lenta: el iframe puede
    // emitir MM_READY en cuanto termina de cargar.
    try {
        bridge = createWidgetBridge(widget, {
            traceId,
            allowOpaqueOrigin: true,

            onContextReady: async (message, bridgeApi) => {
                await lookupReady;
                if (!lookupCandidates.length) {
                    const lookupError = new Error("No se pudo localizar el servicio en la URL.");
                    lookupError.code = "SERVICE_LOOKUP_MISSING";
                    throw lookupError;
                }
                if (resolvedService) {
                    return {
                        ...resolvedService,
                        recommendations:
                            Array.isArray(
                                resolvedService.recommendations,
                            )
                                ? resolvedService.recommendations
                                : [],
                        addOnOptions:
                            Array.isArray(
                                resolvedService.addOnOptions,
                            )
                                ? resolvedService.addOnOptions
                                : [],
                    };
                }

                try {
                    resolvedService =
                        await loadServiceFromCandidates(
                            lookupCandidates,
                            traceId,
                        );

                    return {
                        ...resolvedService,
                        recommendations:
                            Array.isArray(
                                resolvedService.recommendations,
                            )
                                ? resolvedService.recommendations
                                : [],
                        addOnOptions:
                            Array.isArray(
                                resolvedService.addOnOptions,
                            )
                                ? resolvedService.addOnOptions
                                : [],
                    };
                } catch (error) {
                    const code =
                        error?.code ||
                        "SERVICE_LOAD_FAILED";
                    const message =
                        error?.message ||
                        "No se pudo cargar el servicio.";

                    showError(message);
                    throw error;
                }
            },

            onWidgetMessage: async (
                message,
                reply,
            ) => {
                const type =
                    _getMessageType(message);

                if (
                    type === MESSAGE_TYPES.READY ||
                    type === MESSAGE_TYPES.CONTEXT
                ) {
                    return;
                }

                const payload =
                    _getPayload(message);

                if (!resolvedService) {
                    if (
                        type === MESSAGE_TYPES.BOOK
                    ) {
                        reply(
                            MESSAGE_TYPES.BOOK,
                            {
                                status: "ERROR",
                                error: {
                                    code: "SERVICE_NOT_READY",
                                    message:
                                        "El servicio aún se está cargando.",
                                },
                            },
                        );
                    }

                    return;
                }

                if (type === MESSAGE_TYPES.BOOK) {
                    if (
                        resolvedService.catalogEntryType ===
                        "PRICING_PLAN"
                    ) {
                        try {
                            const purchase =
                                await checkout.startOnlinePurchase(
                                    resolvedService.pricingPlanId,
                                );

                            console.info(
                                "[servicio-2] Compra de plan completada",
                                {
                                    traceId,
                                    pricingPlanId:
                                        resolvedService.pricingPlanId,
                                    orderId: text(
                                        purchase?.order?._id ||
                                            purchase?._id,
                                    ),
                                },
                            );

                            reply(
                                MESSAGE_TYPES.BOOK,
                                {
                                    status: "SUCCESS",
                                    data: {
                                        catalogEntryType:
                                            "PRICING_PLAN",
                                        title:
                                            resolvedService.title,
                                        sessionCount:
                                            resolvedService.sessionCount,
                                    },
                                },
                            );
                        } catch (error) {
                            console.warn(
                                "[servicio-2] Error comprando plan",
                                {
                                    traceId,
                                    pricingPlanId:
                                        resolvedService.pricingPlanId,
                                    code:
                                        error?.code ||
                                        "PRICING_PLAN_PURCHASE_FAILED",
                                    message:
                                        error?.message ||
                                        String(error),
                                },
                            );

                            reply(
                                MESSAGE_TYPES.BOOK,
                                {
                                    status: "ERROR",
                                    error: {
                                        code:
                                            "PRICING_PLAN_PURCHASE_FAILED",
                                        message:
                                            "No se ha podido completar la compra. Inténtalo de nuevo.",
                                    },
                                },
                            );

                            showError(
                                "No se ha podido completar la compra del bono. Inténtalo de nuevo.",
                            );
                        }

                        return;
                    }

                    try {
                        const bookingUrl =
                            buildBookingUrl(
                                resolvedService,
                                payload,
                            );

                        await wixLocation.to(
                            bookingUrl,
                        );

                        reply(
                            MESSAGE_TYPES.BOOK,
                            {
                                status: "SUCCESS",
                                data: {
                                    catalogEntryType:
                                        "SERVICE",
                                },
                            },
                        );
                    } catch (error) {
                        console.error(
                            "[servicio-2] Error creando URL de reserva",
                            {
                                traceId,
                                code:
                                    error?.code ||
                                    "BOOKING_URL_FAILED",
                                message:
                                    error?.message ||
                                    String(error),
                            },
                        );

                        reply(
                            MESSAGE_TYPES.BOOK,
                            {
                                status: "ERROR",
                                error: {
                                    code:
                                        "BOOKING_URL_FAILED",
                                    message:
                                        "No se pudo abrir el calendario de reservas.",
                                },
                            },
                        );
                    }

                    return;
                }

                if (type === MESSAGE_TYPES.NAV) {
                    const target = text(
                        payload?.target,
                    ).toUpperCase();

                    if (
                        !target ||
                        target === "SERVICIOS"
                    ) {
                        try {
                            await wixLocation.to(
                                getServicesUrl(),
                            );
                        } catch (error) {
                            console.warn(
                                "[servicio-2] No se pudo navegar a servicios",
                                {
                                    traceId,
                                    code:
                                        error?.code ||
                                        "NAV_FAILED",
                                    message:
                                        error?.message ||
                                        String(error),
                                },
                            );
                        }
                    }
                }
            },

            onError: (error, detail) => {
                bridgeError(
                    error?.code,
                    error?.message,
                    traceId,
                    detail,
                );
            },
        });

        if (!bridge) {
            showError(
                "No se pudo inicializar el widget del servicio.",
            );
        }
    } catch (error) {
        console.error(
            "[servicio-2] Error de inicialización",
            {
                traceId,
                code:
                    error?.code ||
                    "BRIDGE_INIT_FAILED",
                message:
                    error?.message ||
                    String(error),
                stack: error?.stack || null,
            },
        );

        showError(
            error?.message ||
                "No se pudo cargar el servicio.",
        );
    }

    // URL-first: route slug is the public catalog key; a GUID is only a
    // fallback. The bridge was already registered above, so the first
    // MM_READY is not lost while resolving this synchronous URL context.
    lookupCandidates = resolveServiceLookups();
    lookupValue = lookupCandidates[0] || "";
    console.info("[servicio-2] candidatos de servicio desde URL", {
        traceId,
        candidateCount: lookupCandidates.length,
        firstCandidate: lookupValue || null,
        candidates: lookupCandidates,
    });

    resolveLookupReady();
    if (!lookupCandidates.length) {
        showError("No se pudo localizar el servicio en la URL.");
        return;
    }


});