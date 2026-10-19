/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5012.1
BASE: v5012-CLEAN + correccion de error de despliegue (numberOrZero)
STANDARDS: G10 ASCII estricto. Modulo hoja (leaf): no importa backend.
REGLAS DE MODULO
1. SSOT de constantes de negocio = backend/internalConfig.js. Este fichero
   solo alberga un ESPEJO de lectura para el frontend (SITE, CURRENCY_CONFIG,
   SLOT_SEARCH, BOOKINGS_ADDON_CONFIG, CHANNEL_TYPE, PAYMENT_METHOD).
   Cualquier divergencia se resuelve a favor de internalConfig y se corrige aqui.
2. SSOT del protocolo de widget = public/widgetBridge.js. Este modulo solo
   reexporta (facade), nunca redefine.
RESTRICCION ACICLICA: widgetBridge.js NO debe importar public/mmUtils.js.

CONTRATO VIGENTE:
  - Espejos autorizados (D-1): SITE, CURRENCY_CONFIG, SLOT_SEARCH,
    BOOKINGS_ADDON_CONFIG, CHANNEL_TYPE, PAYMENT_METHOD. Cada clave es
    replica literal del SSOT backend/internalConfig.js; cualquier cambio
    debe replicarse en la misma iteracion (test de paridad obligatorio).
  - Facade de protocolo: reexporta widgetBridge (PROTOCOL_VERSION,
    MESSAGE_TYPES, URLS, UI, WIDGET_ERROR_CODE); nunca redefine.
  - Helpers de dominio con consumidor verificado en el grafo
    (src/backend, src/pages, src/public, tests) O uso interno justificado.

CORRECCION v5012.1:
  MMU-12-08 (P0): restaurado numberOrZero como helper INTERNO no exportado.
    ZC-04 (v5012-CLEAN) lo elimino basandose en "0 consumidores externos",
    pero seguia siendo usado internamente por readDurationRange,
    resolveExpectedSlotMinutes y computeTotalDuration (7 llamadas). El
    deploy fallo con 7 errores no-undef.
    Leccion: la auditoria de ceros externos no sustituye la verificacion
    de usos internos del propio modulo. numberOrZero conserva su semantica
    (0 si NaN/Infinity O si < minimum); NO es reemplazable por
    toFiniteNumber (que preserva negativos y devuelve fallback).

ZC-05 (cero-deuda, auditoria estatica grep -rnw sobre el grafo completo +
verificacion manual de usos internos):
  ELIMINADOS por 0 consumidores externos Y 0 usos internos:
  getMadridTime, getMadridMonthKey, toUtcIsoZ, buildLocalDateRange,
  isPlainObject.
  PREVIAMENTE ELIMINADOS (MMU-12-03): getReferenceId, getReferenceIds,
  cleanGuid, booleanValue, toBoolean, toMadridIsoLocal, formatUtcOffset,
  _maskTaxId.
  ZC-06: _normalizeAscii des-exportado (helper interno de _safeSlugOrId,
  0 consumidores externos verificados con grep -rw Y 0 usos fuera del
  propio fichero).

REQUISITOS DEL ENTORNO: Velo + Wix Bookings V2 + Wix Stores Catalog V1.
=============================================================================
*/
export {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    PROTOCOL_URLS as URLS,
    PROTOCOL_UI as UI,
    WIDGET_ERROR_CODE
} from "public/widgetBridge";

/* ============================================================================
 * 1. CONSTANTES ESPEJO (frontend-safe) DEL SSOT backend/internalConfig.js
 * ==========================================================================*/
/** Espejo de SITE. No editable aqui sin actualizar internalConfig. */
export const SITE = Object.freeze({
    TIMEZONE: "Europe/Madrid",
    CURRENCY: "EUR",
    DECIMALS: 2,
    LOCALE: "es-ES",
    COUNTRY: "ES"
});

/**
 * Espejo de CURRENCY_CONFIG (internalConfig). Los nombres en espanol
 * MONEDA_VISUALIZACION / DECIMALES son intencionales: replican literalmente
 * las claves del SSOT backend para evitar traducciones divergentes.
 */
export const CURRENCY_CONFIG = Object.freeze({
    MONEDA_VISUALIZACION: SITE.CURRENCY,
    DECIMALES: SITE.DECIMALS
});

/** Espejo de SLOT_SEARCH (internalConfig). Nombres de config en espanol. */
export const SLOT_SEARCH = Object.freeze({
    DIAS_LIMITE: 14,
    MINUTOS_TOLERANCIA: 120,
    MINUTOS_MAX_HUECO_DUAL: 120
});

