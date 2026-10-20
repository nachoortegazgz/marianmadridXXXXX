/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5017-CLEAN
 * APIS: wix-location-frontend; backend/reservas.web.js; public/mmUtils; public/widgetBridge.
 * DOC: https://www.wix.com/velo/reference/wix-location-frontend
 *      https://dev.wix.com/docs/rest/business-solutions/bookings/services/introduction
 */
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES, URLS, BOOKINGS_ADDON_CONFIG, makeTraceId,
    _safeTrim, _safeSlugOrId, _looksLikeGuid, toFiniteNumber,
    _getMessageType, _getPayload
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set(["servicios", "service", "servicio", "servicio-2"]);
const MAX_ADDONS_PER_BOOKING = Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;

let bridge = null;
let resolvedService = null;

/* ---------------- Helpers de error (agrupados) ---------------- */
function bridgeError(code, message, traceId, detail = null) {
    console.error("[servicio-2] Error del bridge", { traceId, code, message, detail });
    showError(
        code === "WIDGET_ORIGIN_OPAQUE_REJECTED" || code === "WIDGET_ORIGIN_REJECTED"
            ? "No se pudo conectar el componente de reserva. Recarga la pagina."
            : (detail && detail.cause && detail.cause.message) || message || "No se pudo cargar el servicio."
    );
}
function serviceLookupError(result) {
    const code = (result && result.error && result.error.code) || "SERVICE_LOOKUP_FAILED";
    const message = (result && result.error && result.error.message) || "Servicio no encontrado.";
    const error = new Error(message);
    error.code = code;
    return error;
}
function showError(message) {
    const safeMessage = _safeTrim(message) || "No se pudo cargar el servicio.";
    console.error("[servicio-2] Error:", safeMessage);
    try {
        const banner = $w("#errorBanner");
        if (!banner) return;
        banner.text = `Error: ${safeMessage}`;
        if (typeof banner.show === "function") banner.show();
    } catch (error) { console.warn("[servicio-2] No se pudo mostrar el error:", error && error.message); }
}

/* ---------------- Helpers de servicio ---------------- */
function text(value, fallback = "") { return _safeTrim(value) || fallback; }
function getServiceId(service) { return _safeTrim((service && service.serviceId) || ""); }
function getServiceSlug(service) { return _safeSlugOrId((service && service.slug) || ""); }
function getAddonId(item) {
    if (typeof item === "string") return _safeTrim(item);
    if (item && typeof item === "object") return _safeTrim(item.addonId || "");
    return "";
}

function normalizeService(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("El servicio recibido no es valido.");
    const serviceId = getServiceId(data);
    const slug = getServiceSlug(data);
    if (!_looksLikeGuid(serviceId)) throw new Error("El servicio no tiene un identificador valido.");
    if (!slug) throw new Error("El servicio no tiene un slug valido.");
    return {
        serviceId, slug,
        title: text(data.title, "Servicio"),
        description: text(data.description),
        tagLine: text(data.tagLine),
        location: text(data.location),
        totalDuration: Math.max(0, toFiniteNumber(data.totalDuration)),
        price: Math.max(0, toFiniteNumber(data.price)),
        currency: /^[A-Z]{3}$/.test(text(data.currency, "EUR").toUpperCase()) ? text(data.currency, "EUR").toUpperCase() : "EUR",
        mainMedia: data.mainMedia || "",
        addOnOptions: Array.isArray(data.addOnOptions) ? data.addOnOptions : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        allowCombine: data.allowCombine === true,
        phase1Duration: Math.max(0, toFiniteNumber(data.phase1Duration)),
        exposureDuration: Math.max(0, toFiniteNumber(data.exposureDuration)),
        phase2Duration: Math.max(0, toFiniteNumber(data.phase2Duration)),
        linkedPhases: _safeTrim(data.linkedPhases) || "",
        clientHidden: data.clientHidden === true,
        availableStaff: []
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
    const options = service && Array.isArray(service.addOnOptions) ? service.addOnOptions : [];
    return new Set(options.map(getAddonId).filter(Boolean));
}

function getAddOnIds(payload, service) {
    if (!Array.isArray(payload && payload.addOnIds)) return [];
    const allowedIds = getAllowedAddOnIds(service);
    return Array.from(new Set(payload.addOnIds.map(getAddonId).filter(Boolean)))
        .filter((id) => allowedIds.has(id))
        .slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
    const base = text(URLS && URLS.CALENDARIO_2, "/booking-calendar/calendario-2");
    const query = new URLSearchParams({
        slug: getServiceSlug(service),
        serviceId: getServiceId(service),
        referral: "servicio-2"
    });
    const addOnIds = getAddOnIds(payload, service);
    if (addOnIds.length > 0) query.set("addOnIds", addOnIds.join(","));
    return `${base}?${query.toString()}`;
}
function getServicesUrl() { return text(URLS && URLS.SERVICIOS, "/reserva-online"); }

async function loadService(lookupValue, traceId) {
    const result = await getServiceBySlugOrId(lookupValue);
    if (!result || result.status !== "SUCCESS" || !result.data || typeof result.data !== "object") {
        throw serviceLookupError(result);
    }
    const service = normalizeService(result.data);
    console.info("[servicio-2] Servicio cargado", { traceId, serviceId: service.serviceId, slug: service.slug });
    return service;
}

$w.onReady(() => {
    const traceId = makeTraceId("servicio");
    let widget;
    try { widget = $w("#htmlWidgetCustomService"); } catch (_) { showError("El widget del servicio no esta disponible."); return; }
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        showError("El widget del servicio no esta disponible."); return;
    }
    const lookupValue = resolveServiceLookup();
    if (!lookupValue) { showError("No se pudo localizar el servicio en la URL."); return; }
    try {
        bridge = createWidgetBridge(widget, {
            traceId,
            allowOpaqueOrigin: true, // iframes Wix → origin opaco
            onContextReady: async () => { resolvedService = await loadService(lookupValue, traceId); return resolvedService; },
            onWidgetMessage: async (message, reply) => {
                const type = _getMessageType(message);
                if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) return;
                const payload = _getPayload(message);
                if (!resolvedService) {
                    if (type === MESSAGE_TYPES.BOOK) reply(MESSAGE_TYPES.BOOK, { status: "ERROR", error: { code: "SERVICE_NOT_READY", message: "El servicio aun se esta cargando." } });
                    return;
                }
                if (type === MESSAGE_TYPES.BOOK) { wixLocation.to(buildBookingUrl(resolvedService, payload)); return; }
                if (type === MESSAGE_TYPES.NAV) {
                    const target = text(payload.target).toUpperCase();
                    if (!target || target === "SERVICIOS") wixLocation.to(getServicesUrl());
                }
            },
            onError: (error, detail) => bridgeError(error && error.code, error && error.message, traceId, detail)
        });
        if (!bridge) showError("No se pudo inicializar el widget del servicio.");
    } catch (error) {
        console.error("[servicio-2] Error de inicializacion", { traceId, code: error && error.code, message: error && error.message });
        showError((error && error.message) || "No se pudo cargar el servicio.");
    }
});