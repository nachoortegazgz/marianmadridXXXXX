/*
=============================================================================
MODULE: backend/reservas.web.js
VERSION: v10.5-STRONG-CONSISTENCY
BASE: v10.4-SSOT-CONSISTENT + correcciones de consistencia y members
RESPONSIBILITY: Catalogo de servicios, disponibilidad, slots duales,
asignacion de personal y metodos publicos de reservas.
DATA ACCESS: backend/dataAccess.js.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero COLLECTIONS alias.

CORRECCIONES v10.6-SSOT-ALIGNED:
RES-P1-01 (P1): _resolveAddonContext enriquecido con trazabilidad detallada.
  Catalogo validation + recuento de rechazos por inyeccion.
RES-P1-02 (P1): _toPublicService ahora EXPORTA linkedPhases + clientHidden validados.
  linkedPhases es CRÍTICO para dual booking en widget (faltaba en v10.5).
  clientHidden permite ocultación de servicios privados. Ambos con validación GUID.

FIXES HEREDADOS v10.5:
RES-32 (P0): _consumeDisplayToken pasaba STRONG_READ ({consistencyMode:"strong"})
  a dalGet. getItem -> buildOptions({consistencyMode:"strong"}) producia
  {consistencyMode:{consistencyMode:"strong"}}, degradando la lectura fuerte.
  Ahora dalGet(CONTROL_COL, tokenId, "strong") -> {consistencyMode:"strong"}.
RES-33 (P0): _getVisitorIdentity no desenvolvia @wix/members v2
  ({member}) -> memberId siempre "", rate limits colapsados a "anon".
  Ahora const member = response?.member || response.
RES-34 (P2): _toPublicService docstring decia "mantiene staffOptions"
  pero el codigo lo elimina (v10.3). Docstring corregido.

FIXES HEREDADOS v10.4: RES-30/31 (token single-use), RES-24..RES-29.
FIXES HEREDADOS v10.3: RES-24..RES-29.
FIXES HEREDADOS v10.2: RES-10..RES-23.
FIXED-v10.6: ADR-01 RESUELTA (_toPublicService ahora preserva linkedPhases+clientHidden).
=============================================================================
*/
import { webMethod, Permissions } from "wix-web-module";
import { query as dalQuery, removeById as dalRemoveById, saveItem, insertItem as dalInsert, getItem as dalGet, updateItem as dalUpdate } from "backend/dataAccess";
import { availabilityTimeSlots } from "@wix/bookings";
import { currentMember } from "@wix/members";
import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CITAS_BOOKING_STATUS,
    BOOKING_FIELDS,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFF_DEFAULT_NAME,
} from "backend/internalConfig";
import {
    findStaffByResourceId,
    getStaffDisplayName as _resolveDisplayName,
} from "backend/staff";
import { readControlPayload } from "backend/data";
import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _executeWithRetry,
    _hashKey,
    _generateUUID,
    _toDateSafe,
    withTimeout,
} from "public/mmUtils";
import {
    normalizeSlotShape as _normalizeSlotShapeShared,
    getResourceIdsFromSlot as _getResourceIdsFromSlotShared,
} from "backend/booking/bookingUtils";
import { logger } from "backend/logger";
import { rateLimiter } from "backend/security";

const log = logger;
const SERVICIOS_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;
const CONTROL_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const CT_DUAL_CACHE =
    (CONTROL_TYPE && CONTROL_TYPE.DUAL_CACHE) || "DUAL_CACHE";
const CT_DAYS_CACHE =
    (CONTROL_TYPE && CONTROL_TYPE.DAYS_CACHE) || "DAYS_CACHE";
const CT_DISPLAY_TOKEN =
    (CONTROL_TYPE && CONTROL_TYPE.DISPLAY_TOKEN) || "DISPLAY_TOKEN";
const STRONG_READ = Object.freeze({ consistencyMode: "strong" });
const WATCHDOG_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.WATCHDOG_MS) || 15000;
const SERVICE_CACHE_TTL_MS =
    Number(SDK_CONFIG?.CACHE?.SERVICES_TTL_MS) || 120000;
const SLOTS_CACHE_TTL_MS =
    Number(SDK_CONFIG?.CACHE?.SLOTS_CACHE_TTL_MS) || 60000;
const DUAL_CACHE_TTL_MS =
    Number(SDK_CONFIG?.CACHE?.DUAL_CACHE_TTL_MS) || 300000;
const DISPLAY_TOKEN_TTL_MS = 30 * 60 * 1000;
const DISPLAY_TOKEN_MAX_ATTEMPTS = 5;

const DIAS_LIMITE = Number(SLOT_SEARCH?.DIAS_LIMITE) || 14;
const configuredDualGap = Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL);
if (!Number.isFinite(configuredDualGap) || configuredDualGap < 0) {
    throw new Error(
        "[reservas.web] Missing valid SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL"
    );
}
const MAX_DUAL_GAP_MINUTES = configuredDualGap;
const CACHE_MAX_SIZE = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 500;
const DAYS_CACHE_VERSION = String(
    SDK_CONFIG?.CACHE?.DAYS_CACHE_VERSION || "v1"
);
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const LOCATION_TS_ID = SDK_CONFIG.LOCATION_ID;
const LOCATION_TS_TYPE = SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS;
const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();

/* =============================================================================
 * LOCAL HELPERS
 * ==========================================================================*/
function _readField(item, field) {
    if (!item || typeof item !== "object") return null;
    return item[field] ?? item.data?.[field] ?? item.fields?.[field] ?? null;
}

function _readOptionalResourceIds(value) {
    const source = Array.isArray(value) ? value : value ? [value] : [];
    return Array.from(
        new Set(
            source
                .map((item) => {
                    if (typeof item === "string") return _safeTrim(item);
                    return _safeTrim(item?._id || item?.id || item?.resourceId);
                })
                .filter((id) => _looksLikeGuid(id))
        )
    );
}

function _parseAddons(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function _extractMediaUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value);
    if (typeof value === "object") {
        return _safeTrim(value.url || value.src || value.fileUrl || "");
    }
    return "";
}

function _extractFirstRelationId(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value);
    if (Array.isArray(value)) return _extractFirstRelationId(value[0]);
    if (typeof value === "object") {
        return _safeTrim(value._id || value.id || value.locationId || "");
    }
    return "";
}

function _normalizeAddon(addon) {
    if (!addon || typeof addon !== "object") return null;
    const addonId = _safeTrim(addon.addonId || addon._id || addon.id || "");
    if (!_looksLikeGuid(addonId)) return null;
    const rawPrice = Number(addon.price ?? 0);
    const price = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
    return {
        addonId,
        name: _safeTrim(addon.name || addon.nombreComplemento) || "Complemento",
        price,
    };
}

/**
 * RES-P1-01: _resolveAddonContext enriquecido con trazabilidad.
 * Valida cada addonId solicitado contra catálogo de ComplementosCatalogo.
 * Retorna solo addons cuyo addonId existe en el servicio (prevents inyección).
 */
function _resolveAddonContext(service, requestedAddonIds) {
    const catalog = Array.isArray(service?.addOnOptions)
        ? service.addOnOptions
        : [];
    const catalogIds = new Set(
        catalog
            .map((a) => _safeTrim(a?.addonId || ""))
            .filter((id) => _looksLikeGuid(id))
    );
    const requested = Array.from(
        new Set(
            (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    );
    const validated = requested.filter((id) => catalogIds.has(id));

    if (requested.length > 0 && validated.length !== requested.length) {
        const rejectedCount = requested.length - validated.length;
        log.warn("_resolveAddonContext: addons rechazados (fuera de catalogo)", {
            traceSource: "reservas.web._resolveAddonContext",
            catalogSize: catalog.length,
            requested: requested.length,
            validated: validated.length,
            rejectedCount,
            context: "addon catalog validation",
            severity: rejectedCount > 3 ? "WARN" : "INFO"
        });
    }

    return {
        addOnIds: validated,        // Para Wix Bookings (transporte)
        nativeAddonIds: validated   // Alias interno para compatibilidad
    };
}

async function _getStaffDisplayName(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;
    try {
        const staff = await findStaffByResourceId(id);
        return _resolveDisplayName(staff);
    } catch (e) {
        log.warn("_getStaffDisplayName failed", {
            resourceId: id,
            error: e?.message,
        });
        return STAFF_DEFAULT_NAME;
    }
}

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
}

function _buildRateLimitKey(surface, visitorId, ipHash) {
    const base = _safeTrim(visitorId) || "anon";
    const ipSuffix = _safeTrim(ipHash) || "noip";
    return `${base}:${ipSuffix}:${surface}`;
}

function _rateLimitOrThrow(surface, key) {
    const result = rateLimiter({ surface, key });
    if (result && result.allowed) return;
    const error = new Error("RATE_LIMITED");
    error.code = "RATE_LIMITED";
    error.meta = { retryAfter: result?.retryAfter ?? null, surface };
    throw error;
}

/* RES-33: @wix/members v2 devuelve {member}. Desenvolver. */
async function _getVisitorIdentity() {
    try {
        const response = await currentMember.getMember();
        const member = response?.member || response;
        if (member && member.status === "ERROR") {
            return { memberId: "", isAuthenticated: false };
        }
        const memberId = _safeTrim(
            member?._id || member?.id || member?.memberId || ""
        );
        return { memberId, isAuthenticated: Boolean(memberId) };
    } catch (_) {
        return { memberId: "", isAuthenticated: false };
    }
}

function _hashIp(ipAddress) {
    const ip = _safeTrim(ipAddress);
    if (!ip) return "";
    return _hashKey(ip).slice(0, 16);
}

function _toPublicError(
    err,
    fallbackCode = "INTERNAL_ERROR",
    fallbackMessage = "Internal Error"
) {
    return {
        code: String(err?.code || fallbackCode),
        message: String(err?.message || fallbackMessage),
    };
}

function _normalizeSlotShape(slot) {
    return _normalizeSlotShapeShared(slot);
}

function _getResourceIdsFromSlot(slot) {
    return _getResourceIdsFromSlotShared(slot, STAFF_RESOURCE_TYPE_ID);
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const s = _normalizeSlotShape(slot);
    if (!s) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", {
            traceId,
            ctx,
            serviceId,
        });
        return null;
    }
    return {
        ...s,
        serviceId,
        ...(s.slot && typeof s.slot === "object"
            ? { slot: { ...s.slot, serviceId } }
            : {}),
    };
}

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function _addDaysYMD(ymd, days) {
    if (!_isValidMadridYmd(ymd)) return "";
    const parts = String(ymd).split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
}