/** Espejo de BOOKINGS_ADDON_CONFIG (internalConfig). */
export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_POR_RESERVA: 5
});

/**
 * MMU-12-01: espejo de CHANNEL_TYPE (internalConfig). Canales canonicos.
 * Protocolo de sync: cualquier cambio en internalConfig.CHANNEL_TYPE debe
 * replicarse aqui en la misma iteracion.
 */
export const CHANNEL_TYPE = Object.freeze({
    ONLINE: "ONLINE",
    PRESENCIAL: "PRESENCIAL",
});

/**
 * MMU-12-01: espejo de PAYMENT_METHOD (internalConfig). Medios de pago.
 * Protocolo de sync: cualquier cambio en internalConfig.PAYMENT_METHOD debe
 * replicarse aqui en la misma iteracion.
 */
export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    TRANSFERENCIA: "TRANSFERENCIA",
    WIX_PAYMENTS: "WIX_PAYMENTS",
    OTRO: "OTRO",
    TARJETA_REGALO: "TARJETA_REGALO",
});

/** Tolerancia de cuadre entre duracion declarada y duracion real del slot. */
const SLOT_DURATION_TOLERANCE_MINUTES = 1;

/* ============================================================================
 * 2. PATRONES Y LIMITES
 * ==========================================================================*/
const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_ISO_PATTERN =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;
const MAX_TEXT_LENGTH = 5000;
const MAX_ID_LENGTH = 200;
const MAX_GUID_LENGTH = 100;
const MAX_SLUG_LENGTH = 200;
const MAX_TRACE_PREFIX_LENGTH = 40;
const MAX_TRACE_ID_LENGTH = 120;
const DEFAULT_TIMEOUT_MS = 15000;
const MS_PER_MINUTE = 60000;

/* ============================================================================
 * 3. TEXTO
 * ==========================================================================*/
export function _safeTrim(value, maxLength = MAX_TEXT_LENGTH) {
    if (value === null || value === undefined) return "";
    const limit = Math.max(1, Number(maxLength) || MAX_TEXT_LENGTH);
    return String(value).trim().slice(0, limit);
}

export function _cleanText(value, maxLength = MAX_TEXT_LENGTH) {
    return _safeTrim(value, maxLength).replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
        ""
    );
}

export function _normalizeIdPart(value, maxLength = MAX_ID_LENGTH) {
    return _cleanText(value, maxLength).replace(/[^a-zA-Z0-9._:-]/g, "_");
}

/** Helper interno: usado exclusivamente por _safeSlugOrId (ZC-06: des-exportado). */
function _normalizeAscii(value) {
    return String(value != null ? value : "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

/** Identidad publica (slug) o identidad tecnica (serviceId). */
export function _safeSlugOrId(value) {
    const raw = _safeTrim(value, MAX_SLUG_LENGTH);
    if (!raw) return "";
    if (_looksLikeGuid(raw)) return raw.toLowerCase();
    const normalized = _normalizeAscii(raw);
    if (normalized.indexOf("/") >= 0 || normalized.indexOf("\\") >= 0) {
        return "";
    }
    const slug = normalized.replace(/\s+/g, "-").toLowerCase();
    return /^[a-z0-9]+(?:[._:-]?[a-z0-9]+)*$/.test(slug) ? slug : "";
}

/* ============================================================================
 * 4. IDENTIFICADORES
 * ==========================================================================*/
export function _looksLikeGuid(value) {
    return GUID_PATTERN.test(_safeTrim(value, MAX_GUID_LENGTH));
}

/** Lista de GUIDs validos. Acepta Array<GUID>, CSV o Array<objeto>. */
export function cleanGuidList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
        ? value.split(",")
        : [];
    const guids = source
        .map((entry) => _safeTrim(getReferenceIdFromValue(entry), MAX_GUID_LENGTH))
        .filter(_looksLikeGuid);
    return Array.from(new Set(guids));
}

/** Variante estricta: extrae una clave concreta de objetos referencia. */
export function cleanGuidListByKey(value, key) {
    const cleanKey = _safeTrim(key, MAX_ID_LENGTH);
    if (!cleanKey) return [];
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
        ? value.split(",")
        : [];
    const guids = source
        .map((entry) => {
            if (typeof entry === "string") return _safeTrim(entry, MAX_GUID_LENGTH);
            if (entry && typeof entry === "object") {
                return _safeTrim(entry[cleanKey], MAX_GUID_LENGTH);
            }
            return "";
        })
        .filter(_looksLikeGuid);
    return Array.from(new Set(guids));
}

/**
 * Helper interno de cleanGuidList. NO exportado: la politica es que solo
 * `cleanGuidList` y `cleanGuidListByKey` resuelvan identidades.
 */
function getReferenceIdFromValue(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value, MAX_ID_LENGTH);
    if (Array.isArray(value)) {
        return value.length > 0 ? getReferenceIdFromValue(value[0]) : "";
    }
    if (typeof value === "object") {
        return _safeTrim(
            value._id || value.id || value.referenceId || value.value,
            MAX_ID_LENGTH
        );
    }
    return "";
}

