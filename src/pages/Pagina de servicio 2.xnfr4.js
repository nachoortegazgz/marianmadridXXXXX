/*
=============================================================================
FILE: pages/servicio-2.js
VERSION: v5013.5-BRIDGE-FIX
BASE: v5013.4-LOOKUP-FIX + correccion de comunicacion HTML Component -> Velo.
PURPOSE: Load the selected CMS service and provide the widget context.
ASCII: Strict ASCII in comments and identifiers.
CHANGELOG v5013.5:
- allowOpaqueOrigin: true. En Wix HTML Components event.origin llega
vacio/opaco. Con false el bridge rechaza MM_READY y nunca se alcanza
MM_CONTEXT. Se mantiene validacion estricta para origenes no opacos
mediante allowedOriginSuffixes.
- handshakeTimeoutMs: 60000 (60s). Margen suficiente para cold start.
- contextTimeoutMs: 180000 (180s). Alineado con ventana de reintentos
exponenciales de loadServiceWithRetry (3 intentos, ~7s + latencia).
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

const EXCLUDED_PATHS = new Set([
"servicios",
"service",
"servicio",
"servicio-2",
"service-page"
]);
const MAX_ADDONS_PER_BOOKING = 5;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_CODES = new Set([
"TIMEOUT",
"NETWORK_ERROR",
"DATABASE_ERROR",
"RATE_LIMITED",
"UNKNOWN_ERROR"
]);

let bridge = null;
let resolvedService = null;

function text(value, fallback = "") {
return _safeTrim(value) || fallback;
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
const payload = message && message.payload;
if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
return {};
}
return payload;
}

function getServiceId(service) {
return getReferenceId(service && service.serviceId);
}

function getServiceSlug(service) {
return _safeSlugOrId(service && service.slug || "");
}

function getLinkedPhaseId(value) {
return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function toFiniteNumber(value, fallback = 0) {
if (value === null || value === undefined || value === "") {
return fallback;
}
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}

function normalizeCurrency(value) {
const currency = text(value, "EUR").toUpperCase();
return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function normalizeService(data) {
if (!data || typeof data !== "object" || Array.isArray(data)) {
throw new Error("El servicio recibido no es valido.");
}
const metadata = data.metadata && typeof data.metadata === "object"
? data.metadata
: {};
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
title: text(
data.title || metadata.titulo || metadata.tituloServicio,
"Servicio"
),
description: text(
data.description || metadata.descripcionLarga
),
tagLine: text(
data.tagLine || metadata.resumenCorto
),
location: text(
data.location || data.localizacion || metadata.localizacion
),
totalDuration: Math.max(0, toFiniteNumber(
data.totalDuration ??
data.duracionTotal ??
metadata.duracionTotal
)),
price: Math.max(0, toFiniteNumber(
data.price ?? metadata.precio
)),
currency: normalizeCurrency(
data.currency || metadata.currency
),
mainMedia: data.mainMedia || metadata.mainMedia || "",
addOnOptions: Array.isArray(data.addOnOptions)
? data.addOnOptions
: Array.isArray(metadata.addOnOptions)
? metadata.addOnOptions
: [],
linkedPhases: getLinkedPhaseId(data.linkedPhases),
availableStaff: Array.isArray(data.availableStaff)
? data.availableStaff
: [],
clientHidden: data.clientHidden === true,
allowCombine: data.allowCombine === true,
phase1Duration: Math.max(0, toFiniteNumber(
data.phase1Duration ?? data.tiempoFase1
)),
exposureDuration: Math.max(0, toFiniteNumber(
data.exposureDuration ?? data.tiempoExposicion
)),
phase2Duration: Math.max(0, toFiniteNumber(
data.phase2Duration ?? data.tiempoFase2
)),
recommendations: Array.isArray(data.recommendations)
? data.recommendations
: Array.isArray(metadata.recomendaciones)
? metadata.recomendaciones
: []
};
}

function decodeUrlPart(value) {
const raw = text(value);
if (!raw) return "";
try {
return decodeURIComponent(raw);
} catch (_) {
return raw;
}
}

function normalizeLookupValue(value) {
const decoded = decodeUrlPart(value)
.replace(/^\/+|\/+$/g, "")
.trim();
if (!decoded) return "";
return _safeSlugOrId(decoded) || decoded;
}

function resolveServiceLookup() {
const query = wixLocation.query || {};
for (const candidate of [
query.slug,
query.serviceId,
query.service
]) {
const value = normalizeLookupValue(candidate);
if (value) return value;
}

const path = Array.isArray(wixLocation.path)
? wixLocation.path
: [];

const servicePageIndex = path.findIndex(
(part) => normalizeLookupValue(part).toLowerCase() === "service-page"
);
if (servicePageIndex >= 0) {
const slug = normalizeLookupValue(path[servicePageIndex + 1]);
if (slug) return slug;
}

const lastPart = normalizeLookupValue(path[path.length - 1]);
if (!lastPart || EXCLUDED_PATHS.has(lastPart.toLowerCase())) {
return null;
}
return lastPart;
}

function getAllowedAddOnIds(service) {
const options = service && Array.isArray(service.addOnOptions)
? service.addOnOptions
: [];
return new Set(
options
.map(getReferenceId)
.filter(Boolean)
);
}

function getAddOnIds(payload, service) {
if (!Array.isArray(payload && payload.addOnIds)) return [];
const allowedIds = getAllowedAddOnIds(service);
return Array.from(
new Set(
payload.addOnIds
.map(getReferenceId)
.filter(Boolean)
)
)
.filter((id) => allowedIds.has(id))
.slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
const base = text(
URLS && URLS.CALENDARIO_2,
"/booking-calendar/calendario-2"
);
const query = new URLSearchParams({
slug: getServiceSlug(service),
serviceId: getServiceId(service),
referral: "servicio-2"
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
console.warn(
"[servicio-2] No se pudo mostrar el error:",
error && error.message
);
}
}

function isRetryableError(error) {
const code = _safeTrim(
error?.code || error?.error?.code || ""
).toUpperCase();
if (code && RETRYABLE_CODES.has(code)) return true;
const msg = String(error?.message || "").toLowerCase();
return (
msg.includes("timeout") ||
msg.includes("network") ||
msg.includes("fetch failed") ||
msg.includes("connection") ||
msg.includes("econnreset") ||
msg.includes("etimedout")
);
}

function sleep(ms) {
return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadServiceWithRetry(lookupValue, traceId) {
let lastError = null;

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
try {
const result = await getServiceBySlugOrId(lookupValue);

if (
result &&
result.status === "SUCCESS" &&
result.data &&
typeof result.data === "object"
) {
const service = normalizeService(result.data);

console.info(
attempt > 0
? "[servicio-2] Servicio cargado tras reintento"
: "[servicio-2] Servicio cargado",
{
traceId,
slug: service.slug,
attempt,
}
);

return service;
}

const error = new Error(
result?.error?.message || "Servicio no encontrado."
);
error.code = result?.error?.code || "SERVICE_LOOKUP_FAILED";

if (!isRetryableError(error)) {
console.error("[servicio-2] Error deterministico", {
traceId,
code: error.code,
attempt,
});
throw error;
}

lastError = error;
} catch (error) {
if (!isRetryableError(error)) {
console.error(
"[servicio-2] Error deterministico en intento",
{
traceId,
code: error?.code,
message: error?.message,
attempt,
}
);
throw error;
}
lastError = error;
}

if (attempt < MAX_RETRIES) {
const delay = BASE_DELAY_MS * Math.pow(2, attempt);

console.warn("[servicio-2] Reintento programado", {
traceId,
attempt: attempt + 1,
delayMs: delay,
code: lastError?.code,
message: lastError?.message,
});

await sleep(delay);
}
}

console.error("[servicio-2] Todos los reintentos fallaron", {
traceId,
attempts: MAX_RETRIES + 1,
code: lastError?.code,
message: lastError?.message,
});

throw lastError || new Error(
"No se pudo cargar el servicio tras reintentos."
);
}

function onBridgeError(error, detail, traceId) {
const cause = error && error.cause ||
detail && detail.cause ||
detail;
console.error("[servicio-2] Error del bridge", {
traceId,
code: error && error.code,
message: error && error.message,
causeCode: cause && cause.code,
causeMessage: cause && cause.message,
detail: error && error.detail
});
if (
error &&
(error.code === "WIDGET_ORIGIN_OPAQUE_REJECTED" ||
error.code === "WIDGET_ORIGIN_REJECTED")
) {
showError(
"No se pudo conectar el componente de reserva. Recarga la pagina."
);
return;
}
showError(
cause && cause.message ||
error && error.message ||
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

console.info("[servicio-2] lookupValue resuelto", {
traceId,
lookupValue,
});

try {
bridge = createWidgetBridge(widget, {
slug: lookupValue,
traceId,
// v5013.5: allowOpaqueOrigin true. Wix HTML Components envian
// event.origin vacio/opaco. Con false el bridge rechaza MM_READY
// y nunca se alcanza MM_CONTEXT. La seguridad se mantiene via
// allowedOriginSuffixes para origenes no opacos.
allowOpaqueOrigin: true,
allowedOriginSuffixes: [
".wix.com",
".wixsite.com",
".parastorage.com",
".editorx.com"
],
handshakeTimeoutMs: 60000,
contextTimeoutMs: 180000,
onContextReady: async () => {
resolvedService = await loadServiceWithRetry(lookupValue, traceId);
return resolvedService;
},
onWidgetMessage: async (message, reply, currentBridge) => {
const type = getMessageType(message);
void currentBridge;
if (
type === MESSAGE_TYPES.READY ||
type === MESSAGE_TYPES.CONTEXT
) {
return;
}
const payload = getPayload(message);
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
message: "El servicio aun se esta cargando. Intentalo de nuevo."
}
});
}
return;
}
if (type === MESSAGE_TYPES.BOOK) {
wixLocation.to(
buildBookingUrl(resolvedService, payload)
);
return;
}
if (type === MESSAGE_TYPES.NAV) {
const target = text(payload.target).toUpperCase();
if (!target || target === "SERVICIOS") {
wixLocation.to(getServicesUrl());
}
return;
}
console.warn(
"[servicio-2] Mensaje no soportado",
{ traceId, type }
);
},
onError: (error, detail) =>
onBridgeError(error, detail, traceId)
});
if (!bridge) {
showError("No se pudo inicializar el widget del servicio.");
}
} catch (error) {
console.error("[servicio-2] Error de inicializacion", {
traceId,
code: error && error.code,
message: error && error.message
});
showError(
error && error.message ||
"No se pudo cargar el servicio."
);
}
});