function _filterDaysByLimit(daysArray) {
    if (!Array.isArray(daysArray) || daysArray.length === 0) return [];
    const now = new Date();
    const todayStr = now.toLocaleDateString("sv-SE", {
        timeZone: SDK_CONFIG.TZ,
    });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    if (!tomorrowStr || !maxDateStr) return [];
    return daysArray.filter(
        (date) => date >= tomorrowStr && date <= maxDateStr
    );
}

function _normalizeResourceIdsStrict(resourceId, traceId) {
    const normalized = _safeTrim(resourceId);
    if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) {
        return [];
    }
    if (!_looksLikeGuid(normalized)) {
        log.warn("_normalizeResourceIdsStrict: invalid staff identifier", {
            resourceId: normalized,
            traceId,
        });
        return null;
    }
    return [normalized];
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const ms = b.getTime() - a.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 60000);
}

function _isValidSlotRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startLocal));
    const endUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endLocal));
    return Boolean(startUtc && endUtc && endUtc.getTime() > startUtc.getTime());
}

/* =============================================================================
 * SERVICE CATALOG
 * ==========================================================================*/
export async function _getServiceBySlugOrIdInternal(
    slugOrId,
    externalTraceId = null,
    visited = new Set()
) {
    const traceId = externalTraceId || makeTraceId("service");
    const raw = _safeTrim(slugOrId);
    const isGuid = _looksLikeGuid(raw);
    const clean = isGuid
        ? raw
        : raw
        ? String(raw)
            .split("?")[0]
            .split("#")[0]
            .replace(/^\//, "")
            .replace(/\/$/, "")
        : "";
    const cycleKey = clean.toLowerCase();
    if (visited.has(cycleKey)) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_LINK_CYCLE",
                message: "Circular linked service configuration.",
            },
        };
    }
    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return { status: "SUCCESS", data: cached.data, error: null };
    }
    try {
        let result;
        if (isGuid) {
            result = await withTimeout(
                dalQuery(SERVICIOS_COL)
                    .limit(1)
                    .eq("serviceId", clean)
                    .find(STRONG_READ),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:serviceId"
            );
        } else {
            result = await withTimeout(
                dalQuery(SERVICIOS_COL)
                    .limit(1)
                    .eq("slug", clean)
                    .find(STRONG_READ),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:slug"
            );
            if (!result?.items?.[0] && _looksLikeGuid(clean)) {
                result = await withTimeout(
                    dalQuery(SERVICIOS_COL)
                        .limit(1)
                        .eq("serviceId", clean)
                        .find(STRONG_READ),
                    WATCHDOG_TIMEOUT_MS,
                    "getServiceBySlugOrId:guidFallback"
                );
            }
        }
        const service = result?.items?.[0] || null;
        if (!service) {
            log.error("Service not found in ServiciosCatalogo", {
                key: clean,
                traceId,
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SERVICE_NOT_FOUND",
                    message: `Servicio "${slugOrId}" no encontrado.`,
                },
            };
        }
        const nextVisited = new Set(visited);
        nextVisited.add(cycleKey);
        const mapped = await _mapServiceImport2ToUX(service, traceId);
        _cacheSetBounded(
            serviceCatalogRAM,
            clean,
            { data: mapped, timestamp: Date.now() },
            CACHE_MAX_SIZE
        );
        if (mapped.serviceId) {
            _cacheSetBounded(
                serviceCatalogRAM,
                mapped.serviceId,
                { data: mapped, timestamp: Date.now() },
                CACHE_MAX_SIZE
            );
        }
        if (mapped.slug) {
            _cacheSetBounded(
                serviceCatalogRAM,
                mapped.slug,
                { data: mapped, timestamp: Date.now() },
                CACHE_MAX_SIZE
            );
        }
        return { status: "SUCCESS", data: mapped, error: null };
    } catch (e) {
        log.error("Error in getServiceBySlugOrId", {
            error: e?.message,
            traceId,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DATABASE_ERROR",
                message: e?.message || "Error al consultar la base de datos.",
            },
        };
    }
}

export async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    if (_looksLikeGuid(raw)) return raw;
    const normalized = _safeSlugOrId(raw);
    if (!normalized) return null;
    const res = await _getServiceBySlugOrIdInternal(normalized);
    if (res?.status === "SUCCESS" && res?.data?.serviceId) {
        const sid = _safeTrim(res.data.serviceId);
        if (sid && _looksLikeGuid(sid)) return sid;
    }
    return null;
}

export async function _mapServiceToDTO(service, traceId, visited = new Set()) {
    const serviceId = _safeTrim(_readField(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error(
            "ServiciosCatalogo invalid: serviceId missing or not a GUID"
        );
    }
    const clientHidden = _readField(service, "clientHidden") === true;
    const rawAllowCombine = _readField(service, "allowCombine") === true;
    const allowCombine = !clientHidden && rawAllowCombine;
    const linkedPhases = _safeTrim(_readField(service, "linkedPhases"));
    if (rawAllowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error(
            "ServiciosCatalogo invalid: linkedPhases missing or not a GUID"
        );
    }
    if (rawAllowCombine) {
        const linkedRes = await _getServiceBySlugOrIdInternal(
            linkedPhases,
            traceId,
            visited
        );
        if (linkedRes?.status !== "SUCCESS" || !linkedRes.data) {
            throw new Error(
                "ServiciosCatalogo invalid: linked service unavailable or unresolvable"
            );
        }
    }
    const phase1Duration = Number(_readField(service, "phase1Duration")) || 0;
    const exposureDuration =
        Number(_readField(service, "exposureDuration")) || 0;
    const phase2Duration = Number(_readField(service, "phase2Duration")) || 0;
    const storedTotalDuration =
        Number(_readField(service, "totalDuration")) || 0;
    const calculatedDuration = allowCombine
        ? phase1Duration + exposureDuration + phase2Duration
        : phase1Duration;
    const estimatedTotal = Math.max(storedTotalDuration, calculatedDuration, 30);
    const title = _safeTrim(_readField(service, "title")) || "Servicio";
    const price = Number(_readField(service, "price")) || 0;
    const currency = _safeTrim(_readField(service, "currency")) || "EUR";
    const slug = _safeTrim(_readField(service, "slug")) || null;
    const mainMedia = _extractMediaUrl(_readField(service, "mainMedia"));
    const location = _safeTrim(_readField(service, "location")) || null;
    const locationId =
        _extractFirstRelationId(_readField(service, "locationId")) || null;
    const tagLine = _safeTrim(_readField(service, "tagLine")) || null;
    const description = _safeTrim(_readField(service, "description")) || null;
    const rawRecommendations = _readField(service, "recomendaciones");
    const recommendations = Array.isArray(rawRecommendations)
        ? rawRecommendations
        : [];
    const nameRef = _readField(service, "name");
    const referencedAddons = Array.isArray(nameRef) ? nameRef : [];
    const rawAddons =
        referencedAddons.length > 0
            ? referencedAddons
            : (_readField(service, "addOnOptions") ?? _readField(service, "addons"));
    const addOnOptions = _parseAddons(rawAddons)
        .map((addon) => _normalizeAddon(addon))
        .filter(Boolean);
    return {
        serviceId,
        sku: _safeTrim(_readField(service, "sku")) || null,
        slug,
        title,
        description,
        tagLine,
        price,
        currency,
        location,
        locationId,
        mainMedia,
        totalDuration: estimatedTotal,
        phase1Duration,
        phase2Duration,
        exposureDuration,
        allowCombine,
        linkedPhases: allowCombine ? linkedPhases : null,
        clientHidden,
        onlinePayment: _readField(service, "onlinePayment") !== false,
        inPersonPayment: _readField(service, "inPersonPayment") !== false,
        status: _safeTrim(_readField(service, "status")) || null,
        addOnOptions,
        recommendations,
    };
}

export async function _mapServiceImport2ToUX(row, traceId = null) {
    const dto = await _mapServiceToDTO(
        row,
        traceId || makeTraceId("ux-map"),
        new Set()
    );
    const cmsStaff = _readOptionalResourceIds(_readField(row, "availableStaff"));
    const staffOptions = [];
    for (const resourceId of cmsStaff) {
        const name = await _getStaffDisplayName(resourceId).catch(
            () => STAFF_DEFAULT_NAME
        );
        staffOptions.push({ resourceId, name });
    }
    return {
        ...dto,
        availableStaff: cmsStaff,
        staffOptions,
        status: dto.status || "ACTIVE",
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return await _getServiceBySlugOrIdInternal(
        serviceId,
        traceId || makeTraceId("service-internal")
    );
}

/* =============================================================================
 * PUBLIC WEB METHODS (catalog)
 * ==========================================================================*/
export const getServiceBySlugOrId = webMethod(
    Permissions.Anyone,
    async function getServiceBySlugOrId(slugOrId) {
        const traceId = makeTraceId("wm-svc");
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("reservas", visitor.memberId, "");
            _rateLimitOrThrow("reservas", rateKey);
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
            if (
                result?.status === "SUCCESS" &&
                result?.data?.clientHidden === true
            ) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "SERVICE_NOT_AVAILABLE",
                        message: "Service is not available for booking.",
                    },
                };
            }
            return result?.status === "SUCCESS"
                ? {
                    status: "SUCCESS",
                    data: _toPublicService(result.data),
                    error: null,
                }
                : result;
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "SERVICE_LOOKUP_FAILED"),
            };
        }
    }
);

