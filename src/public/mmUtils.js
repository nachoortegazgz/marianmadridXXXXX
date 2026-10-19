/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5011-F4-VERIFIED
BASE: v5011-F1-CANONICAL + normalizacion ASCII + verificacion sintactica.
STANDARDS: G10 ASCII estricto. Modulo hoja (leaf): no importa backend.
MMU-F4-01: _normalizeAscii via NFD + eliminacion de diacriticos.
MMU-F4-02: _safeSlugOrId aplica normalizacion antes de validar.
MMU-F4-03: Todos los nombres de constantes verificados contra original.
MMU-F4-04: Comentarios correctamente cerrados. Sin mojibake.
=============================================================================
*/
export {
PROTOCOL_VERSION,
MESSAGE_TYPES,
PROTOCOL_URLS as URLS,
PROTOCOL_UI as UI,
WIDGET_ERROR_CODE
} from "public/widgetBridge";

export const SITE = Object.freeze({
TIMEZONE: "Europe/Madrid",
CURRENCY: "EUR",
DECIMALS: 2,
LOCALE: "es-ES",
COUNTRY: "ES"
});

export const CURRENCY_CONFIG = Object.freeze({
MONEDA_VISUALIZACION: SITE.CURRENCY,
DECIMALES: SITE.DECIMALS
});

export const SLOT_SEARCH = Object.freeze({
DIAS_LIMITE: 14,
MINUTOS_TOLERANCIA: 120,
MINUTOS_MAX_HUECO_DUAL: 120
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
MAX_POR_RESERVA: 5
});

var SLOT_DURATION_TOLERANCE_MINUTES = 1;

var GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var DATE_YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var LOCAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;
var MAX_TEXT_LENGTH = 5000;
var MAX_ID_LENGTH = 200;
var MAX_GUID_LENGTH = 100;
var MAX_SLUG_LENGTH = 200;
var MAX_TRACE_PREFIX_LENGTH = 40;
var MAX_TRACE_ID_LENGTH = 120;
var DEFAULT_TIMEOUT_MS = 15000;
var MS_PER_MINUTE = 60000;

export function _safeTrim(value, maxLength) {
if (value === null || value === undefined) return "";
var limit = Math.max(1, Number(maxLength) || MAX_TEXT_LENGTH);
return String(value).trim().slice(0, limit);
}

export function _cleanText(value, maxLength) {
return _safeTrim(value, maxLength).replace(
/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
""
);
}

export function _normalizeIdPart(value, maxLength) {
return _cleanText(value, maxLength).replace(/[^a-zA-Z0-9._:-]/g, "_");
}

/*
* MMU-F4-01: Normalizacion a ASCII puro via NFD.
* Bajo NFD, la n-tilde se descompone en n + virgulilla combinada,
* que se elimina junto con todos los demas diacriticos.
*/
export function _normalizeAscii(value) {
return String(value != null ? value : "")
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "");
}

/*
* MMU-F4-02: Identidad publica (slug) o identidad tecnica (serviceId).
* Aplica normalizacion ASCII antes de validar. Fail-closed preservado.
*/
export function _safeSlugOrId(value) {
var raw = _safeTrim(value, MAX_SLUG_LENGTH);
if (!raw) return "";
if (_looksLikeGuid(raw)) return raw.toLowerCase();
var normalized = _normalizeAscii(raw);
if (normalized.indexOf("/") >= 0 || normalized.indexOf("\\") >= 0) return "";
var slug = normalized.replace(/\s+/g, "-").toLowerCase();
return /^[a-z0-9]+(?:[._:-]?[a-z0-9]+)*$/.test(slug) ? slug : "";
}

export function _looksLikeGuid(value) {
return GUID_PATTERN.test(_safeTrim(value, MAX_GUID_LENGTH));
}

export function getReferenceId(value) {
if (!value) return "";
if (typeof value === "string") return _safeTrim(value, MAX_ID_LENGTH);
if (Array.isArray(value)) {
return value.length > 0 ? getReferenceId(value[0]) : "";
}
if (typeof value === "object") {
return _safeTrim(
value._id || value.id || value.referenceId || value.value,
MAX_ID_LENGTH
);
}
return "";
}

