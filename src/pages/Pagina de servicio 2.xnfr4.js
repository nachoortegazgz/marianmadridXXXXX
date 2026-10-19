/*
=============================================================================
FILE: pages/servicio-2.js
VERSION: v5013.8-VERIFIED
BASE: v5013.7-SLUG-SAFE + verificacion sintactica completa.
PURPOSE: Load the selected CMS service and provide the widget context.
ASCII: Strict ASCII in comments and identifiers.
V5013.8: Sintaxis verificada linea por linea. Cero template literals.
Cero operadores truncados. Cero comentarios sin cerrar.
DATABASE_ERROR fuera de RETRYABLE_CODES. Cero logs en flujo feliz.
allowOpaqueOrigin:true + allowedOriginSuffixes mantenido.
NOTA: Los enlaces a paginas de servicio DEBEN construirse con item.slug
directamente desde ServiciosCatalogo. La normalizacion ASCII es defensa
en profundidad para URLs externas o manipuladas.
=============================================================================
*/
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
MESSAGE_TYPES,
URLS,
makeTraceId,
_safeTrim,
_safeSlugOrId,
_looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

var EXCLUDED_PATHS = new Set([
"servicios",
"service",
"servicio",
"servicio-2",
"service-page"
]);
var MAX_ADDONS_PER_BOOKING = 5;
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 1000;
var RETRYABLE_CODES = new Set([
"TIMEOUT",
"NETWORK_ERROR",
"RATE_LIMITED"
]);

var bridge = null;
var resolvedService = null;

function text(value, fallback) {
return _safeTrim(value) || (fallback != null ? fallback : "");
}

function getReferenceId(value) {
if (typeof value === "string") return text(value);
if (!value || typeof value !== "object") return "";
return text(
value.serviceId ||
value.addonId ||
value.addOnId ||
value.nativeId
);
}

function getMessageType(message) {
if (!message || typeof message !== "object") return "";
return text(message.type).toUpperCase();
}

function getPayload(message) {
var payload = message && message.payload;
if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
return {};
}
return payload;
}

function getServiceId(service) {
return getReferenceId(service && service.serviceId);
}

function getServiceSlug(service) {
return _safeSlugOrId((service && service.slug) || "");
}