export const resolveServiceId = webMethod(
    Permissions.Anyone,
    async (serviceIdReq) => {
        const traceId = makeTraceId("wm-svc-resolve");
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("reservas", visitor.memberId, "");
            _rateLimitOrThrow("reservas", rateKey);
            const resolved = await _resolveServiceIdInternal(serviceIdReq);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "SERVICE_NOT_FOUND",
                        message: "Identificador de servicio no encontrado.",
                    },
                };
            }
            return {
                status: "SUCCESS",
                data: String(resolved),
                error: null,
            };
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "SERVICE_RESOLVE_FAILED"),
            };
        }
    }
);

/**
 * RES-P1-02: _toPublicService exporta linkedPhases + clientHidden validados.
 * SSOT v10.0: linkedPhases es CRÍTICO para dual booking en widget.
 * clientHidden permite ocultación de servicios privados al cliente.
 *
 * Retira: status, availableStaff, staffOptions (datos internos).
 * Mantiene: addOnOptions (necesario para widget), price, title, linkedPhases,
 *           clientHidden (ambos necesarios para dual booking).
 * RES-34: el docstring de v10.4 decia que mantiene staffOptions, pero el
 * codigo lo elimina desde v10.3 (staffOptions contiene datos internos de
 * staff). Docstring corregido para coincidir con el codigo real.
 */
export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;

    // RES-P1-02: Validar linkedPhases con GUID antes de exportar
    const linkedPhases = (
        _safeTrim(service?.linkedPhases) &&
        _looksLikeGuid(_safeTrim(service?.linkedPhases))
    ) ? _safeTrim(service.linkedPhases) : null;

    // RES-P1-02: Normalizar clientHidden a booleano explícito
    const clientHidden = service?.clientHidden === true;

    const {
        status,
        availableStaff,
        staffOptions,
        ...publicService
    } = service;

    return {
        ...publicService,
        linkedPhases,      // CRÍTICO para dual booking
        clientHidden       // Para ocultación de servicios
    };
}

export async function _resolveAddonContextPublic(service, requestedAddonIds) {
    return _resolveAddonContext(service, requestedAddonIds);
}

export async function _getStaffDisplayNamePublic(resourceId) {
    return _getStaffDisplayName(resourceId);
}

/* =============================================================================
 * EXACT SLOT REVALIDATION
 * ==========================================================================*/
export async function revalidateExactAvailabilitySlot({
    serviceId,
    localStartDate,
    localEndDate,
    resourceId,
    nativeAddonIds = [],
    traceId,
}) {
    const activeTraceId = traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);
    const requiredResourceId = _safeTrim(resourceId || "");
    if (requiredResourceId && !_looksLikeGuid(requiredResourceId)) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_RESOURCE_ID",
                message: "Invalid staff identifier.",
            },
        };
    }
    if (!resolvedServiceId || !start || !end) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_SLOT_RECHECK",
                message: "Selected slot data is invalid.",
            },
        };
    }
    try {
        const normalizedNativeAddonIds = Array.from(
            new Set(
                (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
                    .map((id) => _safeTrim(id))
                    .filter((id) => _looksLikeGuid(id))
            )
        ).sort();
        let rawSlot = null;
        if (normalizedNativeAddonIds.length > 0) {
            const listPayload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: start,
                toLocalDate: end,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [
                    { id: LOCATION_TS_ID, locationType: LOCATION_TS_TYPE },
                ],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: {
                    addOnIds: normalizedNativeAddonIds,
                },
            };
            if (requiredResourceId) {
                listPayload.resourceTypes = [
                    {
                        resourceTypeId: STAFF_RESOURCE_TYPE_ID,
                        resourceIds: [requiredResourceId],
                    },
                ];
            }
            const listed = await _executeWithRetry(
                () =>
                    withTimeout(
                        availabilityTimeSlots.listAvailabilityTimeSlots(listPayload),
                        WATCHDOG_TIMEOUT_MS,
                        "listAvailabilityTimeSlots:addonRecheck"
                    ),
                2,
                300
            );
            rawSlot =
                (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find(
                    (slot) =>
                        _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate) === start &&
                        _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate) === end &&
                        slot?.bookable === true
                ) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: {
                    id: LOCATION_TS_ID,
                    locationType: LOCATION_TS_TYPE,
                },
                timeZone: SDK_CONFIG.TZ,
            };
            if (requiredResourceId) {
                getPayload.resourceTypes = [
                    {
                        resourceTypeId: STAFF_RESOURCE_TYPE_ID,
                        resourceIds: [requiredResourceId],
                    },
                ];
            }
            const result = await _executeWithRetry(
                () =>
                    withTimeout(
                        availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                        WATCHDOG_TIMEOUT_MS,
                        "getAvailabilityTimeSlot"
                    ),
                2,
                300
            );
            rawSlot = result?.timeSlot || null;
        }
        const normalized = _attachServiceId(
            rawSlot,
            resolvedServiceId,
            activeTraceId,
            "revalidateExactAvailabilitySlot"
        );
        const availableResourceIds = _getResourceIdsFromSlot(normalized);
        if (!normalized || normalized.bookable !== true) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available.",
                },
            };
        }
        if (
            requiredResourceId &&
            !availableResourceIds.includes(requiredResourceId)
        ) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_UNAVAILABLE",
                    message:
                        "Selected staff is no longer available for this slot.",
                },
            };
        }
        return {
            status: "SUCCESS",
            data: {
                slot: {
                    ...normalized,
                    localStartDate: start,
                    localEndDate: end,
                },
                resourceId:
                    requiredResourceId ||
                    (availableResourceIds.length === 1
                        ? availableResourceIds[0]
                        : null),
                candidateResourceIds: availableResourceIds,
            },
            error: null,
        };
    } catch (error) {
        const httpStatus =
            Number(
                error?.httpStatus ||
                error?.statusCode ||
                error?.response?.status ||
                0
            ) || null;
        const wixErrorCode =
            _safeTrim(error?.code || error?.details?.applicationError?.code) ||
            "UNKNOWN";
        log.warn("Exact slot recheck failed", {
            traceId: activeTraceId,
            wixErrorCode,
            httpStatus,
            message: error?.message || String(error),
            serviceId: String(resolvedServiceId),
            localStartDate: start,
            localEndDate: end,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SLOT_UNAVAILABLE",
                message: "Selected slot could not be revalidated.",
                traceId: activeTraceId,
            },
        };
    }
}

/* =============================================================================
 * TIME SLOT LISTING
 * ==========================================================================*/