export function getReferenceIds(value) {
if (!value) return [];
var source = Array.isArray(value) ? value : [value];
var ids = [];
for (var i = 0; i < source.length; i++) {
var id = getReferenceId(source[i]);
if (id) ids.push(id);
}
var unique = [];
var seen = {};
for (var j = 0; j < ids.length; j++) {
if (!seen[ids[j]]) {
seen[ids[j]] = true;
unique.push(ids[j]);
}
}
return unique;
}

export function cleanGuidList(value) {
var source;
if (Array.isArray(value)) {
source = value;
} else if (typeof value === "string") {
source = value.split(",");
} else {
source = [];
}
var guids = [];
var seen = {};
for (var i = 0; i < source.length; i++) {
var g = _safeTrim(getReferenceId(source[i]), MAX_GUID_LENGTH);
if (_looksLikeGuid(g) && !seen[g]) {
seen[g] = true;
guids.push(g);
}
}
return guids;
}

export function cleanGuidListByKey(value, key) {
var cleanKey = _safeTrim(key, MAX_ID_LENGTH);
if (!cleanKey) return [];
var source;
if (Array.isArray(value)) {
source = value;
} else if (typeof value === "string") {
source = value.split(",");
} else {
source = [];
}
var guids = [];
var seen = {};
for (var i = 0; i < source.length; i++) {
var entry = source[i];
var raw;
if (typeof entry === "string") {
raw = _safeTrim(entry, MAX_GUID_LENGTH);
} else if (entry && typeof entry === "object") {
raw = _safeTrim(entry[cleanKey], MAX_GUID_LENGTH);
} else {
raw = "";
}
if (_looksLikeGuid(raw) && !seen[raw]) {
seen[raw] = true;
guids.push(raw);
}
}
return guids;
}

export function cleanGuid(value, errorCode) {
var clean = _safeTrim(value, MAX_GUID_LENGTH);
if (!_looksLikeGuid(clean)) {
var error = new Error((errorCode || "INVALID_GUID") + ": Invalid or missing GUID");
error.code = errorCode || "INVALID_GUID";
throw error;
}
return clean;
}

export function isDateYmd(value) {
var clean = _safeTrim(value, 10);
if (!DATE_YMD_PATTERN.test(clean)) return false;
var parts = clean.split("-").map(Number);
var year = parts[0];
var month = parts[1];
var day = parts[2];
var date = new Date(Date.UTC(year, month - 1, day));
return date.getUTCFullYear() === year &&
date.getUTCMonth() === month - 1 &&
date.getUTCDate() === day;
}

export function toFiniteNumber(value, fallback) {
var parsed = Number(value);
return Number.isFinite(parsed) ? parsed : (fallback != null ? fallback : 0);
}

export function numberOrZero(value, minimum) {
var parsed = Number(value);
var floor = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
return (Number.isFinite(parsed) && parsed >= floor) ? parsed : 0;
}

