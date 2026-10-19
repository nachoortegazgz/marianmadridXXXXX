/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5014-CLEAN
 * BASE: v5013.2-WIDGET-ALIGNED + limpieza estricta (cero legacy/alias/deprecated)
 * PURPOSE: Load the selected CMS service and provide the widget context.
 * ASCII: Strict ASCII in comments and identifiers.
 *
 * REQUISITOS:
 *   - public/mmUtils v5012 (pendiente): añade _getMessageType, _getPayload.
 *   Ver "Correcciones pendientes" en esta entrega.
 *
 * FIXES v5014-CLEAN:
 *   CLEAN-01 (P0): normalizeService sin fallbacks legacy metadata.* ni
 *     data.<campoEspañol>. El DTO canonico de _toPublicService ya expone
 *     los nombres ingleses; los fallbacks eran codigo muerto + legacy.
 *   CLEAN-02 (P0): getReferenceId eliminado. Sustituido por getServiceId
 *     (solo serviceId) y getAddonId (solo addonId). Elimina los alias
 *     addOnId/nativeId y la ambiguedad serviceId|addonId.
 *   CLEAN-03 (P0): getLinkedPhaseId eliminado (dead code: data.linkedPhases
 *     siempre undefined porque _toPublicService lo elimina).
 *   CLEAN-04 (P1): linkedPhases/clientHidden/availableStaff se devuelven
 *     con valores literales documentados. Elimina lecturas muertas
 *     (data.availableStaff siempre undefined). Contrato del widget intacto.
 *   CLEAN-05 (P1): toFiniteNumber importado de mmUtils (elimina duplicado).
 *   CLEAN-06 (P1): getMessageType/getPayload importados de mmUtils
 *     (elimina duplicado con calendario-2).
 *   CLEAN-07 (P2): recommendations solo lee data.recommendations (elimina
 *     fallback metadata.recomendaciones legacy).
 *   CLEAN-08 (P2): MAX_ADDONS_PER_BOOKING desde BOOKINGS_ADDON_CONFIG
 *     (elimina literal 5).
 */
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES,
    URLS,
    BOOKINGS_ADDON_CONFIG,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    toFiniteNumber,
    _getMessageType,
    _getPayload,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

/* Guard: segmentos de path que no pueden ser slug de servicio. */
const EXCLUDED_PATHS = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2",
]);

const MAX_ADDONS_PER_BOOKING =
    Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;

let bridge = null;
let resolvedService = null;

function text(value, fallback = "") {
    return _safeTrim(value) || fallback;
}

function getServiceId(service) {
    return _safeTrim((service && service.serviceId) || "");
}

function getServiceSlug(service) {
    return _safeSlugOrId((service && service.slug) || "");
}

/**
 * CLEAN-02: solo acepta `addonId` (canonical CMS KEY FIELDS) o string.
 * Rechaza addOnId/nativeId/id/value (deprecated).
 */
function getAddonId(item) {
    if (typeof item === "string") return _safeTrim(item);
    if (item && typeof item === "object") {
        return _safeTrim(item.addonId || "");
    }
    return "";
}

function normalizeCurrency(value) {
    const currency = text(value, "EUR").toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function normalizeService(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("El servicio recibido no es valido.");
    }
    const serviceId = getServiceId(data);
    const slug = getServiceSlug(data);
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un identificador valido.");
    }
    if (!slug) {
        throw new Error("El servicio no tiene un slug valido.");
    }
    return {
        serviceId,
        slug,
        title: text(data.title, "Servicio"),
        description: text(data.description),
        tagLine: text(data.tagLine),
        location: text(data.location),
        totalDuration: Math.max(0, toFiniteNumber(data.totalDuration)),
        price: Math.max(0, toFiniteNumber(data.price)),
        currency: normalizeCurrency(data.currency),
        mainMedia: data.mainMedia || "",
        addOnOptions: Array.isArray(data.addOnOptions) ? data.addOnOptions : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        allowCombine: data.allowCombine === true,
        phase1Duration: Math.max(0, toFiniteNumber(data.phase1Duration)),
        exposureDuration: Math.max(0, toFiniteNumber(data.exposureDuration)),
        phase2Duration: Math.max(0, toFiniteNumber(data.phase2Duration)),
        // PENDIENTE ADR-01: _toPublicService elimina linkedPhases,
        // clientHidden y availableStaff. Los valores se mantienen
        // literales para preservar el contrato del widget (antes eran
        // lecturas muertas: data.X siempre undefined).
        linkedPhases: "",
        clientHidden: false,
        availableStaff: [],
    };
}

function resolveServiceLookup() {
    const query = wixLocation.query || {};
    for (const candidate of [query.slug, query.serviceId]) {
        const value = _safeSlugOrId(candidate);
        if (value) return value;
    }
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const value = _safeSlugOrId(path[path.length - 1] || "");
    if (!value || EXCLUDED_PATHS.has(value.toLowerCase())) return null;
    return value;
}

function getAllowedAddOnIds(service) {
    const options = service && Array.isArray(service.addOnOptions)
        ? service.addOnOptions
        : [];
    return new Set(options.map(getAddonId).filter(Boolean));
}