async function _listTimeSlotsV2(
    { serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds = [] },
    options = {}
) {
    const { skipCache = false, timeSlotsPerDay } = options;
    const traceId = makeTraceId("slots");
    const fromKey = _normalizeLocalIsoStr(fromLocalDate);
    const toKey = _normalizeLocalIsoStr(toLocalDate);
    if (!fromKey || !toKey) return [];
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) return [];
    const normalizedResourceIds = Array.isArray(resourceIds)
        ? resourceIds.map(String).filter(Boolean)
        : [];
    const normalizedNativeAddonIds = Array.from(
        new Set(
            (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
    const resourceKey = normalizedResourceIds.slice().sort().join(",");
    const addonKey = normalizedNativeAddonIds.join(",");
    const cacheKey = `${String(resolvedServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0}`;
    if (!skipCache) {
        const cached = availabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) {
            return cached.data;
        }
        const inflight = inflightRequests.get(cacheKey);
        if (inflight) return inflight;
    }
    const p = (async () => {
        try {
            const resourceTypes = normalizedResourceIds.length
                ? [
                    {
                        resourceTypeId: STAFF_RESOURCE_TYPE_ID,
                        resourceIds: normalizedResourceIds,
                    },
                ]
                : [];
            const payload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: String(fromKey),
                toLocalDate: String(toKey),
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [
                    {
                        id: LOCATION_TS_ID,
                        locationType: LOCATION_TS_TYPE,
                    },
                ],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
            };
            if (resourceTypes.length) payload.resourceTypes = resourceTypes;
            if (normalizedNativeAddonIds.length > 0) {
                payload.customerChoices = {
                    addOnIds: normalizedNativeAddonIds,
                };
            }
            if (Number.isFinite(timeSlotsPerDay) && Number(timeSlotsPerDay) > 0) {
                payload.timeSlotsPerDay = Number(timeSlotsPerDay);
            }
            const data = await _executeWithRetry(
                () =>
                    withTimeout(
                        availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                        WATCHDOG_TIMEOUT_MS,
                        "listAvailabilityTimeSlots"
                    ),
                3,
                500
            );
            const rawSlots = Array.isArray(data?.timeSlots) ? data.timeSlots : [];
            const slots = rawSlots
                .map((s) => {
                    if (!s || s.bookable !== true) return null;
                    const start = s.localStartDate || s.startDate || "";
                    const end = s.localEndDate || s.endDate || "";
                    const fixed = _attachServiceId(
                        s,
                        resolvedServiceId,
                        traceId,
                        "_listTimeSlotsV2"
                    );
                    if (!fixed) return null;
                    if (!_isValidSlotRange(start, end)) return null;
                    return {
                        ...fixed,
                        localStartDate: _normalizeLocalIsoStr(start),
                        localEndDate: _normalizeLocalIsoStr(end),
                    };
                })
                .filter(Boolean);
            if (!skipCache) {
                _cacheSetBounded(
                    availabilityCache,
                    cacheKey,
                    { data: slots, timestamp: Date.now() },
                    CACHE_MAX_SIZE
                );
            }
            return slots;
        } catch (e) {
            log.error("_listTimeSlotsV2 failed", {
                traceId,
                message: e?.message,
            });
            return [];
        }
    })();
    if (!skipCache) {
        inflightRequests.set(cacheKey, p);
        try {
            return await p;
        } finally {
            inflightRequests.delete(cacheKey);
        }
    }
    return await p;
}

/* =============================================================================
 * STAFF LOAD BALANCING
 * ==========================================================================*/
async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, traceId) {
    const ymd = String(dateYMD || "").slice(0, 10);
    if (!_isValidMadridYmd(ymd)) return {};
    const ids = Array.isArray(resourceIds)
        ? resourceIds.map(String).filter(Boolean)
        : [];
    if (!ids.length) return {};
    const query = dalQuery(CITAS_COL)
        .eq(BOOKING_FIELDS.DATE_YMD, ymd)
        .in(BOOKING_FIELDS.STATUS, ["PENDING", "CONFIRMED"])
        .in("resourceId", ids)
        .limit(1000);
    let result = await withTimeout(
        query.find(STRONG_READ),
        WATCHDOG_TIMEOUT_MS,
        "balance:queryCitas"
    ).catch(() => null);
    const items = [...(result?.items || [])];
    try {
        while (result?.hasNext?.()) {
            result = await withTimeout(
                result.next(),
                WATCHDOG_TIMEOUT_MS,
                "balance:queryCitas.next"
            );
            items.push(...(result?.items || []));
        }
    } catch (e) {
        log.error("_getBookedMinutesByResourceForDay pagination failed", {
            traceId,
            message: e?.message,
        });
        const error = new Error("UPSTREAM_UNAVAILABLE");
        error.code = "UPSTREAM_UNAVAILABLE";
        throw error;
    }
    const minutes = {};
    ids.forEach((rid) => (minutes[rid] = 0));
    for (const it of items) {
        const rid = String(it?.resourceId || "").trim();
        if (!rid || minutes[rid] === undefined) continue;
        const start = _toDateSafe(it?.slotStart ?? it?.startDate);
        const end = _toDateSafe(it?.slotEnd ?? it?.endDate);
        if (!start || !end) continue;
        minutes[rid] += _minutesBetweenUtcDates(start, end);
    }
    return minutes;
}

async function _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId) {
    const ids = Array.from(
        new Set(
            Array.isArray(candidateResourceIds)
                ? candidateResourceIds.map(String).filter(Boolean)
                : []
        )
    );
    if (ids.length <= 1) return ids;
    const minutesMap = await _getBookedMinutesByResourceForDay(
        dateYMD,
        ids,
        traceId
    );
    const names = {};
    await Promise.allSettled(
        ids.map(async (rid) => {
            names[rid] = (await _getStaffDisplayName(rid).catch(() => "")) || "";
        })
    );
    return ids.sort((a, b) => {
        const ma = Number(minutesMap[a] || 0);
        const mb = Number(minutesMap[b] || 0);
        if (ma !== mb) return ma - mb;
        const na = String(names[a] || a);
        const nb = String(names[b] || b);
        return na.localeCompare(nb);
    });
}

async function _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) {
    const ranked = await _rankResourcesByLoad(
        candidateResourceIds,
        dateYMD,
        traceId
    );
    return ranked[0] || null;
}

async function _findNextSlotForServiceInternal(
    serviceId,
    fromLocalDateTime,
    requiredResourceId,
    traceId,
    sameDayOnly = false
) {
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_NOT_FOUND",
                message: "Service ID not found",
            },
        };
    }
    const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
    if (!fromLocal) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_DATES",
                message: "fromLocalDateTime invalid",
            },
        };
    }
    const strictRequiredResourceId = _safeTrim(requiredResourceId || "");
    if (
        strictRequiredResourceId &&
        !["all", "any"].includes(strictRequiredResourceId.toLowerCase()) &&
        !_looksLikeGuid(strictRequiredResourceId)
    ) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_RESOURCE_ID",
                message: "Invalid staff identifier.",
            },
        };
    }
    const startYMD = fromLocal.slice(0, 10);
    const mustHaveStaff = _looksLikeGuid(strictRequiredResourceId);
    const resourceIds = mustHaveStaff ? [strictRequiredResourceId] : [];
    const maxDayOffset = sameDayOnly ? 0 : DIAS_LIMITE;
    for (let i = 0; i <= maxDayOffset; i++) {
        const ymd = _addDaysYMD(startYMD, i);
        const dayFrom = i === 0 ? fromLocal : `${ymd}T00:00:00`;
        const dayTo = `${ymd}T23:59:59`;
        const slots = await _listTimeSlotsV2(
            {
                serviceId: resolvedServiceId,
                fromLocalDate: dayFrom,
                toLocalDate: dayTo,
                resourceIds,
            },
            { skipCache: true }
        );
        const normFrom = _normalizeLocalIsoStr(dayFrom);
        const candidates = (slots || [])
            .filter((s) => _normalizeLocalIsoStr(s.localStartDate) >= normFrom)
            .sort((a, b) =>
                String(a.localStartDate).localeCompare(String(b.localStartDate))
            );
        if (!candidates.length) continue;
        if (mustHaveStaff) {
            const required = String(strictRequiredResourceId);
            const match = candidates.find((s) =>
                _getResourceIdsFromSlot(s).includes(required)
            );
            if (match) {
                return {
                    status: "SUCCESS",
                    data: { slot: match, dayYMD: ymd },
                    error: null,
                };
            }
            continue;
        }
        return {
            status: "SUCCESS",
            data: { slot: candidates[0], dayYMD: ymd },
            error: null,
        };
    }
    return {
        status: "ERROR",
        data: null,
        error: {
            code: "SLOT_UNAVAILABLE",
            message: "No available slot found in search window.",
        },
    };
}

/* =============================================================================
 * RES-12: RESOLUCION DE STAFF PARA SLOT EXACTO
 * ==========================================================================*/