export function _roundMoney(value, decimals) {
var parsed = Number(value);
if (!Number.isFinite(parsed)) return 0;
var dec = decimals != null ? decimals : CURRENCY_CONFIG.DECIMALES;
var factor = Math.pow(10, Math.max(0, toFiniteNumber(dec, CURRENCY_CONFIG.DECIMALES)));
return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

export function _readPositiveAmount(value) {
var parsed = Number(value);
return (Number.isFinite(parsed) && parsed > 0) ? parsed : 0;
}

export function booleanValue() {
for (var i = 0; i < arguments.length; i++) {
if (arguments[i] === true) return true;
}
return false;
}

export function toBoolean(value, fallback) {
if (typeof value === "boolean") return value;
if (typeof value === "string") {
var clean = value.trim().toLowerCase();
if (clean === "true") return true;
if (clean === "false") return false;
}
return fallback != null ? fallback : false;
}

function formatMadridParts(date, options) {
var dt = (date instanceof Date) ? date : new Date(date);
if (Number.isNaN(dt.getTime())) return null;
var formatter = new Intl.DateTimeFormat("sv-SE", Object.assign({
timeZone: SITE.TIMEZONE,
hourCycle: "h23"
}, options));
var parts = formatter.formatToParts(dt);
var result = {};
for (var i = 0; i < parts.length; i++) {
result[parts[i].type] = parts[i].value;
}
return result;
}

export function _normalizeLocalIsoStr(value) {
var raw = _safeTrim(value, 80);
if (!raw) return "";
var normalized = raw.replace(/\s+/, "T");
if (!LOCAL_ISO_PATTERN.test(normalized)) return "";
var date = new Date(normalized);
if (Number.isNaN(date.getTime())) return "";
return normalized;
}

function hasExplicitOffset(value) {
var raw = _safeTrim(value, 80);
return /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
}

export function getUtcDateFromMadridLocal(value) {
if (value instanceof Date) {
return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
}
var raw = _normalizeLocalIsoStr(value);
if (!raw) return null;
if (hasExplicitOffset(raw)) {
var explicit = new Date(raw);
return Number.isNaN(explicit.getTime()) ? null : explicit;
}
var naiveStr = (raw.length === 16) ? raw + ":00Z" : raw + "Z";
var naive = new Date(naiveStr);
if (Number.isNaN(naive.getTime())) return null;
var offsetMinutes = madridOffsetMinutes(naive);
return new Date(naive.getTime() - offsetMinutes * MS_PER_MINUTE);
}

function parseDate(value) {
if (value instanceof Date) {
return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
}
var raw = _normalizeLocalIsoStr(value);
if (!raw) return null;
return getUtcDateFromMadridLocal(raw);
}

export function _toDateSafe(value) {
if (!value) return null;
if (value instanceof Date) {
return Number.isNaN(value.getTime()) ? null : value;
}
return parseDate(value);
}

export function _readDate(value) {
var clean = _safeTrim(value, 40);
if (DATE_YMD_PATTERN.test(clean)) return clean;
var date = _toDateSafe(value);
if (!date) return null;
return getMadridDateYmd(date);
}

export function getMadridLocalStringNoZ(value) {
var parts = formatMadridParts(value, {
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit"
});
if (!parts) return "";
return parts.year + "-" + parts.month + "-" + parts.day +
"T" + parts.hour + ":" + parts.minute + ":" + parts.second;
}

export function getMadridDateYmd(date) {
var d = (date instanceof Date) ? date : new Date();
var parts = formatMadridParts(d, {
year: "numeric",
month: "2-digit",
day: "2-digit"
});
if (!parts) return "";
return parts.year + "-" + parts.month + "-" + parts.day;
}

export function getMadridTime(date) {
var d = (date instanceof Date) ? date : new Date();
var parts = formatMadridParts(d, {
hour: "2-digit",
minute: "2-digit",
second: "2-digit"
});
if (!parts) return "";
return parts.hour + ":" + parts.minute + ":" + parts.second;
}

export function getMadridMonthKey(date) {
var d = (date instanceof Date) ? date : new Date();
var parts = formatMadridParts(d, {
year: "numeric",
month: "2-digit"
});
if (!parts) return "";
return parts.year + "-" + parts.month;
}

export function toMadridIsoLocal(date) {
var d = (date instanceof Date) ? date : new Date();
return getMadridLocalStringNoZ(d);
}

export function toUtcIsoZ(value) {
var date = (value instanceof Date) ? value : _toDateSafe(value);
if (!date) return "";
return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function madridOffsetMinutes(date) {
var source = (date instanceof Date) ? date : new Date(date);
if (Number.isNaN(source.getTime())) return 0;
var madridDate = new Date(
source.toLocaleString("en-US", { timeZone: SITE.TIMEZONE })
);
var utcDate = new Date(
source.toLocaleString("en-US", { timeZone: "UTC" })
);
return Math.round((madridDate.getTime() - utcDate.getTime()) / MS_PER_MINUTE);
}

export function formatUtcOffset(offsetMinutes) {
var offset = toFiniteNumber(offsetMinutes, 0);
var sign = offset >= 0 ? "+" : "-";
var absolute = Math.abs(offset);
var hours = String(Math.floor(absolute / 60)).padStart(2, "0");
var minutes = String(absolute % 60).padStart(2, "0");
return sign + hours + ":" + minutes;
}

export function buildLocalDateRange(dateYmd) {
var clean = _safeTrim(dateYmd, 10);
if (!DATE_YMD_PATTERN.test(clean)) return null;
return Object.freeze({
dateYmd: clean,
fromLocalDate: clean + "T00:00:00",
toLocalDate: clean + "T23:59:59",
timeZone: SITE.TIMEZONE
});
}

export function toUtcRange(startLocal, endLocal) {
var startUtc = getUtcDateFromMadridLocal(startLocal);
var endUtc = getUtcDateFromMadridLocal(endLocal);
if (!startUtc || !endUtc || endUtc <= startUtc) return null;
return Object.freeze({ startUtc: startUtc, endUtc: endUtc });
}

export function computeGapMinutes(firstEndUtc, secondStartUtc) {
if (!(firstEndUtc instanceof Date) || !(secondStartUtc instanceof Date)) return null;
if (Number.isNaN(firstEndUtc.getTime()) || Number.isNaN(secondStartUtc.getTime())) return null;
var gap = Math.round(
(secondStartUtc.getTime() - firstEndUtc.getTime()) / MS_PER_MINUTE
);
return Number.isFinite(gap) ? gap : null;
}

export function isDualGapWithinLimit(gapMinutes) {
if (!Number.isFinite(Number(gapMinutes))) return false;
var gap = Number(gapMinutes);
return gap >= 0 && gap <= SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL;
}

export function readDurationRange(item) {
var obj = item || {};
var constraints = obj.availabilityConstraints ||
(obj.data && obj.data.availabilityConstraints) ||
(obj.fields && obj.fields.availabilityConstraints);
var range = (constraints && constraints.durationRange) ||
obj.durationRange ||
(obj.data && obj.data.durationRange) ||
(obj.fields && obj.fields.durationRange);
if (!range || typeof range !== "object") return null;
var min = numberOrZero(range.minDuration != null ? range.minDuration : range.min);
var rawMax = numberOrZero(range.maxDuration != null ? range.maxDuration : range.max);
var max = rawMax > 0 ? rawMax : Infinity;
if (min <= 0 && max === Infinity) return null;
if (max !== Infinity && max <= min) return null;
return Object.freeze({ min: min, max: max });
}

export function resolveExpectedSlotMinutes(serviceConfig) {
var cfg = serviceConfig || {};
if (cfg.allowCombine === true) {
return numberOrZero(cfg.phase1Duration);
}
return numberOrZero(
cfg.phase1Duration ||
cfg.totalDuration ||
(cfg.metadata && cfg.metadata.timing && cfg.metadata.timing.estimatedTotal)
);
}

export function computeTotalDuration(serviceConfig) {
var cfg = serviceConfig || {};
var phase1 = numberOrZero(cfg.phase1Duration);
var exposure = numberOrZero(cfg.exposureDuration);
var phase2 = numberOrZero(cfg.phase2Duration);
var sum = phase1 + exposure + phase2;
return sum > 0 ? sum : null;
}

export function validateSlotDuration(params) {
var p = params || {};
var serviceConfig = p.serviceConfig || {};
var startLocal = p.startLocal;
var endLocal = p.endLocal;
var base = {
ok: true,
code: null,
actualMinutes: 0,
expectedMinutes: null,
min: null,
max: null
};
var range = toUtcRange(startLocal, endLocal);
if (!range) {
base.ok = false;
base.code = "INVALID_SLOT_RANGE";
return base;
}
var actualMinutes = Math.round(
(range.endUtc.getTime() - range.startUtc.getTime()) / MS_PER_MINUTE
);
base.actualMinutes = actualMinutes;
var limits = readDurationRange(serviceConfig);
if (limits) {
base.min = limits.min;
base.max = (limits.max === Infinity) ? null : limits.max;
var belowMin = actualMinutes < limits.min;
var aboveMax = limits.max !== Infinity && actualMinutes > limits.max;
if (belowMin || aboveMax) {
base.ok = false;
base.code = "SLOT_DURATION_OUT_OF_RANGE";
return base;
}
return base;
}
var expected = resolveExpectedSlotMinutes(serviceConfig);
if (expected > 0) {
base.expectedMinutes = expected;
if (Math.abs(actualMinutes - expected) > SLOT_DURATION_TOLERANCE_MINUTES) {
base.ok = false;
base.code = "SLOT_DURATION_MISMATCH";
return base;
}
}
return base;
}

export function isPlainObject(value) {
return Boolean(
value &&
typeof value === "object" &&
!Array.isArray(value) &&
!(value instanceof Date)
);
}

export function _cloneDeep(value) {
if (value === null || typeof value !== "object") return value;
if (value instanceof Date) return new Date(value.getTime());
if (Array.isArray(value)) return value.map(_cloneDeep);
var keys = Object.keys(value);
var result = {};
for (var i = 0; i < keys.length; i++) {
result[keys[i]] = _cloneDeep(value[keys[i]]);
}
return result;
}

export function _stableSerialize(value) {
if (value === null || value === undefined) return String(value);
if (Array.isArray(value)) {
var arrParts = [];
for (var ai = 0; ai < value.length; ai++) {
arrParts.push(_stableSerialize(value[ai]));
}
return "[" + arrParts.join(",") + "]";
}
if (value instanceof Date) return '"' + value.toISOString() + '"';
if (typeof value === "object") {
var objKeys = Object.keys(value).sort();
var objParts = [];
for (var oi = 0; oi < objKeys.length; oi++) {
objParts.push(JSON.stringify(objKeys[oi]) + ":" + _stableSerialize(value[objKeys[oi]]));
}
return "{" + objParts.join(",") + "}";
}
return JSON.stringify(value);
}

export function _generateUUID() {
var globalCrypto = (typeof crypto !== "undefined") ? crypto : undefined;
if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
try {
return globalCrypto.randomUUID();
} catch (ignored) {
/* degrade to manual generator */
}
}
return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
var r = (Math.random() * 16) | 0;
var v = (c === "x") ? r : (r & 0x3) | 0x8;
return v.toString(16);
});
}