/* ============================================================================
 * 5. NUMEROS Y DINERO
 * ==========================================================================*/
export function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * MMU-12-08: helper INTERNO (no exportado). Devuelve 0 si el numero es
 * NaN/Infinity O si es menor que `minimum`. NO es equivalente a
 * toFiniteNumber: numberOrZero(-5) -> 0; toFiniteNumber(-5) -> -5.
 * Consumidores internos: readDurationRange, resolveExpectedSlotMinutes,
 * computeTotalDuration.
 */
function numberOrZero(value, minimum = 0) {
    const parsed = Number(value);
    const floor = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
    return Number.isFinite(parsed) && parsed >= floor ? parsed : 0;
}

export function _roundMoney(value, decimals = CURRENCY_CONFIG.DECIMALES) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    const factor = 10 ** Math.max(0, toFiniteNumber(decimals, CURRENCY_CONFIG.DECIMALES));
    return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

export function _readPositiveAmount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/* ============================================================================
 * 6. FECHAS — ZONA UNICA Europe/Madrid
 * ==========================================================================*/
function formatMadridParts(date, options) {
    const dt = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(dt.getTime())) return null;
    return new Intl.DateTimeFormat("sv-SE", {
        timeZone: SITE.TIMEZONE,
        hourCycle: "h23",
        ...options
    })
        .formatToParts(dt)
        .reduce((result, part) => {
            result[part.type] = part.value;
            return result;
        }, {});
}

export function _normalizeLocalIsoStr(value) {
    const raw = _safeTrim(value, 80);
    if (!raw) return "";
    const normalized = raw.replace(/\s+/, "T");
    if (!LOCAL_ISO_PATTERN.test(normalized)) return "";
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return "";
    return normalized;
}

function hasExplicitOffset(value) {
    const raw = _safeTrim(value, 80);
    return /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
}

export function getUtcDateFromMadridLocal(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    const raw = _normalizeLocalIsoStr(value);
    if (!raw) return null;
    if (hasExplicitOffset(raw)) {
        const explicit = new Date(raw);
        return Number.isNaN(explicit.getTime()) ? null : explicit;
    }
    const naive = new Date(`${raw.length === 16 ? `${raw}:00` : raw}Z`);
    if (Number.isNaN(naive.getTime())) return null;
    const offsetMinutes = madridOffsetMinutes(naive);
    return new Date(naive.getTime() - offsetMinutes * MS_PER_MINUTE);
}

function parseDate(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    const raw = _normalizeLocalIsoStr(value);
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
    const clean = _safeTrim(value, 40);
    if (DATE_YMD_PATTERN.test(clean)) return clean;
    const date = _toDateSafe(value);
    if (!date) return null;
    return getMadridDateYmd(date);
}

/**
 * MMU-12-04: valida fecha YMD real (round-trip Date.UTC), no solo formato.
 */