export async function _resolveStaffForSlotInternal(params) {
    const traceId = _safeTrim(params?.traceId) || makeTraceId("staff-internal");
    try {
        const f1Start = _normalizeLocalIsoStr(params?.f1Start);
        const f1End = _normalizeLocalIsoStr(params?.f1End || "");
        if (!f1Start) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "INVALID_SLOT_RECHECK",
                    message: "f1Start is required.",
                },
            };
        }
        const resolvedServiceId = await _resolveServiceIdInternal(params?.serviceId);
        if (!resolvedServiceId) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SERVICE_NOT_FOUND",
                    message: "Service ID not found",
                },
            };
        }
        const svcRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
        const serviceCfg = svcRes?.data;
        if (!serviceCfg) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SERVICE_CONFIG_MISSING",
                    message: "Service not in catalog",
                },
            };
        }
        if (serviceCfg.clientHidden === true) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SERVICE_NOT_AVAILABLE",
                    message: "Service is not available for booking.",
                },
            };
        }
        const linkedServiceId = _safeTrim(serviceCfg.linkedPhases || "");
        const isDual =
            serviceCfg.allowCombine === true && _looksLikeGuid(linkedServiceId);
        const f2Start = _normalizeLocalIsoStr(params?.f2Start || "");
        if (!isDual && f2Start) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "UNEXPECTED_F2_CONTEXT",
                    message: "Simple service cannot include F2 context.",
                },
            };
        }
        const addonContext = _resolveAddonContext(serviceCfg, params?.addOnIds);
        const dateYMD = f1Start.slice(0, 10);
        if (!_isValidMadridYmd(dateYMD)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "INVALID_DATES",
                    message: "f1Start has invalid Madrid day.",
                },
            };
        }
        const requestedResourceId = _safeTrim(params?.requestedResourceId || "");
        if (requestedResourceId && !_looksLikeGuid(requestedResourceId)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "INVALID_RESOURCE_ID",
                    message: "Invalid staff identifier.",
                },
            };
        }
        if (requestedResourceId) {
            const catalogStaff = Array.isArray(serviceCfg.availableStaff)
                ? serviceCfg.availableStaff.map(String)
                : [];
            if (
                catalogStaff.length > 0 &&
                !catalogStaff.includes(requestedResourceId)
            ) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "STAFF_NOT_AVAILABLE",
                        message:
                            "Selected staff is not available for this service.",
                    },
                };
            }
        }
        const slotsF1 = await _listTimeSlotsV2(
            {
                serviceId: resolvedServiceId,
                fromLocalDate: `${dateYMD}T00:00:00`,
                toLocalDate: `${dateYMD}T23:59:59`,
                resourceIds: requestedResourceId ? [requestedResourceId] : [],
                nativeAddonIds: addonContext.nativeAddonIds,
            },
            { skipCache: true }
        );
        const slotF1Raw = (slotsF1 || []).find((s) => {
            if (_normalizeLocalIsoStr(s.localStartDate) !== f1Start) return false;
            if (f1End && _normalizeLocalIsoStr(s.localEndDate) !== f1End) return false;
            return true;
        });
        if (!slotF1Raw) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "F1 slot is no longer available.",
                },
            };
        }
        const slotF1 = _attachServiceId(
            slotF1Raw,
            resolvedServiceId,
            traceId,
            "staffInternal:F1"
        );
        if (!slotF1) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "F1 slot could not be normalized.",
                },
            };
        }
        let candidateResourceIds = _getResourceIdsFromSlot(slotF1);
        let slotF2 = null;
        if (isDual) {
            if (!f2Start) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "F2_SLOT_REQUIRED",
                        message: "Dual service requires the certified F2 slot.",
                    },
                };
            }
            const f2Ymd = f2Start.slice(0, 10);
            if (f2Ymd !== dateYMD) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "F2_DIFFERENT_DAY",
                        message: "F2 must occur on the same Madrid day as F1.",
                    },
                };
            }
            const f2End = _normalizeLocalIsoStr(params?.f2End || "");
            const slotsF2 = await _listTimeSlotsV2(
                {
                    serviceId: linkedServiceId,
                    fromLocalDate: `${f2Ymd}T00:00:00`,
                    toLocalDate: `${f2Ymd}T23:59:59`,
                    resourceIds: [],
                    nativeAddonIds: [],
                },
                { skipCache: true }
            );
            const slotF2Raw = (slotsF2 || []).find((s) => {
                if (_normalizeLocalIsoStr(s.localStartDate) !== f2Start) return false;
                if (f2End && _normalizeLocalIsoStr(s.localEndDate) !== f2End) return false;
                return true;
            });
            if (!slotF2Raw) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "F2_UNAVAILABLE",
                        message: "F2 slot is no longer available.",
                    },
                };
            }
            const attachedF2 = _attachServiceId(
                slotF2Raw,
                linkedServiceId,
                traceId,
                "staffInternal:F2"
            );
            if (!attachedF2) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "F2_UNAVAILABLE",
                        message: "F2 slot could not be normalized.",
                    },
                };
            }
            const f1EndLocal = _normalizeLocalIsoStr(slotF1.localEndDate);
            const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (
                !f1EndUtc ||
                !f2StartUtc ||
                f2StartUtc.getTime() < f1EndUtc.getTime()
            ) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "INVALID_GAP",
                        message: "F2 must start after F1 ends.",
                    },
                };
            }
            const gapMinutes = _minutesBetweenUtcDates(f1EndUtc, f2StartUtc);
            const minimumGapMinutes = Math.max(
                0,
                Number(serviceCfg.exposureDuration || 0)
            );
            if (
                gapMinutes < minimumGapMinutes ||
                gapMinutes > MAX_DUAL_GAP_MINUTES
            ) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "INVALID_GAP",
                        message: "F2 gap is outside the allowed range.",
                    },
                };
            }
            const candidatesF2 = _getResourceIdsFromSlot(attachedF2);
            candidateResourceIds = candidateResourceIds.filter((id) =>
                candidatesF2.includes(id)
            );
            slotF2 = attachedF2;
        }
        if (!candidateResourceIds.length) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_NOT_AVAILABLE",
                    message: "No staff available for this slot.",
                },
            };
        }
        if (requestedResourceId) {
            if (!candidateResourceIds.includes(requestedResourceId)) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "STAFF_NOT_AVAILABLE",
                        message:
                            "Selected staff is not available for this slot.",
                    },
                };
            }
        }
        const finalResourceId =
            requestedResourceId ||
            (await _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId));
        if (!finalResourceId) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_NOT_AVAILABLE",
                    message: "No staff could be assigned.",
                },
            };
        }
        const resourceName =
            (await _getStaffDisplayName(finalResourceId).catch(() => "")) ||
            STAFF_DEFAULT_NAME;
        return {
            status: "SUCCESS",
            data: {
                resourceId: finalResourceId,
                resourceName,
                slotF1,
                slotF2,
                candidateResourceIds,
                dateYMD,
            },
            error: null,
        };
    } catch (err) {
        log.error("_resolveStaffForSlotInternal failed", {
            traceId,
            error: err?.message,
        });
        return {
            status: "ERROR",
            data: null,
            error: _toPublicError(err, "STAFF_RESOLVE_FAILED"),
        };
    }
}

/* =============================================================================
 * DUAL SLOT ENGINE + CACHE
 * ==========================================================================*/
export async function _cleanExpiredDualSlotsInternal({
    limit = 100,
    traceId = null,
} = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const now = new Date();
    const result = await withTimeout(
        dalQuery(CONTROL_COL)
            .eq("controlType", CT_DUAL_CACHE)
            .lt("expiresAt", now)
            .limit(safeLimit)
            .find(STRONG_READ),
        WATCHDOG_TIMEOUT_MS,
        "cleanExpiredDualSlotsQuery"
    );
    let removed = 0;
    for (const item of result?.items || []) {
        await withTimeout(
            dalRemoveById(CONTROL_COL, item._id),
            WATCHDOG_TIMEOUT_MS,
            "cleanExpiredDualSlotsRemove"
        ).catch(() => null);
        removed += 1;
    }
    log.info("Expired dual cache entries cleaned", {
        removed,
        traceId,
    });
    return { status: "SUCCESS", data: { removed }, error: null };
}