export function makeTraceId(prefix) {
var safePrefix = _normalizeIdPart(prefix || "trace", MAX_TRACE_PREFIX_LENGTH) || "trace";
var traceId = safePrefix + "-" + Date.now().toString(36) + "-" + _generateUUID();
return traceId.slice(0, MAX_TRACE_ID_LENGTH);
}

export function _hashKey(value) {
var stringValue = String(value != null ? value : "");
var hash1 = 0xdeadbeef ^ stringValue.length;
var hash2 = 0x41c6ce57 ^ stringValue.length;
for (var index = 0; index < stringValue.length; index += 1) {
var character = stringValue.charCodeAt(index);
hash1 = Math.imul(hash1 ^ character, 2654435761);
hash2 = Math.imul(hash2 ^ character, 1597334677);
}
hash1 = Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^
Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
hash2 = Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^
Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);
return (hash2 >>> 0).toString(16).padStart(8, "0") +
(hash1 >>> 0).toString(16).padStart(8, "0");
}

export function _maskEmail(value) {
var email = _safeTrim(value, 254);
var at = email.indexOf("@");
if (at <= 1) return "[REDACTED_EMAIL]";
return email[0] + "***" + email.slice(at - 1);
}

export function _maskPhone(value) {
var phone = _safeTrim(value, 40);
return phone.length > 4 ? "***" + phone.slice(-4) : "[REDACTED_PHONE]";
}