function getLinkedPhaseId(value) {
return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function toFiniteNumber(value, fallback) {
if (value === null || value === undefined || value === "") {
return fallback != null ? fallback : 0;
}
var num = Number(value);
return Number.isFinite(num) ? num : (fallback != null ? fallback : 0);
}

function normalizeCurrency(value) {
var currency = text(value, "EUR").toUpperCase();
return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function normalizeService(data) {
if (!data || typeof data !== "object" || Array.isArray(data)) {
throw new Error("El servicio recibido no es valido.");
}
var metadata = (data.metadata && typeof data.metadata === "object")
? data.metadata
: {};
var serviceId = getServiceId(data);
var slug = getServiceSlug(data);
if (!_looksLikeGuid(serviceId)) {
throw new Error("El servicio no tiene un identificador valido.");
}
if (!slug) {
throw new Error("El servicio no tiene un slug valido.");
}
return {
serviceId: serviceId,
slug: slug,
title: text(data.title || metadata.titulo || metadata.tituloServicio, "Servicio"),
description: text(data.description || metadata.descripcionLarga),
tagLine: text(data.tagLine || metadata.resumenCorto),
location: text(data.location || data.localizacion || metadata.localizacion),
totalDuration: Math.max(0, toFiniteNumber(
data.totalDuration != null ? data.totalDuration :
data.duracionTotal != null ? data.duracionTotal :
metadata.duracionTotal
)),
price: Math.max(0, toFiniteNumber(
data.price != null ? data.price : metadata.precio
)),
currency: normalizeCurrency(data.currency || metadata.currency),
mainMedia: data.mainMedia || metadata.mainMedia || "",
addOnOptions: Array.isArray(data.addOnOptions)
? data.addOnOptions
: Array.isArray(metadata.addOnOptions)
? metadata.addOnOptions
: [],
linkedPhases: getLinkedPhaseId(data.linkedPhases),
availableStaff: Array.isArray(data.availableStaff) ? data.availableStaff : [],
clientHidden: data.clientHidden === true,
allowCombine: data.allowCombine === true,
phase1Duration: Math.max(0, toFiniteNumber(
data.phase1Duration != null ? data.phase1Duration : data.tiempoFase1
)),
exposureDuration: Math.max(0, toFiniteNumber(
data.exposureDuration != null ? data.exposureDuration : data.tiempoExposicion
)),
phase2Duration: Math.max(0, toFiniteNumber(
data.phase2Duration != null ? data.phase2Duration : data.tiempoFase2
)),
recommendations: Array.isArray(data.recommendations)
? data.recommendations
: Array.isArray(metadata.recomendaciones)
? metadata.recomendaciones
: []
};
}

function decodeUrlPart(value) {
var raw = text(value);
if (!raw) return "";
try {
return decodeURIComponent(raw);
} catch (ignored) {
return raw;
}
}

function normalizeLookupValue(value) {
var decoded = decodeUrlPart(value)
.replace(/^\/+|\/+$/g, "")
.trim();
if (!decoded) return "";
return _safeSlugOrId(decoded);
}

function resolveServiceLookup() {
var query = wixLocation.query || {};
var candidates = [query.slug, query.serviceId, query.service];
for (var ci = 0; ci < candidates.length; ci++) {
var val = normalizeLookupValue(candidates[ci]);
if (val) return val;
}

var path = Array.isArray(wixLocation.path) ? wixLocation.path : [];

var servicePageIndex = -1;
for (var pi = 0; pi < path.length; pi++) {
if (normalizeLookupValue(path[pi]).toLowerCase() === "service-page") {
servicePageIndex = pi;
break;
}
}
if (servicePageIndex >= 0 && (servicePageIndex + 1) < path.length) {
var slugCandidate = normalizeLookupValue(path[servicePageIndex + 1]);
if (slugCandidate) return slugCandidate;
}

var lastPart = normalizeLookupValue(path[path.length - 1]);
if (!lastPart || EXCLUDED_PATHS.has(lastPart.toLowerCase())) {
return null;
}
return lastPart;
}

function getAllowedAddOnIds(service) {
var options = (service && Array.isArray(service.addOnOptions))
? service.addOnOptions
: [];
var set = new Set();
for (var i = 0; i < options.length; i++) {
var id = getReferenceId(options[i]);
if (id) set.add(id);
}
return set;
}

function getAddOnIds(payload, service) {
if (!Array.isArray(payload && payload.addOnIds)) return [];
var allowedIds = getAllowedAddOnIds(service);
var seen = new Set();
var result = [];
for (var i = 0; i < payload.addOnIds.length; i++) {
var id = getReferenceId(payload.addOnIds[i]);
if (id && allowedIds.has(id) && !seen.has(id)) {
seen.add(id);
result.push(id);
}
}
return result.slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
var base = text(
URLS && URLS.CALENDARIO_2,
"/booking-calendar/calendario-2"
);
var params = new URLSearchParams();
params.set("slug", getServiceSlug(service));
params.set("serviceId", getServiceId(service));
params.set("referral", "servicio-2");
var addOnIds = getAddOnIds(payload, service);
if (addOnIds.length > 0) {
params.set("addOnIds", addOnIds.join(","));
}
return base + "?" + params.toString();
}

function getServicesUrl() {
return text(URLS && URLS.SERVICIOS, "/reserva-online");
}

function showError(message) {
var safeMessage = text(message, "No se pudo cargar el servicio.");
try {
var banner = $w("#errorBanner");
if (!banner) return;
banner.text = "Error: " + safeMessage;
if (typeof banner.show === "function") banner.show();
} catch (ignored) {
/* best-effort banner */
}
}

function isRetryableError(error) {
var code = _safeTrim(
(error && error.code) ||
(error && error.error && error.error.code) ||
""
).toUpperCase();
if (code && RETRYABLE_CODES.has(code)) return true;
var msg = String((error && error.message) || "").toLowerCase();
return (
msg.indexOf("timeout") >= 0 ||
msg.indexOf("network") >= 0 ||
msg.indexOf("fetch failed") >= 0 ||
msg.indexOf("connection") >= 0 ||
msg.indexOf("econnreset") >= 0 ||
msg.indexOf("etimedout") >= 0
);
}

function sleep(ms) {
return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function loadServiceWithRetry(lookupValue, traceId) {
var lastError = null;

for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
try {
var result = await getServiceBySlugOrId(lookupValue);

if (
result &&
result.status === "SUCCESS" &&
result.data &&
typeof result.data === "object"
) {
return normalizeService(result.data);
}

var err = new Error(
(result && result.error && result.error.message) || "Servicio no encontrado."
);
err.code = (result && result.error && result.error.code) || "SERVICE_LOOKUP_FAILED";

if (!isRetryableError(err)) {
throw err;
}
lastError = err;
} catch (caught) {
if (!isRetryableError(caught)) {
throw caught;
}
lastError = caught;
}

if (attempt < MAX_RETRIES) {
await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
}
}

console.error("[servicio-2] Carga de servicio fallida", {
traceId: traceId,
code: lastError && lastError.code,
message: lastError && lastError.message
});

throw lastError || new Error("No se pudo cargar el servicio tras reintentos.");
}

function onBridgeError(error, detail, traceId) {
var cause = (error && error.cause) || (detail && detail.cause) || detail;
console.error("[servicio-2] Error del bridge", {
traceId: traceId,
code: error && error.code,
causeCode: cause && cause.code,
causeMessage: cause && cause.message
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

$w.onReady(function () {
var traceId = makeTraceId("servicio");
var widget;
try {
widget = $w("#htmlWidgetCustomService");
} catch (ignored) {
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

var lookupValue = resolveServiceLookup();
if (!lookupValue) {
showError("No se pudo localizar el servicio en la URL.");
return;
}

try {
bridge = createWidgetBridge(widget, {
slug: lookupValue,
traceId: traceId,
allowOpaqueOrigin: true,
allowedOriginSuffixes: [
".wix.com",
".wixsite.com",
".parastorage.com",
".editorx.com"
],
handshakeTimeoutMs: 60000,
contextTimeoutMs: 180000,
onContextReady: async function () {
resolvedService = await loadServiceWithRetry(lookupValue, traceId);
return resolvedService;
},
onWidgetMessage: async function (message, reply, currentBridge) {
var type = getMessageType(message);
void currentBridge;
if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) {
return;
}
var payload = getPayload(message);
if (!resolvedService) {
if (type === MESSAGE_TYPES.BOOK) {
reply(MESSAGE_TYPES.BOOK, {
status: "ERROR",
data: null,
error: {
code: "SERVICE_NOT_READY",
message: "El servicio aun se esta cargando. Intentalo de nuevo."
}
});
}
return;
}
if (type === MESSAGE_TYPES.BOOK) {
wixLocation.to(buildBookingUrl(resolvedService, payload));
return;
}
if (type === MESSAGE_TYPES.NAV) {
var target = text(payload.target).toUpperCase();
if (!target || target === "SERVICIOS") {
wixLocation.to(getServicesUrl());
return;
}
reply(MESSAGE_TYPES.NAV, {
status: "ERROR",
data: null,
error: {
code: "UNSUPPORTED_NAV_TARGET",
message: "Destino de navegacion no permitido."
}
});
return;
}
},
onError: function (error, detail) {
onBridgeError(error, detail, traceId);
}
});
if (!bridge) {
showError("No se pudo inicializar el widget del servicio.");
}
} catch (error) {
console.error("[servicio-2] Error de inicializacion", {
traceId: traceId,
code: error && error.code,
message: error && error.message
});
showError(
(error && error.message) || "No se pudo cargar el servicio."
);
}
});