export async function _getCertifiedDualSlotsInternal(
    serviceId,
    resourceId,
    dateYMD,
    requestedAddonIds = []
) {
    const traceId = makeTraceId("dual");
    if (!serviceId || !_isValidMadridYmd(dateYMD)) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_PARAMS",
                message: "serviceId and valid Madrid dateYMD are required",
            },
        };
    }
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_NOT_FOUND",
                message: "Service ID not found",
            },
        };
    }
    const resourceIdsFilter = _normalizeResourceIdsStrict(resourceId, traceId);
    if (resourceIdsFilter === null) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_RESOURCE_ID",
                message: "Invalid staff identifier.",
            },
        };
    }
    const serviceRes = await _getServiceBySlugOrIdInternal(
        resolvedServiceId,
        traceId
    );
    if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_NOT_FOUND",
                message: "Service catalog missing",
            },
        };
    }
    const service = serviceRes.data;
    if (service.clientHidden === true) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_NOT_AVAILABLE",
                message: "Service is not available for booking.",
            },
        };
    }
    const addonContext = _resolveAddonContext(service, requestedAddonIds);
    const linkedServiceId = _safeTrim(service.linkedPhases || "");
    const isDual =
        service.allowCombine === true && _looksLikeGuid(linkedServiceId);
    const rankedCandidateCache = new Map();
    async function _rankCandidates(candidateResourceIds) {
        const normalized = Array.from(
            new Set((candidateResourceIds || []).map(String).filter(Boolean))
        );
        const key = normalized.slice().sort().join("|");
        if (!key) return [];
        if (rankedCandidateCache.has(key)) return rankedCandidateCache.get(key);
        const ranked = await _rankResourcesByLoad(normalized, dateYMD, traceId);
        rankedCandidateCache.set(key, ranked);
        return ranked;
    }
    const fromLocalDate = `${dateYMD}T00:00:00`;
    const toLocalDate = `${dateYMD}T23:59:59`;
    const slotsF1 = await _listTimeSlotsV2(
        {
            serviceId: resolvedServiceId,
            fromLocalDate,
            toLocalDate,
            resourceIds: resourceIdsFilter,
            nativeAddonIds: addonContext.nativeAddonIds,
        },
        { skipCache: true }
    );
    if (!isDual) {
        const out = [];
        for (const s1 of slotsF1 || []) {
            const candidateResourceIds = _getResourceIdsFromSlot(s1);
            const rankedCandidates = await _rankCandidates(candidateResourceIds);
            const chosen = rankedCandidates[0] || null;
            const pairToken = _generateUUID();
            const forcedSlot = _attachServiceId(
                { ...s1 },
                resolvedServiceId,
                traceId,
                "single"
            );
            if (!forcedSlot) continue;
            const localStartDate = _normalizeLocalIsoStr(forcedSlot.localStartDate);
            const localEndDate = _normalizeLocalIsoStr(forcedSlot.localEndDate);
            if (!localStartDate || !localEndDate) continue;
            if (!_isValidSlotRange(localStartDate, localEndDate)) continue;
            out.push({
                slotF1: {
                    localStartDate,
                    localEndDate,
                    slotRef: forcedSlot,
                    resourceId: chosen || null,
                },
                slotF2: null,
                resourceId: chosen || null,
                pairToken,
                candidateResourceIds,
                serviceId: resolvedServiceId,
                dateYMD,
            });
        }
        return { status: "SUCCESS", data: out, error: null };
    }
    const exposureMinutes = Number(service.exposureDuration ?? 0);
    const exposureMs = Math.max(0, exposureMinutes) * 60 * 1000;
    const pairs = [];
    for (const s1 of slotsF1 || []) {
        const s1EndLocal = _normalizeLocalIsoStr(s1.localEndDate);
        if (!s1EndLocal) continue;
        const s1EndUtc = getUtcDateFromMadridLocal(s1EndLocal);
        if (!s1EndUtc) continue;
        const earliestF2Utc = new Date(s1EndUtc.getTime() + exposureMs);
        const earliestF2Local = getMadridLocalStringNoZ(earliestF2Utc);
        const candidateResourceIds = _getResourceIdsFromSlot(s1);
        if (!candidateResourceIds.length) continue;
        const rankedCandidates = await _rankCandidates(candidateResourceIds);
        let chosenResourceId = null;
        let s2 = null;
        for (const candidateResourceId of rankedCandidates) {
            const nextF2 = await _findNextSlotForServiceInternal(
                linkedServiceId,
                earliestF2Local,
                candidateResourceId,
                traceId,
                true
            );
            if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) continue;
            const candidateF2 = nextF2.data.slot;
            const s2StartLocal = _normalizeLocalIsoStr(candidateF2.localStartDate);
            const s2EndLocal = _normalizeLocalIsoStr(candidateF2.localEndDate);
            if (
                !_isValidSlotRange(s1.localStartDate, s1.localEndDate) ||
                !_isValidSlotRange(s2StartLocal, s2EndLocal)
            ) {
                continue;
            }
            const s2StartUtc = getUtcDateFromMadridLocal(s2StartLocal);
            if (!s2StartUtc) continue;
            if (s2StartUtc.getTime() < s1EndUtc.getTime()) continue;
            const gapMinutes = _minutesBetweenUtcDates(s1EndUtc, s2StartUtc);
            const minimumGapMinutes = Math.max(0, exposureMinutes);
            if (
                gapMinutes < minimumGapMinutes ||
                gapMinutes > MAX_DUAL_GAP_MINUTES
            ) {
                continue;
            }
            const s2Staff = _getResourceIdsFromSlot(candidateF2);
            if (
                s2Staff.length === 0 ||
                !s2Staff.includes(String(candidateResourceId))
            ) {
                continue;
            }
            chosenResourceId = candidateResourceId;
            s2 = candidateF2;
            break;
        }
        if (!chosenResourceId || !s2) continue;
        const pairToken = _generateUUID();
        const forcedF1 = _attachServiceId(
            { ...s1 },
            resolvedServiceId,
            traceId,
            "dual:F1"
        );
        const forcedF2 = _attachServiceId(
            { ...s2 },
            linkedServiceId,
            traceId,
            "dual:F2"
        );
        if (!forcedF1 || !forcedF2) continue;
        const f1LocalStart = _normalizeLocalIsoStr(forcedF1.localStartDate);
        const f1LocalEnd = _normalizeLocalIsoStr(forcedF1.localEndDate);
        const f2LocalStart = _normalizeLocalIsoStr(forcedF2.localStartDate);
        const f2LocalEnd = _normalizeLocalIsoStr(forcedF2.localEndDate);
        if (!f1LocalStart || !f1LocalEnd || !f2LocalStart || !f2LocalEnd) continue;
        if (
            !_isValidSlotRange(f1LocalStart, f1LocalEnd) ||
            !_isValidSlotRange(f2LocalStart, f2LocalEnd)
        ) {
            continue;
        }
        const slotF1 = {
            localStartDate: f1LocalStart,
            localEndDate: f1LocalEnd,
            slotRef: forcedF1,
            resourceId: chosenResourceId,
        };
        const slotF2 = {
            localStartDate: f2LocalStart,
            localEndDate: f2LocalEnd,
            slotRef: forcedF2,
            resourceId: chosenResourceId,
        };
        pairs.push({
            slotF1,
            slotF2,
            resourceId: chosenResourceId,
            pairToken,
            candidateResourceIds,
            serviceId: resolvedServiceId,
            dateYMD,
        });
    }
    if (pairs.length > 0) {
        const cachePromises = pairs.map((slotPair) => {
            const expiresAt = new Date(Date.now() + DUAL_CACHE_TTL_MS);
            const record = {
                _id: String(slotPair.pairToken),
                controlType: CT_DUAL_CACHE,
                dedupeKey: "DUAL_" + String(slotPair.pairToken),
                serviceId: String(slotPair.serviceId),
                resourceId: String(slotPair.resourceId || ""),
                dateYmd: String(dateYMD),
                slotStart: getUtcDateFromMadridLocal(slotPair.slotF1.localStartDate),
                slotEnd: getUtcDateFromMadridLocal(
                    (slotPair.slotF2 || slotPair.slotF1).localEndDate
                ),
                expiresAt,
                payload: {
                    pairToken: slotPair.pairToken,
                    linkedPhases: String(linkedServiceId),
                    f1Start: slotPair.slotF1.localStartDate,
                    f1End: slotPair.slotF1.localEndDate,
                    f2Start: slotPair.slotF2 ? slotPair.slotF2.localStartDate : null,
                    f2End: slotPair.slotF2 ? slotPair.slotF2.localEndDate : null,
                    candidateResourceIds: slotPair.candidateResourceIds || [],
                },
                traceId,
            };
            return saveItem(CONTROL_COL, record).catch(() => null);
        });
        await Promise.allSettled(cachePromises);
    }
    return { status: "SUCCESS", data: pairs, error: null };
}

/* =============================================================================
 * CACHE INVALIDATION
 * ==========================================================================*/
async function _removeDualCacheForDay(serviceId, dateYmd, resourceId, traceId) {
    const ids = _normalizeResourceIdsStrict(resourceId, traceId);
    if (ids === null) return 0;
    let query = dalQuery(CONTROL_COL)
        .eq("controlType", CT_DUAL_CACHE)
        .eq("serviceId", String(serviceId))
        .eq("dateYmd", String(dateYmd));
    if (ids.length === 1) query = query.eq("resourceId", ids[0]);
    let page = await withTimeout(
        query.limit(1000).find(STRONG_READ),
        WATCHDOG_TIMEOUT_MS,
        "invalidateDualCacheQuery"
    );
    let removed = 0;
    while (page) {
        const items = page.items || [];
        await Promise.allSettled(
            items.map((item) =>
                dalRemoveById(CONTROL_COL, item._id).catch(() => null)
            )
        );
        removed += items.length;
        if (!page.hasNext || !page.hasNext()) break;
        page = await withTimeout(
            page.next(),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDualCacheNext"
        ).catch(() => null);
    }
    return removed;
}

export async function _invalidateCachesInternal(
    serviceId,
    dateYMD,
    resourceId,
    traceId = null
) {
    const tId = traceId || makeTraceId("invalidate");
    const resolvedServiceId =
        (await _resolveServiceIdInternal(serviceId)) || _safeTrim(serviceId);
    const ymd = _safeTrim(dateYMD);
    if (!resolvedServiceId || !_isValidMadridYmd(ymd)) {
        return { ok: true, traceId: tId, skipped: true };
    }
    const prefix = `${String(resolvedServiceId)}__`;
    for (const k of availabilityCache.keys()) {
        if (String(k).startsWith(prefix)) availabilityCache.delete(k);
    }
    const yearMonth = String(ymd).slice(0, 7);
    const resourceIds = (_normalizeResourceIdsStrict(resourceId, tId) || [])
        .sort()
        .join(",");
    const daysCacheKey = `DAYSCACHE_${DAYS_CACHE_VERSION}__${String(resolvedServiceId)}__${_hashKey(resourceIds)}__${String(yearMonth)}`;
    try {
        const daysPage = await withTimeout(
            dalQuery(CONTROL_COL)
                .eq("controlType", CT_DAYS_CACHE)
                .eq("dedupeKey", daysCacheKey)
                .limit(10)
                .find(STRONG_READ),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDaysCache"
        );
        await Promise.allSettled(
            (daysPage?.items || []).map((item) =>
                dalRemoveById(CONTROL_COL, item._id).catch(() => null)
            )
        );
    } catch (e) {
        log.warn("_invalidateCachesInternal: days cache cleanup skipped", {
            traceId: tId,
            message: e?.message,
        });
    }
    try {
        const removed = await _removeDualCacheForDay(
            resolvedServiceId,
            ymd,
            resourceId,
            tId
        );
        log.info("Dual cache invalidated", {
            traceId: tId,
            removed,
        });
    } catch (e) {
        log.warn("_invalidateCachesInternal: dual cache cleanup failed", {
            traceId: tId,
            message: e?.message,
        });
    }
    return { ok: true, traceId: tId };
}

