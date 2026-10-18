/**
* MODULE: pages/calendario-2.js
* VERSION: v5007-CMS-FINAL
* BASE: v5006-CMS-FINAL + eliminacion de residuos legacy y endurecimiento
*       contractual (CAL-07..CAL-11).
* STANDARDS: G10 ASCII Strict, Velo Native Optimized.
*
* ALINEACION:
*   - widget HTML protocolo v1 (messageId unico, addOnIds, slotF1/slotF2)
*   - backend/reservas.web.js v10 (getServiceBySlugOrId, getAvailableDays,
*     getAvailableSlots, getCertifiedDualSlots)
*   - backend/citasManager.web.js v10.4 (processDualBooking: channelType
*     canonico, paymentMethod solo enum real PAYMENT_METHOD)
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
*   - pairToken NO se envia. Saga v5013 lo recalcula (SAGA-30).
*   - channelType es el discriminador de flujo. paymentMethod es opcional
*     y solo se incluye si pertenece al enum PAYMENT_METHOD real.
*   - resourceId se normaliza en frontend antes de enviar al backend.
*     String vacio o no-GUID se convierte a null (consulta sin filtro).
*
* FIXES v5007-CMS-FINAL:
*   CAL-07 (P1): normalizeAddOnIds elimina fallbacks legacy item.id/item.value.
*     Solo acepta addonId (CMS real) y addOnId (contrato bookingUtils).
*   CAL-08 (P1): buildBookingRequestPayload omite paymentMethod del payload
*     cuando no es miembro valido del enum PAYMENT_METHOD. Evita rechazo
*     en citasManager v10.4 por string vacio o valor desconocido.
*   CAL-09 (P1): handleAvailability normaliza resourceId antes de enviar.
*     String vacio o no-GUID -> null. Evita consulta global inadvertida.
*   CAL-10 (P2): loadServiceContext preserva serviceId/slug originales del
*     URL como fallback si la respuesta del backend trae null.
*   CAL-11 (P2): String "recibio" corregido a "recibio" (G10 ASCII).
*
* FIXES HEREDADOS v5006: CAL-01..CAL-06.
* FIXES HEREDADOS v5005: normalizeSlot, isValidBookingSlot, guardas
*   anti-duplicado, validacion year/month/dateYMD, normalizeAvailabilityResult.
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
Number(BOOKINGS_ADDON_CONFIG?.MAX_POR_RESERVA) || 5;
/* CAL-08: miembros validos del enum PAYMENT_METHOD (Biblia 6.3).
* Solo estos valores se reenvian al backend como paymentMethod.
* ONLINE/PRESENCIAL son canales, no metodos de pago. */
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
/**
* CAL-10: preserva serviceId/slug originales del URL como fallback.
* Si el backend devuelve null (servicio despublicado, slug cambiado),
* las variables mantienen el valor del URL para errores claros.
*/
async function loadServiceContext(params) {
const lookup = currentServiceId || currentSlug;
const result = await getServiceBySlugOrId(lookup);
if (!result || result.status !== "SUCCESS" || !result.data) {
throw new Error(
result?.error?.message || "No se pudo cargar el servicio."
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
return { status: "ERROR", data: null, error: { code, message } };
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
function isValidDateYmd(value) {
if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
const [year, month, day] = value.split("-").map(Number);
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
// ADD-ONS NORMALIZATION (CAL-02 + CAL-03 + CAL-07)
// =============================================================================
/**
* CAL-02: acepta addonId (CMS KEY FIELDS real) y addOnId (contrato bookingUtils).
* CAL-07: ELIMINA fallbacks legacy item.id / item.value. El DTO canonico de
*   reservas.web v10 expone {addonId, name, price}. Los campos id/value
*   pertenecen al contrato v5 obsoleto y crean camino silencioso de datos
*   corruptos. Si el widget envia objetos con id/value, se descartan.
* CAL-03: tope MAX_ADDONS_PER_BOOKING (5), identico al limite del saga.
*/
function normalizeAddOnIds(value) {
if (!Array.isArray(value)) return [];
const normalized = Array.from(
new Set(
value
.map((item) => {
if (typeof item === "string") return _safeTrim(item);
if (item && typeof item === "object") {
/* CAL-07: solo addonId y addOnId. Sin id/value legacy. */
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
/**
* CAL-09: normaliza resourceId en frontend antes de enviar al backend.
* String vacio, whitespace-only o no-GUID -> null.
* Evita que un resourceId="" del widget produzca consulta global inadvertida
* en el backend (_normalizeResourceIdsStrict trata "" como "any").
*/
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
/**
* CAL-01: deriva el canal canonico desde el payload del widget.
* El widget actual envia paymentMethod = "ONLINE" | "PRESENCIAL".
* Protocolo futuro: channelType explicito (prioritario).
* Valores desconocidos -> null (rechazo, no default silencioso).
*/
function resolveChannelType(bookingData) {
const raw = _safeTrim(
bookingData?.channelType || bookingData?.paymentMethod || ""
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
// BOOKING REQUEST PAYLOAD (CAL-01 + CAL-04 + CAL-05 + CAL-08)
// =============================================================================
/**
* CAL-01: channelType explicito (canonico).
* CAL-04: sin bookedAddOns (SAGA-18).
* CAL-05: sin pairToken (SAGA-30: saga lo recalcula).
* CAL-08: paymentMethod SOLO si es miembro valido de PAYMENT_METHOD enum.
*   Si el widget envia "ONLINE"/"PRESENCIAL" como paymentMethod, se usa
*   como channelType pero NO se reenvia como paymentMethod (son canales,
*   no metodos de pago). Si envia "TARJETA"/"BIZUM"/etc., se reenvia.
*   Si envia "" o valor desconocido, se OMITE del payload.
*/
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
/* CAL-08: solo incluir paymentMethod si es miembro valido del enum.
* Valores de canal (ONLINE/PRESENCIAL) NO son paymentMethod. */
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
/* CAL-08: paymentMethod solo si es valido. Omision = backend usa
* channelType como discriminador (citasManager CM4-01). */
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
/* CAL-04 heredado: solo addOnIds. bookedAddOns prohibido (SAGA-18). */
const addOnIds = normalizeAddOnIds(payload.addOnIds);
/* CAL-09: normalizar resourceId en frontend. */
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
UI?.FRONTEND_API_TIMEOUT_MS || 60000,
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
currentService?.allowCombine
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
"El horario seleccionado no es valido."
)
);
return;
}
if (
requestPayload.slotF2 &&
!isValidBookingSlot(requestPayload.slotF2)
) {
bookingInFlight = false;
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
activeBookingMessageId = messageId;
bookingInFlight = true;
try {
const result = await withTimeout(
processDualBooking(requestPayload),
UI?.FRONTEND_API_TIMEOUT_MS || 60000,
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
{ traceId, message: lightboxError?.message }
);
}
}
} catch (error) {
bookingInFlight = false;
const timeout =
error?.code === "TIMEOUT" ||
String(error?.message || "")
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
message: error?.message,
});
},
});
if (!bridge) {
throw new Error("No se pudo inicializar el bridge.");
}
} catch (error) {
console.error("[calendario-2] Error de inicializacion", {
traceId,
message: error?.message,
});
}
});