export function isDateYmd(value) {
    const clean = _safeTrim(value, 10);
    if (!DATE_YMD_PATTERN.test(clean)) return false;
    const parts = clean.split("-").map(Number);
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

export function getMadridLocalStringNoZ(value) {
    const parts = formatMadridParts(value, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
    if (!parts) return "";
    return [
        `${parts.year}-${parts.month}-${parts.day}`,
        `${parts.hour}:${parts.minute}:${parts.second}`
    ].join("T");
}

export function getMadridDateYmd(date = new Date()) {
    const parts = formatMadridParts(date, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    if (!parts) return "";
    return `${parts.year}-${parts.month}-${parts.day}`;
}

// ZC-01 (cero-deuda): eliminados exports sin consumidor externo Y sin uso
// interno en el propio fichero: getMadridTime, getMadridMonthKey, toUtcIsoZ.
// Verificado con grep -rnw sobre el grafo Y grep manual dentro del fichero.

export function madridOffsetMinutes(date = new Date()) {
    const source = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(source.getTime())) return 0;
    const madridDate = new Date(
        source.toLocaleString("en-US", { timeZone: SITE.TIMEZONE })
    );
    const utcDate = new Date(
        source.toLocaleString("en-US", { timeZone: "UTC" })
    );
    return Math.round((madridDate.getTime() - utcDate.getTime()) / MS_PER_MINUTE);
}

// ZC-02 (cero-deuda): eliminado buildLocalDateRange (0 consumidores externos
// y 0 usos internos en el propio fichero).

export function toUtcRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(startLocal);
    const endUtc = getUtcDateFromMadridLocal(endLocal);
    if (!startUtc || !endUtc || endUtc <= startUtc) return null;
    return Object.freeze({ startUtc, endUtc });
}

export function computeGapMinutes(firstEndUtc, secondStartUtc) {
    if (!(firstEndUtc instanceof Date) || !(secondStartUtc instanceof Date)) {
        return null;
    }
    if (Number.isNaN(firstEndUtc.getTime()) || Number.isNaN(secondStartUtc.getTime())) {
        return null;
    }
    const gap = Math.round(
        (secondStartUtc.getTime() - firstEndUtc.getTime()) / MS_PER_MINUTE
    );
    return Number.isFinite(gap) ? gap : null;
}

export function isDualGapWithinLimit(gapMinutes) {
    if (!Number.isFinite(Number(gapMinutes))) return false;
    const gap = Number(gapMinutes);
    return gap >= 0 && gap <= SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL;
}

/* ============================================================================
 * 7. DURACIONES Y SLOTS
 * ==========================================================================*/
export function readDurationRange(item = {}) {
    const constraints =
        item.availabilityConstraints ||
        item.data?.availabilityConstraints ||
        item.fields?.availabilityConstraints;
    const range =
        constraints?.durationRange ||
        item.durationRange ||
        item.data?.durationRange ||
        item.fields?.durationRange;
    if (!range || typeof range !== "object") return null;
    const min = numberOrZero(range.minDuration ?? range.min);
    const rawMax = numberOrZero(range.maxDuration ?? range.max);
    const max = rawMax > 0 ? rawMax : Infinity;
    if (min <= 0 && max === Infinity) return null;
    if (max !== Infinity && max <= min) return null;
    return Object.freeze({ min, max });
}

export function resolveExpectedSlotMinutes(serviceConfig = {}) {
    if (serviceConfig.allowCombine === true) {
        return numberOrZero(serviceConfig.phase1Duration);
    }
    return numberOrZero(
        serviceConfig.phase1Duration ||
        serviceConfig.totalDuration ||
        serviceConfig.metadata?.timing?.estimatedTotal
    );
}

export function computeTotalDuration(serviceConfig = {}) {
    const phase1 = numberOrZero(serviceConfig.phase1Duration);
    const exposure = numberOrZero(serviceConfig.exposureDuration);
    const phase2 = numberOrZero(serviceConfig.phase2Duration);
    const sum = phase1 + exposure + phase2;
    return sum > 0 ? sum : null;
}

export function validateSlotDuration({
    serviceConfig = {},
    startLocal,
    endLocal
} = {}) {
    const base = Object.freeze({
        ok: true,
        code: null,
        actualMinutes: 0,
        expectedMinutes: null,
        min: null,
        max: null
    });
    const range = toUtcRange(startLocal, endLocal);
    if (!range) {
        return { ...base, ok: false, code: "INVALID_SLOT_RANGE" };
    }
    const actualMinutes = Math.round(
        (range.endUtc.getTime() - range.startUtc.getTime()) / MS_PER_MINUTE
    );
    const result = { ...base, actualMinutes };
    const limits = readDurationRange(serviceConfig);
    if (limits) {
        result.min = limits.min;
        result.max = limits.max === Infinity ? null : limits.max;
        const belowMin = actualMinutes < limits.min;
        const aboveMax = limits.max !== Infinity && actualMinutes > limits.max;
        if (belowMin || aboveMax) {
            return { ...result, ok: false, code: "SLOT_DURATION_OUT_OF_RANGE" };
        }
        return result;
    }
    const expected = resolveExpectedSlotMinutes(serviceConfig);
    if (expected > 0) {
        result.expectedMinutes = expected;
        if (Math.abs(actualMinutes - expected) > SLOT_DURATION_TOLERANCE_MINUTES) {
            return { ...result, ok: false, code: "SLOT_DURATION_MISMATCH" };
        }
    }
    return result;
}

/* ============================================================================
 * 8. OBJETOS
 * ==========================================================================*/
// ZC-03 (cero-deuda): eliminado isPlainObject (0 consumidores externos y 0
// usos internos en el propio fichero).

export function _cloneDeep(value) {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(_cloneDeep);
    return Object.entries(value).reduce((result, [key, child]) => {
        result[key] = _cloneDeep(child);
        return result;
    }, {});
}

export function _stableSerialize(value) {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) {
        return `[${value.map(_stableSerialize).join(",")}]`;
    }
    if (value instanceof Date) return `"${value.toISOString()}"`;
    if (typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

/* ============================================================================
 * 9. TRAZABILIDAD
 * ==========================================================================*/
export function _generateUUID() {
    const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;
    if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
        try {
            return globalCrypto.randomUUID();
        } catch (error) {
            // degrade to manual generator
        }
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
        const random = (Math.random() * 16) | 0;
        const value = character === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

export function makeTraceId(prefix = "trace") {
    const safePrefix = _normalizeIdPart(prefix, MAX_TRACE_PREFIX_LENGTH) || "trace";
    const traceId = `${safePrefix}-${Date.now().toString(36)}-${_generateUUID()}`;
    return traceId.slice(0, MAX_TRACE_ID_LENGTH);
}

export function _hashKey(value) {
    const stringValue = String(value ?? "");
    let hash1 = 0xdeadbeef ^ stringValue.length;
    let hash2 = 0x41c6ce57 ^ stringValue.length;
    for (let index = 0; index < stringValue.length; index += 1) {
        const character = stringValue.charCodeAt(index);
        hash1 = Math.imul(hash1 ^ character, 2654435761);
        hash2 = Math.imul(hash2 ^ character, 1597334677);
    }
    hash1 =
        Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^
        Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
    hash2 =
        Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^
        Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);
    return (
        (hash2 >>> 0).toString(16).padStart(8, "0") +
        (hash1 >>> 0).toString(16).padStart(8, "0")
    );
}

/* ============================================================================
 * 10. MENSAJERIA DE WIDGET (MMU-12-02)
 * Helpers compartidos por servicio-2 y calendario-2. NO sustituyen la
 * validacion de widgetBridge: el bridge sigue siendo SSOT del protocolo.
 * ==========================================================================*/

/** Extrae message.type en mayusculas. "" si no es objeto. */
export function _getMessageType(message) {
    if (!message || typeof message !== "object") return "";
    return String(message.type || "").trim().toUpperCase();
}

/** Extrae message.payload si es objeto plano; si no, {}. */
export function _getPayload(message) {
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

/* ============================================================================
 * 11. ENMASCARADO DE PII (logs sin datos personales)
 * API publica para backend/logger.js. No consumida por pages.
 * ==========================================================================*/
export function _maskEmail(value) {
    const email = _safeTrim(value, 254);
    const at = email.indexOf("@");
    if (at <= 1) return "[REDACTED_EMAIL]";
    return `${email[0]}***${email.slice(at - 1)}`;
}

export function _maskPhone(value) {
    const phone = _safeTrim(value, 40);
    return phone.length > 4 ? `***${phone.slice(-4)}` : "[REDACTED_PHONE]";
}

export function _maskName(value) {
    const name = _safeTrim(value, 120);
    return name ? `${name[0]}***` : "[REDACTED_NAME]";
}

/* ============================================================================
 * 12. ASINCRONIA
 * ==========================================================================*/
export function withTimeout(promiseOrFactory, timeoutMs, label = "OPERATION_TIMEOUT") {
    const factory =
        typeof promiseOrFactory === "function" ? promiseOrFactory : () => promiseOrFactory;
    const timeout = Math.max(1, toFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS));
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const error = new Error(label);
            error.code = "TIMEOUT";
            reject(error);
        }, timeout);
        Promise.resolve()
            .then(factory)
            .then((value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
    });
}

export async function _executeWithRetry(
    fn,
    maxRetries = 2,
    delayMs = 300,
    isRetryable = null
) {
    const retries = Math.max(0, toFiniteNumber(maxRetries, 0));
    const baseDelay = Math.max(0, toFiniteNumber(delayMs, 0));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const retryable = typeof isRetryable === "function" ? isRetryable(error) : true;
            if (!retryable || attempt >= retries) break;
            const wait = baseDelay * 2 ** attempt;
            await new Promise((resolve) => {
                setTimeout(resolve, wait);
            });
        }
    }
    throw lastError;
}