export const invalidateCachesInternal = webMethod(
    Permissions.Admin,
    async (serviceId, dateYMD, resourceId) => {
        const traceId = makeTraceId("wm-invalidate-internal");
        try {
            const res = await _invalidateCachesInternal(
                serviceId,
                dateYMD,
                resourceId,
                traceId
            );
            return { status: "SUCCESS", data: res, error: null };
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "INVALIDATE_FAILED"),
            };
        }
    }
);

/* =============================================================================
 * PUBLIC AVAILABILITY METHODS
 * ==========================================================================*/
export const getAvailableDays = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, year, month, addonIds = []) => {
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("availability", visitor.memberId, "");
            _rateLimitOrThrow("availability", rateKey);
            return await _getAvailableDaysInternal({
                serviceId,
                resourceId,
                year,
                month,
                addonIds,
                traceId: makeTraceId("wm-days"),
            });
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "DAYS_QUERY_FAILED"),
            };
        }
    }
);

async function _queryAvailableDaysFromSlots(
    resolvedServiceId,
    resourceIds,
    fromLocal,
    toLocal,
    nativeAddonIds
) {
    const slots = await _listTimeSlotsV2(
        {
            serviceId: resolvedServiceId,
            fromLocalDate: `${fromLocal}T00:00:00`,
            toLocalDate: `${toLocal}T23:59:59`,
            resourceIds,
            nativeAddonIds,
        },
        { skipCache: true, timeSlotsPerDay: 1 }
    );
    const dateSet = new Set();
    (slots || []).forEach((s) => {
        if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
    });
    return Array.from(dateSet).sort();
}

async function _readDaysCacheWindow(daysCacheKey) {
    try {
        const page = await withTimeout(
            dalQuery(CONTROL_COL)
                .eq("controlType", CT_DAYS_CACHE)
                .eq("dedupeKey", daysCacheKey)
                .limit(1)
                .find(STRONG_READ),
            WATCHDOG_TIMEOUT_MS,
            "daysCacheRead"
        );
        const item = (page?.items || [])[0];
        if (!item) return null;
        const expiresAtMs = new Date(item.expiresAt).getTime();
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            return null;
        }
        const parsed = readControlPayload(item);
        if (!Array.isArray(parsed.availableDaysYmds)) return null;
        return parsed;
    } catch (e) {
        log.warn("_readDaysCacheWindow failed", { message: e?.message });
        return null;
    }
}

async function _writeDaysCacheWindow(daysCacheKey, payload) {
    const expiresAt = new Date(Date.now() + DUAL_CACHE_TTL_MS);
    const cacheId = `DAYS_${_hashKey(String(daysCacheKey))}`.slice(0, 64);
    const record = {
        _id: cacheId,
        controlType: CT_DAYS_CACHE,
        dedupeKey: String(daysCacheKey),
        serviceId: String(payload.serviceId || ""),
        resourceId: "",
        dateYmd: String(payload.yearMonth || ""),
        expiresAt,
        payload,
    };
    try {
        await saveItem(CONTROL_COL, record);
    } catch (e) {
        log.warn("_writeDaysCacheWindow failed", { message: e?.message });
    }
}

export async function _getAvailableDaysInternal({
    serviceId,
    resourceId,
    year,
    month,
    addonIds = [],
    traceId = null,
}) {
    const tId = traceId || makeTraceId("days-internal");
    const resolved = await _resolveServiceIdInternal(serviceId);
    if (!resolved) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" },
        };
    }
    const resourceIds = _normalizeResourceIdsStrict(resourceId, tId);
    if (resourceIds === null) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "INVALID_RESOURCE_ID",
                message: "Invalid staff identifier.",
            },
        };
    }
    const svcRes = await _getServiceBySlugOrIdInternal(resolved, tId);
    const service = svcRes?.data;
    if (!service) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_CONFIG_MISSING",
                message: "Service configuration missing",
            },
        };
    }
    if (service.clientHidden === true) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SERVICE_NOT_AVAILABLE",
                message: "Service is not available for booking.",
            },
        };
    }
    const addonContext = _resolveAddonContext(service, addonIds);
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_PARAMS", message: "Invalid year/month" },
        };
    }
    const yearMonth = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const todayStr = new Date().toLocaleDateString("sv-SE", {
        timeZone: SDK_CONFIG.TZ,
    });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    const firstDay = `${yearMonth}-01`;
    const lastDayNum = new Date(y, m, 0).getDate();
    const lastDay = `${yearMonth}-${String(lastDayNum).padStart(2, "0")}`;
    const fromLocal = tomorrowStr > firstDay ? tomorrowStr : firstDay;
    const toLocal = maxDateStr < lastDay ? maxDateStr : lastDay;
    if (fromLocal > toLocal) {
        return { status: "SUCCESS", data: [], error: null };
    }
    const daysCacheKey = `DAYSCACHE_${DAYS_CACHE_VERSION}__${String(resolved)}__${_hashKey(resourceIds.slice().sort().join(","))}__${yearMonth}`;
    const cachedWindow = await _readDaysCacheWindow(daysCacheKey);
    if (cachedWindow) {
        const emptySet = new Set(cachedWindow.emptyDaysYmds || []);
        const rebuilt = [];
        let cursor = fromLocal;
        while (cursor <= toLocal) {
            if (!emptySet.has(cursor)) rebuilt.push(cursor);
            cursor = _addDaysYMD(cursor, 1);
        }
        return {
            status: "SUCCESS",
            data: _filterDaysByLimit(rebuilt.sort()),
            error: null,
        };
    }
    const slotDays = await _queryAvailableDaysFromSlots(
        resolved,
        resourceIds,
        fromLocal,
        toLocal,
        addonContext.nativeAddonIds
    );
    const slotSet = new Set(slotDays);
    const emptyDaysYmds = [];
    let walk = fromLocal;
    while (walk <= toLocal) {
        if (!slotSet.has(walk)) emptyDaysYmds.push(walk);
        walk = _addDaysYMD(walk, 1);
    }
    await _writeDaysCacheWindow(daysCacheKey, {
        serviceId: resolved,
        yearMonth,
        fromLocal,
        toLocal,
        availableDaysYmds: slotDays,
        emptyDaysYmds,
    });
    return {
        status: "SUCCESS",
        data: _filterDaysByLimit(slotDays),
        error: null,
    };
}

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, dateYMD, addonIds = []) => {
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("availability", visitor.memberId, "");
            _rateLimitOrThrow("availability", rateKey);
            return await _getCertifiedDualSlotsInternal(
                serviceId,
                resourceId,
                dateYMD,
                addonIds
            );
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "DUAL_SLOTS_FAILED"),
            };
        }
    }
);

export const getAvailableSlots = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, dateYMD, addonIds = []) => {
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("availability", visitor.memberId, "");
            _rateLimitOrThrow("availability", rateKey);
            return await _getCertifiedDualSlotsInternal(
                serviceId,
                resourceId,
                dateYMD,
                addonIds
            );
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "SLOTS_QUERY_FAILED"),
            };
        }
    }
);

export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceId, start1, rId, addonIds = [], dualContext = null) => {
        const traceId = makeTraceId("wm-staff");
        try {
            const visitor = await _getVisitorIdentity();
            const rateKey = _buildRateLimitKey("availability", visitor.memberId, "");
            _rateLimitOrThrow("availability", rateKey);
            return await _resolveStaffForSlotInternal({
                serviceId,
                f1Start: start1,
                f1End: null,
                f2Start: dualContext?.start2 || null,
                f2End: dualContext?.end2 || null,
                requestedResourceId: _safeTrim(rId) || null,
                addOnIds: addonIds,
                traceId,
            });
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "STAFF_RESOLVE_FAILED"),
            };
        }
    }
);

/* =============================================================================
 * DISPLAY TOKEN (RES-24/29/30/31/32)
 * ==========================================================================*/
async function _generateDisplayToken(bookingId, traceId) {
    const token = _generateUUID();
    const tokenHash = _hashKey(token);
    const expiresAt = new Date(Date.now() + DISPLAY_TOKEN_TTL_MS);
    try {
        await dalInsert(CONTROL_COL, {
            _id: `DT_${tokenHash}`,
            controlType: CT_DISPLAY_TOKEN,
            dedupeKey: `DISPLAY_TOKEN_${tokenHash}`,
            bookingId: _safeTrim(bookingId),
            tokenHash,
            expiresAt,
            attempts: 0,
            maxAttempts: DISPLAY_TOKEN_MAX_ATTEMPTS,
            consumedAt: null,
            traceId,
        });
        return token;
    } catch (e) {
        log.error("_generateDisplayToken failed", {
            bookingId,
            traceId,
            error: e?.message,
        });
        throw new Error("TOKEN_GENERATION_FAILED");
    }
}