function getAddOnIds(payload, service) {
    if (!Array.isArray(payload && payload.addOnIds)) return [];
    const allowedIds = getAllowedAddOnIds(service);
    return Array.from(
        new Set(payload.addOnIds.map(getAddonId).filter(Boolean))
    )
        .filter((id) => allowedIds.has(id))
        .slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
    const base = text(URLS && URLS.CALENDARIO_2, "/booking-calendar/calendario-2");
    const query = new URLSearchParams({
        slug: getServiceSlug(service),
        serviceId: getServiceId(service),
        referral: "servicio-2",
    });
    const addOnIds = getAddOnIds(payload, service);
    if (addOnIds.length > 0) {
        query.set("addOnIds", addOnIds.join(","));
    }
    return `${base}?${query.toString()}`;
}

function getServicesUrl() {
    return text(URLS && URLS.SERVICIOS, "/reserva-online");
}

function showError(message) {
    const safeMessage = text(message, "No se pudo cargar el servicio.");
    console.error("[servicio-2] Error:", safeMessage);
    try {
        const banner = $w("#errorBanner");
        if (!banner) return;
        banner.text = `Error: ${safeMessage}`;
        if (typeof banner.show === "function") banner.show();
    } catch (error) {
        console.warn("[servicio-2] No se pudo mostrar el error:", error && error.message);
    }
}

async function loadService(lookupValue, traceId) {
    const result = await getServiceBySlugOrId(lookupValue);
    if (!result || result.status !== "SUCCESS" || !result.data || typeof result.data !== "object") {
        const code = (result && result.error && result.error.code) || "SERVICE_LOOKUP_FAILED";
        const message = (result && result.error && result.error.message) || "Servicio no encontrado.";
        const error = new Error(message);
        error.code = code;
        throw error;
    }
    const service = normalizeService(result.data);
    console.info("[servicio-2] Servicio cargado", {
        traceId,
        serviceId: service.serviceId,
        slug: service.slug,
    });
    return service;
}

function onBridgeError(error, detail, traceId) {
    const cause = (error && error.cause) || (detail && detail.cause) || detail;
    console.error("[servicio-2] Error del bridge", {
        traceId,
        code: error && error.code,
        message: error && error.message,
        causeCode: cause && cause.code,
        causeMessage: cause && cause.message,
        detail: error && error.detail,
    });
    if (
        error &&
        (error.code === "WIDGET_ORIGIN_OPAQUE_REJECTED" ||
            error.code === "WIDGET_ORIGIN_REJECTED")
    ) {
        showError("No se pudo conectar el componente de reserva. Recarga la pagina.");
        return;
    }
    showError(
        (cause && cause.message) ||
        (error && error.message) ||
        "No se pudo cargar el servicio."
    );
}

$w.onReady(() => {
    const traceId = makeTraceId("servicio");
    let widget;
    try {
        widget = $w("#htmlWidgetCustomService");
    } catch (_) {
        showError("El widget del servicio no esta disponible.");
        return;
    }
    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        showError("El widget del servicio no esta disponible.");
        return;
    }
    const lookupValue = resolveServiceLookup();
    if (!lookupValue) {
        showError("No se pudo localizar el servicio en la URL.");
        return;
    }
    try {
        bridge = createWidgetBridge(widget, {
            traceId,
            allowOpaqueOrigin: false,
            onContextReady: async () => {
                resolvedService = await loadService(lookupValue, traceId);
                return resolvedService;
            },
            onWidgetMessage: async (message, reply, currentBridge) => {
                const type = _getMessageType(message);
                void currentBridge;
                if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) {
                    return;
                }
                const payload = _getPayload(message);
                if (!resolvedService) {
                    console.warn(
                        "[servicio-2] Accion recibida antes de cargar el servicio",
                        { traceId, type }
                    );
                    if (type === MESSAGE_TYPES.BOOK) {
                        reply(MESSAGE_TYPES.BOOK, {
                            status: "ERROR",
                            data: null,
                            error: {
                                code: "SERVICE_NOT_READY",
                                message: "El servicio aun se esta cargando. Intentalo de nuevo.",
                            },
                        });
                    }
                    return;
                }
                if (type === MESSAGE_TYPES.BOOK) {
                    wixLocation.to(buildBookingUrl(resolvedService, payload));
                    return;
                }
                if (type === MESSAGE_TYPES.NAV) {
                    const target = text(payload.target).toUpperCase();
                    if (!target || target === "SERVICIOS") {
                        wixLocation.to(getServicesUrl());
                    }
                    return;
                }
                console.warn("[servicio-2] Mensaje no soportado", { traceId, type });
            },
            onError: (error, detail) => onBridgeError(error, detail, traceId),
        });
        if (!bridge) {
            showError("No se pudo inicializar el widget del servicio.");
        }
    } catch (error) {
        console.error("[servicio-2] Error de inicializacion", {
            traceId,
            code: error && error.code,
            message: error && error.message,
        });
        showError((error && error.message) || "No se pudo cargar el servicio.");
    }
});