export function _maskName(value) {
var name = _safeTrim(value, 120);
return name ? name[0] + "***" : "[REDACTED_NAME]";
}

export function _maskTaxId(value) {
var taxId = _safeTrim(value, 20);
return taxId.length > 2 ? "***" + taxId.slice(-2) : "[REDACTED_TAX_ID]";
}

export function withTimeout(promiseOrFactory, timeoutMs, label) {
var factory = (typeof promiseOrFactory === "function")
? promiseOrFactory
: function () { return promiseOrFactory; };
var timeout = Math.max(1, toFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS));
var tag = label || "OPERATION_TIMEOUT";
return new Promise(function (resolve, reject) {
var settled = false;
var timer = setTimeout(function () {
if (settled) return;
settled = true;
var error = new Error(tag);
error.code = "TIMEOUT";
reject(error);
}, timeout);
Promise.resolve()
.then(factory)
.then(function (val) {
if (settled) return;
settled = true;
clearTimeout(timer);
resolve(val);
})
.catch(function (err) {
if (settled) return;
settled = true;
clearTimeout(timer);
reject(err);
});
});
}

export async function _executeWithRetry(fn, maxRetries, delayMs, isRetryable) {
var retries = Math.max(0, toFiniteNumber(maxRetries, 0));
var baseDelay = Math.max(0, toFiniteNumber(delayMs, 0));
var lastError;
for (var attempt = 0; attempt <= retries; attempt += 1) {
try {
return await fn();
} catch (error) {
lastError = error;
var retryable = (typeof isRetryable === "function") ? isRetryable(error) : true;
if (!retryable || attempt >= retries) break;
var wait = baseDelay * Math.pow(2, attempt);
await new Promise(function (resolve) {
setTimeout(resolve, wait);
});
}
}
throw lastError;
}