async function _validateAndConsumeDisplayToken(token, traceId) {
    const tokenHash = _hashKey(token);
    const tokenId = `DT_${tokenHash}`;
    try {
        const tokenRecord = await withTimeout(
            dalQuery(CONTROL_COL)
                .eq("controlType", CT_DISPLAY_TOKEN)
                .eq("tokenHash", tokenHash)
                .limit(1)
                .find(STRONG_READ),
            WATCHDOG_TIMEOUT_MS,
            "validateDisplayToken"
        );
        const record = tokenRecord?.items?.[0];
        if (!record) {
            return { valid: false, reason: "TOKEN_NOT_FOUND" };
        }
        const expiresAtMs = new Date(record.expiresAt).getTime();
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            return { valid: false, reason: "TOKEN_EXPIRED" };
        }
        if (record.consumedAt) {
            return { valid: false, reason: "TOKEN_ALREADY_CONSUMED" };
        }
        if (record.attempts >= record.maxAttempts) {
            return { valid: false, reason: "TOKEN_MAX_ATTEMPTS_EXCEEDED" };
        }
        const updatedAttempts = (record.attempts || 0) + 1;
        await dalUpdate(CONTROL_COL, { ...record, attempts: updatedAttempts });
        const consumed = await _consumeDisplayToken(tokenId, traceId);
        if (!consumed) {
            return { valid: false, reason: "TOKEN_ALREADY_CONSUMED" };
        }
        return {
            valid: true,
            bookingId: record.bookingId,
            tokenId,
        };
    } catch (e) {
        log.error("_validateAndConsumeDisplayToken failed", {
            traceId,
            error: e?.message,
        });
        return { valid: false, reason: "VALIDATION_ERROR" };
    }
}

/**
 * RES-30 (P0): consume el token con escritura condicional atomica.
 * RES-32 (P0): dalGet espera STRING "strong", no {consistencyMode:"strong"}.
 * DTO-12 fix (single-use real): el consumo es delete-atomic por _id.
 * wixData.remove(collection, id) elimina la fila existente o lanza si no
 * existe; entre dos lecturas previas solo UNA remove puede triunfar, sin
 * depender del campo _revision (el mock de tests no lo incrementa y el SDK
 * legacy de dataAccess no hace CAS en update). El rechazo concurrente se
 * observa como TOKEN_ALREADY_CONSUMED y el replay posterior como
 * TOKEN_NOT_FOUND: contrato uniforme anti-enumeracion.
 */
async function _consumeDisplayToken(tokenId, traceId) {
    try {
        const fresh = await dalGet(CONTROL_COL, tokenId, "strong");
        if (!fresh) return false;
        if (fresh.consumedAt) return false;
        await dalRemoveById(CONTROL_COL, fresh._id);
        return true;
    } catch (e) {
        // Remove fallido = fila ya consumida/eliminada por otra ejecucion
        // (o inexistente). Fail-closed: nunca doble exito.
        log.warn("_consumeDisplayToken rejected (already consumed or gone)", {
            tokenId,
            traceId,
            error: e?.message,
        });
        return false;
    }
}

export const getConfirmedBookingForDisplay = webMethod(
    Permissions.Anyone,
    async ({ bookingId, displayToken } = {}) => {
        const traceId = makeTraceId("wm-display");
        let id;
        let guardMemberId = "";
        let guardViaToken = false;
        if (typeof displayToken === "string" && displayToken.length > 0) {
            const tokenValidation = await _validateAndConsumeDisplayToken(
                displayToken,
                traceId
            );
            if (!tokenValidation.valid) {
                return {
                    ok: false,
                    data: null,
                    error: tokenValidation.reason,
                    message: "Invalid or expired display token.",
                };
            }
            id = _safeTrim(tokenValidation.bookingId);
            if (!id || !_looksLikeGuid(id)) {
                return { ok: false, data: null, error: "INVALID_PAYLOAD" };
            }
            guardViaToken = true;
        } else {
            const idPre = _safeTrim(bookingId);
            if (!idPre || !_looksLikeGuid(idPre)) {
                return { ok: false, data: null, error: "INVALID_PAYLOAD" };
            }
            const visitor = await _getVisitorIdentity();
            if (!visitor.isAuthenticated) {
                return {
                    ok: false,
                    data: null,
                    error: "AUTH_REQUIRED",
                    message: "Display token required for unauthenticated access.",
                };
            }
            id = idPre;
            guardMemberId = visitor.memberId;
        }
        try {
            const res = await withTimeout(
                dalQuery(BUSINESS_COLLECTIONS.CITAS_F2)
                    .eq("bookingId", id)
                    .limit(1)
                    .find(STRONG_READ),
                WATCHDOG_TIMEOUT_MS,
                "getConfirmedBookingForDisplay"
            );
            const rec = res?.items?.[0];
            if (!rec) return { ok: false, data: null, error: "NOT_FOUND" };
            if (!guardViaToken && guardMemberId) {
                const contactDetails = rec.contactDetails || {};
                const citaMemberId = _safeTrim(
                    contactDetails.memberId || rec.memberId || ""
                );
                if (!citaMemberId || citaMemberId !== guardMemberId) {
                    return { ok: false, data: null, error: "ACCESS_DENIED" };
                }
            }
            const rawStatus = String(rec.bookingStatus || "").toUpperCase();
            const isConfirmed =
                rawStatus === CITAS_BOOKING_STATUS?.CONFIRMED ||
                rawStatus === "CONFIRMED";
            if (!isConfirmed) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }
            const data = {};
            for (const key of [
                "bookingId",
                "bookingStatus",
                "paymentStatus",
                "pairToken",
                "serviceId",
                "dateYmd",
                "slotStart",
                "slotEnd",
                "resourceId",
            ]) {
                if (rec[key] !== undefined && rec[key] !== null) {
                    data[key] = rec[key];
                }
            }
            data.bookingStatus = "CONFIRMED";
            return { ok: true, data, error: null };
        } catch (e) {
            log.warn("getConfirmedBookingForDisplay failed", {
                bookingId: id,
                error: e?.message,
            });
            return { ok: false, data: null, error: "INTERNAL_ERROR" };
        }
    }
);

export const generateDisplayToken = webMethod(
    Permissions.Anyone,
    async ({ bookingId, confirmationToken } = {}) => {
        const traceId = makeTraceId("wm-gen-token");
        const visitor = await _getVisitorIdentity();
        const rateKey = _buildRateLimitKey("display-token", visitor.memberId, "");
        _rateLimitOrThrow("display-token", rateKey);
        const id = _safeTrim(bookingId);
        if (!id || !_looksLikeGuid(id)) {
            return { ok: false, token: null, error: "INVALID_PAYLOAD" };
        }
        if (!visitor.isAuthenticated && !_safeTrim(confirmationToken)) {
            return {
                ok: false,
                token: null,
                error: "AUTH_REQUIRED",
                message:
                    "Membership or confirmation credential required to issue a display token.",
            };
        }
        try {
            const res = await withTimeout(
                dalQuery(BUSINESS_COLLECTIONS.CITAS_F2)
                    .eq("bookingId", id)
                    .limit(1)
                    .find(STRONG_READ),
                WATCHDOG_TIMEOUT_MS,
                "verifyBookingForToken"
            );
            const rec = res?.items?.[0];
            if (!rec) return { ok: false, token: null, error: "NOT_FOUND" };
            const rawStatus = String(rec.bookingStatus || "").toUpperCase();
            const isConfirmed =
                rawStatus === CITAS_BOOKING_STATUS?.CONFIRMED ||
                rawStatus === "CONFIRMED";
            if (!isConfirmed) {
                return { ok: false, token: null, error: "NOT_CONFIRMED" };
            }
            if (visitor.isAuthenticated) {
                const ownerId = _safeTrim(
                    (rec.contactDetails && rec.contactDetails.memberId) ||
                        rec.memberId ||
                        ""
                );
                if (!ownerId || ownerId !== visitor.memberId) {
                    return { ok: false, token: null, error: "ACCESS_DENIED" };
                }
            } else {
                const credHash = _hashKey(_safeTrim(confirmationToken));
                const credRec = await withTimeout(
                    dalQuery(CONTROL_COL)
                        .eq("controlType", CT_DISPLAY_TOKEN)
                        .eq("bookingId", id)
                        .limit(5)
                        .find(STRONG_READ),
                    WATCHDOG_TIMEOUT_MS,
                    "verifyEmissionCredential"
                );
                const ownsCredential = (credRec?.items || []).some(
                    (row) => row.tokenHash && row.tokenHash === credHash
                );
                if (!ownsCredential) {
                    return { ok: false, token: null, error: "ACCESS_DENIED" };
                }
            }
            const token = await _generateDisplayToken(id, traceId);
            return {
                ok: true,
                token,
                expiresIn: DISPLAY_TOKEN_TTL_MS,
                maxAttempts: DISPLAY_TOKEN_MAX_ATTEMPTS,
                error: null,
            };
        } catch (e) {
            log.error("generateDisplayToken failed", {
                bookingId: id,
                traceId,
                error: e?.message,
            });
            return { ok: false, token: null, error: "TOKEN_GENERATION_FAILED" };
        }
    }
);
