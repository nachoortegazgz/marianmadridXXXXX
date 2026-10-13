/**
 * =============================================================================
 * FILE: backend/reservas.web.js
 * VERSION: v10-CMS-FINAL
 * BASE: refactor-reservas-v9-final-delegated + correcciones P0/P1 de alineacion
 *       (CMS KEY FIELDS, matriz legacy, Biblia SSOT, bookingSaga v5013).
 * RESPONSIBILITY: Availability engine, dual slots with gap, same-staff pairing,
 *   workload-balanced staff allocation, caches en ControlOperativo y
 *   webMethods publicos de catalogo/disponibilidad.
 * STANDARDS: G10 ASCII Strict. Rate limiting en superficies Anyone (BIBLIA 15.2).
 *
 * ALINEACION CMS (KEY FIELDS reales):
 *   - ServiciosCatalogo: serviceId, slug, title, tagLine, description, price,
 *     currency, location, locationId, mainMedia, totalDuration, phase1Duration,
 *     phase2Duration, exposureDuration, allowCombine, linkedPhases,
 *     clientHidden, availableStaff, addOnOptions, onlinePayment,
 *     inPersonPayment, status.
 *   - ComplementosCatalogo: addonId (SSOT), name, price.
 *   - CitasF2: dateYmd, bookingStatus (enum CMS: PENDING/CONFIRMED/...),
 *     slotStart, slotEnd, resourceId.
 *   - ControlOperativo: controlType DUAL_CACHE / DAYS_CACHE (sustituyen a las
 *     colecciones legacy DualSlotCache / AvailabilityDaysCache, matriz S3).
 *
 * CORRECCIONES v10 respecto a v9:
 *   RES-10 (P0): dependencia fantasma backend/reservas.service eliminada.
 *     _resolveAddonContext y _getStaffDisplayName implementados localmente.
 *   RES-11 (P0): _resolveServiceIdInternal exportado (lo importa bookingSaga).
 *   RES-12 (P0): nuevo _resolveStaffForSlotInternal con el contrato exacto
 *     que consume bookingSaga v5013 PHASE 1. resolveStaffForSlot (webMethod)
 *     delega en el (una sola implementacion, BIBLIA 0.5.1).
 *   RES-13 (P0): nuevo webMethod getAvailableSlots (lo importa la pagina
 *     Calendario de reservas 2). Delega en _getCertifiedDualSlotsInternal,
 *     que ya resuelve servicios simples (slotF2: null).
 *   RES-14 (P0): _mapServiceImport2ToUX YA NO rechaza el linked F2 por
 *     clientHidden=true. Los servicios F2 son ocultos por diseno (BIBLIA,
 *     resumen ejecutivo: 24 F2 ocultos). La visibilidad publica se controla
 *     en los entry points (C9) sobre el servicio PADRE.
 *   RES-15 (P0): availableStaff (key canonica, matriz) sustituye a
 *     staffDisponible. Fallback de lectura transitorio con warn.
 *   RES-16 (P1): balanceo con bookingStatus in [PENDING, CONFIRMED].
 *     PENDING_PAYMENT no es valor del enum CMS de bookingStatus.
 *   RES-17 (P1): slotStart/slotEnd de CitasF2 se leen con _toDateSafe
 *     (wix-data devuelve Date; _normalizeLocalIsoStr(Date) devolvia ""
 *     y el balanceo computaba siempre 0 minutos).
 *   RES-18 (P1): caches dual/days migradas a ControlOperativo
 *     (DUAL_CACHE / DAYS_CACHE). Payload compacto en payloadJson.
 *   RES-19 (P1): wix-data + suppressAuth -> DAL unificado con lectura fuerte
 *     (consistency: STRONG; mismo camino de datos que bookingCore/bookingSaga).
 *   RES-20 (P1): rate limiting en webMethods Anyone (BIBLIA 15.2/15.3).
 *   RES-21 (P1): DTO expone locationId normalizado (primer GUID de la
 *     Multi Reference). Consumidores: bookingSaga (_resolveBookingLocation,
 *     _validateLinkedPhaseService).
 *   RES-22 (P1): mainMedia tolerante a string URL u objeto Image nativo
 *     (ADR pendiente BIBLIA 17.1).
 *   RES-23 (P2): _toPublicService retira linkedPhases, clientHidden,
 *     availableStaff y status (minimizacion DTO, BIBLIA 0.5.8/15.1.8).
 *   RES-24 (P2): STAFF_DEFAULT_NAME local (export en internalConfig sin
 *     verificar; se evita fallo de carga del modulo).
 *
 * CORRECCIONES HEREDADAS v9: C1..C13 (contrato slotF1/slotF2, paginacion de
 *   invalidacion, rechazo resourceId no GUID, deteccion de ciclos linkedPhases,
 *   addonId canonico, validacion F2>F1, estados canonicos, delegacion en
 *   bookingUtils).
 *
 * CONTRATO ADD-ONS (alineado con bookingSaga v5013 SAGA-23):
 *   DTO expone addOnOptions: [{ addonId, name, price }]. addonId es la key
 *   fisica real de ComplementosCatalogo (CMS KEY FIELDS). La saga lee
 *   addonId con fallback addOnId/_id. La pagina acepta addonId||addOnId.
 *
 * PENDIENTES (fuera de este pase):
 *   - Ninguno. RES-19 completado: consumo directo de backend/dataAccess
 *     (cero dataLegacyAdapter en este modulo).
 * =============================================================================
 */
import { webMethod, Permissions } from "wix-web-module";
import {
    wql,
    order,
    CONSISTENCY,
    queryItems,
    queryFirstItem,
    saveItem,
    removeItemIfPresent,
} from "backend/dataAccess";
import { availabilityTimeSlots } from "@wix/bookings";
import {
    COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFF_DEFAULT_NAME,
    CITAS_BOOKING_STATUS,
} from "backend/internalConfig";
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

/* =============================================================================
 * CONSTANTS
 * ==========================================================================*/
const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;
const CITAS_COL = COLLECTIONS.CITAS_F2;
const MAPA_STAFF_COL = COLLECTIONS.MAPA_STAFF;
const CONTROL_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
/* RES-18: caches en ControlOperativo. PEND-02 resuelto: CONTROL_TYPE incluye
 * ya DUAL_CACHE/DAYS_CACHE (ADR materializado en internalConfig). Se mantiene
 * el fallback literal por tolerancia a versiones anteriores del SSOT. */
const CT_DUAL_CACHE = (CONTROL_TYPE && CONTROL_TYPE.DUAL_CACHE) || "DUAL_CACHE";
const CT_DAYS_CACHE = (CONTROL_TYPE && CONTROL_TYPE.DAYS_CACHE) || "DAYS_CACHE";
/* Lectura fuerte canonica (matriz transversal, DAL v2). */
const STRONG = CONSISTENCY.STRONG;
/* RES-24 / PEND-06 resuelto: STAFF_DEFAULT_NAME proviene ahora del export
 * verificado en backend/internalConfig.js (BLOQUE 17, SSOT). */

const WATCHDOG_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WATCHDOG_MS) || 15000;
const SERVICE_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.SERVICES_TTL_MS) || 120000;
const SLOTS_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.SLOTS_CACHE_TTL_MS) || 60000;
const DUAL_CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.DUAL_CACHE_TTL_MS) || 300000;
const DIAS_LIMITE = Number(SLOT_SEARCH?.DIAS_LIMITE) || 14;
const configuredDualGap = Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL);
if (!Number.isFinite(configuredDualGap) || configuredDualGap < 0) {
    throw new Error(
        "[reservas.web] Missing valid SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL configuration"
    );
}
const MAX_DUAL_GAP_MINUTES = configuredDualGap;
const CACHE_MAX_SIZE = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 500;
const DAYS_CACHE_VERSION = String(SDK_CONFIG?.CACHE?.DAYS_CACHE_VERSION || "v1");
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const LOCATION_TS_ID = SDK_CONFIG.LOCATION_ID;
const LOCATION_TS_TYPE = SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS;

const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();
const staffNameRAM = new Map();

/* =============================================================================
 * LOCAL HELPERS (RES-10: sustituyen a backend/reservas.service)
 * ==========================================================================*/
function _readImport2Field(item, field) {
    if (!item || typeof item !== "object") return null;
    return item[field] ?? item.data?.[field] ?? item.fields?.[field] ?? null;
}

function _readOptionalImport2ResourceIds(value) {
    const source = Array.isArray(value) ? value : (value ? [value] : []);
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

function _parseImport2Addons(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

/* RES-22: mainMedia puede ser URL de texto u objeto Image nativo (ADR
 * pendiente). Se extrae la URL sin romper en ninguna de las dos formas. */
function _extractMediaUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value);
    if (typeof value === "object") {
        return _safeTrim(value.url || value.src || value.fileUrl || "");
    }
    return "";
}

/* RES-21: locationId es Multi Reference (cms.v8). Se normaliza al primer
 * GUID resoluble. Tambien tolera texto plano durante la transicion. */
function _extractFirstRelationId(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value);
    if (Array.isArray(value)) return _extractFirstRelationId(value[0]);
    if (typeof value === "object") {
        return _safeTrim(value._id || value.id || value.locationId || "");
    }
    return "";
}

/**
 * C5 + RES-15: contrato canonico de complemento.
 * addonId (key fisica real de ComplementosCatalogo, CMS KEY FIELDS) con
 * fallbacks de lectura addOnId/_id/id para referencias sin expandir.
 */
function _normalizeImport2Addon(addon) {
    if (!addon || typeof addon !== "object") return null;
    const addonId = _safeTrim(
        addon.addonId || addon.addOnId || addon._id || addon.id || ""
    );
    if (!_looksLikeGuid(addonId)) return null;
    const rawPrice = Number(addon.price ?? 0);
    const price = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
    return {
        addonId,
        name: _safeTrim(addon.name || addon.title) || "Complemento",
        price,
    };
}

/**
 * RES-10: contexto de add-ons local. Valida los GUIDs solicitados contra
 * el catalogo del servicio (DTO.addOnOptions). Catalogo vacio => passthrough
 * (mismo criterio que bookingSaga._detectAddons).
 * Devuelve { addOnIds, nativeAddonIds } (nativeAddonIds alimenta
 * customerChoices.addOnIds de listAvailabilityTimeSlots).
 */
function _resolveAddonContext(service, requestedAddonIds) {
    const catalog = Array.isArray(service?.addOnOptions) ? service.addOnOptions : [];
    const catalogIds = new Set(
        catalog
            .map((a) => _safeTrim(a?.addonId || a?.addOnId || ""))
            .filter((id) => _looksLikeGuid(id))
    );
    const requested = Array.from(
        new Set(
            (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    );
    const validated = requested.filter(
        (id) => catalogIds.size === 0 || catalogIds.has(id)
    );
    if (requested.length > 0 && validated.length !== requested.length) {
        log.warn("_resolveAddonContext: addOnIds fuera de catalogo descartados", {
            requested: requested.length,
            validated: validated.length,
        });
    }
    return { addOnIds: validated, nativeAddonIds: validated };
}

/**
 * RES-10: display name de staff desde MapaStaff (keys reales: resourceId,
 * displayName). Cache RAM acotada con TTL de servicio.
 */
async function _getStaffDisplayName(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;
    const cached = staffNameRAM.get(id);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return cached.name;
    }
    let name = STAFF_DEFAULT_NAME;
    try {
        const staff = await withTimeout(
            queryFirstItem({
                dataCollectionId: MAPA_STAFF_COL,
                filter: wql.eq("resourceId", id),
            }),
            WATCHDOG_TIMEOUT_MS,
            "getStaffDisplayName"
        );
        name = _safeTrim(staff?.displayName) || STAFF_DEFAULT_NAME;
    } catch (e) {
        log.warn("_getStaffDisplayName failed", { resourceId: id, error: e?.message });
    }
    _cacheSetBounded(staffNameRAM, id, { name, timestamp: Date.now() }, CACHE_MAX_SIZE);
    return name;
}

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
}

/* RES-20: rate limiting en superficies Anyone (BIBLIA 15.2/15.3). */
function _rateLimitOrThrow(surface, key) {
    const result = rateLimiter({ surface, key });
    if (result && result.allowed) return;
    const error = new Error("RATE_LIMITED");
    error.code = "RATE_LIMITED";
    error.meta = { retryAfter: result?.retryAfter ?? null, surface };
    throw error;
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

/**
 * C11: delegacion completa en bookingUtils.
 * El criterio de aplanado del slot Wix es unico en todo el dominio.
 */
function _normalizeSlotShape(slot) {
    return _normalizeSlotShapeShared(slot);
}

/**
 * C11: delegacion completa en bookingUtils (UTILS-13 fail-closed).
 */
function _getResourceIdsFromSlot(slot) {
    return _getResourceIdsFromSlotShared(slot, STAFF_RESOURCE_TYPE_ID);
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const s = _normalizeSlotShape(slot);
    if (!s) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId });
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
    const todayStr = now.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    if (!tomorrowStr || !maxDateStr) return [];
    return daysArray.filter((date) => date >= tomorrowStr && date <= maxDateStr);
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

function _normalizeResourceIds(resourceId, traceId) {
    const result = _normalizeResourceIdsStrict(resourceId, traceId);
    return result === null ? [] : result;
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
 * SERVICE CATALOG (CMS: ServiciosCatalogo)
 * ==========================================================================*/
/**
 * C4: visited Set propagado para deteccion de ciclos en linkedPhases.
 */
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
        let service;
        if (isGuid) {
            service = await withTimeout(
                queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: wql.eq("serviceId", clean),
                    consistency: STRONG,
                }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:serviceId"
            );
        } else {
            service = await withTimeout(
                queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: wql.eq("slug", clean),
                    consistency: STRONG,
                }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:slug"
            );
            if (!service && _looksLikeGuid(clean)) {
                service = await withTimeout(
                    queryFirstItem({
                        dataCollectionId: SERVICIOS_COL,
                        filter: wql.eq("serviceId", clean),
                        consistency: STRONG,
                    }),
                    WATCHDOG_TIMEOUT_MS,
                    "getServiceBySlugOrId:guidFallback"
                );
            }
        }
        if (!service) {
            log.error("Service not found in ServiciosCatalogo", { key: clean, traceId });
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
        const mapped = await _mapServiceImport2ToUX(service, traceId, nextVisited);
        _cacheSetBounded(
            serviceCatalogRAM,
            clean,
            { data: mapped, timestamp: Date.now() },
            CACHE_MAX_SIZE
        );
        if (mapped.serviceId)
            _cacheSetBounded(
                serviceCatalogRAM,
                mapped.serviceId,
                { data: mapped, timestamp: Date.now() },
                CACHE_MAX_SIZE
            );
        if (mapped.slug)
            _cacheSetBounded(
                serviceCatalogRAM,
                mapped.slug,
                { data: mapped, timestamp: Date.now() },
                CACHE_MAX_SIZE
            );
        return { status: "SUCCESS", data: mapped, error: null };
    } catch (e) {
        log.error("Error in getServiceBySlugOrId", { error: e?.message, traceId });
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

/* RES-11: exportado. bookingSaga v5013 lo importa. */
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

/**
 * Mapping alineado con CMS ServiciosCatalogo (KEY FIELDS reales).
 *
 * RES-14: el linked F2 PUEDE estar oculto (clientHidden=true es el diseno
 *   de los 24 servicios F2). Solo se exige que exista y resuelva.
 * RES-15: availableStaff (canonico) con fallback transitorio staffDisponible.
 * RES-21: locationId normalizado (Multi Reference -> primer GUID).
 * RES-22: mainMedia tolerante a objeto Image.
 */
export async function _mapServiceImport2ToUX(service, traceId, visited = new Set()) {
    const serviceId = _safeTrim(_readImport2Field(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("ServiciosCatalogo invalid: serviceId missing or not a GUID");
    }
    const clientHidden = _readImport2Field(service, "clientHidden") === true;
    const rawAllowCombine = _readImport2Field(service, "allowCombine") === true;
    /* C9 semantico: un servicio oculto nunca es dual-reservable en publico. */
    const allowCombine = !clientHidden && rawAllowCombine;
    const linkedPhases = _safeTrim(_readImport2Field(service, "linkedPhases"));
    if (rawAllowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error(
            "ServiciosCatalogo invalid: linkedPhases missing or not a GUID for dual service"
        );
    }
    /* C4 + RES-14: verificacion de existencia del linked, CON visited Set,
     * SIN rechazo por clientHidden (F2 oculto es el diseno). */
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
        if (linkedRes.data.clientHidden !== true) {
            log.info("Linked phase service no esta oculto (verificar configuracion)", {
                serviceId,
                linkedPhases,
                traceId,
            });
        }
    }
    const phase1Duration = Number(_readImport2Field(service, "phase1Duration")) || 0;
    const exposureDuration = Number(_readImport2Field(service, "exposureDuration")) || 0;
    const phase2Duration = Number(_readImport2Field(service, "phase2Duration")) || 0;
    const storedTotalDuration = Number(_readImport2Field(service, "totalDuration")) || 0;
    const calculatedDuration = allowCombine
        ? phase1Duration + exposureDuration + phase2Duration
        : phase1Duration;
    const estimatedTotal = Math.max(storedTotalDuration, calculatedDuration, 30);
    const title = _safeTrim(_readImport2Field(service, "title")) || "Servicio";
    const price = Number(_readImport2Field(service, "price")) || 0;
    const currency = _safeTrim(_readImport2Field(service, "currency")) || "EUR";
    const slug = _safeTrim(_readImport2Field(service, "slug")) || null;
    const mainMedia = _extractMediaUrl(_readImport2Field(service, "mainMedia"));
    const location = _safeTrim(_readImport2Field(service, "location")) || null;
    /* RES-21: locationId canonico (Multi Reference -> primer GUID). */
    const locationId = _extractFirstRelationId(
        _readImport2Field(service, "locationId")
    ) || null;
    const tagLine = _safeTrim(_readImport2Field(service, "tagLine")) || null;
    const description = _safeTrim(_readImport2Field(service, "description")) || null;
    /* RES-15: availableStaff canonico; fallback transitorio staffDisponible. */
    let availableStaffRaw = _readImport2Field(service, "availableStaff");
    if (availableStaffRaw === null || availableStaffRaw === undefined) {
        availableStaffRaw = _readImport2Field(service, "staffDisponible");
        if (availableStaffRaw !== null && availableStaffRaw !== undefined) {
            log.warn("RES-15: leyendo campo legacy staffDisponible; migrar CMS a availableStaff", {
                serviceId,
                traceId,
            });
        }
    }
    const availableStaff = _readOptionalImport2ResourceIds(availableStaffRaw);
    if (availableStaff.length === 0) {
        log.warn("ServiciosCatalogo sin availableStaff resoluble", { serviceId, traceId });
    }
    const staffOptions = await Promise.all(
        availableStaff.map(async (resourceId) => {
            const displayName =
                (await _getStaffDisplayName(resourceId).catch(() => "")) ||
                STAFF_DEFAULT_NAME;
            return {
                resourceId,
                name: displayName,
                value: resourceId,
                label: displayName,
            };
        })
    );
    /* C5 + RES-15: addOnOptions canonico (addonId), fallback temporal addons. */
    const rawAddons =
        _readImport2Field(service, "addOnOptions") ??
        _readImport2Field(service, "addons");
    const addOnOptions = _parseImport2Addons(rawAddons)
        .map((addon) => _normalizeImport2Addon(addon))
        .filter(Boolean);
    return {
        /* Canonico - keys fisicas reales del CMS */
        serviceId,
        sku: _safeTrim(_readImport2Field(service, "sku")) || null,
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
        onlinePayment: _readImport2Field(service, "onlinePayment") !== false,
        inPersonPayment: _readImport2Field(service, "inPersonPayment") !== false,
        status: _safeTrim(_readImport2Field(service, "status")) || null,
        availableStaff,
        staffOptions,
        addOnOptions,
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return await _getServiceBySlugOrIdInternal(
        serviceId,
        traceId || makeTraceId("service-internal")
    );
}

/* =============================================================================
 * PUBLIC WEB METHODS (catalog) — RES-20: rate limited
 * ==========================================================================*/
export const getServiceBySlugOrId = webMethod(
    Permissions.Anyone,
    async (slugOrId) => {
        const traceId = makeTraceId("wm-svc");
        try {
            _rateLimitOrThrow("reservas", _safeTrim(slugOrId) || "anon");
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
            /* C9: servicio oculto no se expone en superficie publica. */
            if (result?.status === "SUCCESS" && result?.data?.clientHidden === true) {
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
                ? { status: "SUCCESS", data: _toPublicService(result.data), error: null }
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
            _rateLimitOrThrow("reservas", _safeTrim(serviceIdReq) || "anon");
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
            return { status: "SUCCESS", data: String(resolved), error: null };
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
 * C10 + RES-23: contrato publico minimizado (BIBLIA 0.5.8/15.1.8).
 * Nunca salen: linkedPhases (GUID del F2 oculto), clientHidden,
 * availableStaff (GUIDs internos), status, ni campos economicos internos
 * (margin/internalNotes/precioCosteBase no se mapean al DTO).
 */
export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const {
        linkedPhases,
        clientHidden,
        availableStaff,
        status,
        ...publicService
    } = service;
    return publicService;
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
    /* C7: rechazo estricto de resourceId no GUID. */
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
                locations: [{ id: LOCATION_TS_ID, locationType: LOCATION_TS_TYPE }],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: { addOnIds: normalizedNativeAddonIds },
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
                        _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate) ===
                        start &&
                        _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate) ===
                        end &&
                        slot?.bookable === true
                ) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: { id: LOCATION_TS_ID, locationType: LOCATION_TS_TYPE },
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
        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_UNAVAILABLE",
                    message: "Selected staff is no longer available for this slot.",
                },
            };
        }
        return {
            status: "SUCCESS",
            data: {
                slot: { ...normalized, localStartDate: start, localEndDate: end },
                resourceId:
                    requiredResourceId ||
                    (availableResourceIds.length === 1 ? availableResourceIds[0] : null),
                candidateResourceIds: availableResourceIds,
            },
            error: null,
        };
    } catch (error) {
        const httpStatus =
            Number(
                error?.httpStatus || error?.statusCode || error?.response?.status || 0
            ) || null;
        const wixErrorCode =
            _safeTrim(error?.code || error?.details?.applicationError?.code) ||
            "UNKNOWN";
        const requestedAddonCount = Array.isArray(nativeAddonIds)
            ? nativeAddonIds.length
            : 0;
        log.warn("Exact slot recheck failed", {
            traceId: activeTraceId,
            wixErrorCode,
            httpStatus,
            message: error?.message || String(error),
            serviceId: String(resolvedServiceId),
            localStartDate: start,
            localEndDate: end,
            locationId: LOCATION_TS_ID,
            locationType: LOCATION_TS_TYPE,
            requestedAddonCount,
            hasRequiredResource: Boolean(requiredResourceId),
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
/* PEND-09: lectura de DAYS_CACHE (mes) desde ControlOperativo. Devuelve
 * { fromYmd, toYmd, emptyDaysYmds } si existe una entrada viva que cubre el
 * rango; null en caso contrario o ante cualquier error (fail-open hacia la
 * fuente real, Slots API). */
async function _readDaysCacheMonth(resolvedServiceId, resourceIds, yearMonth, traceId) {
    try {
        const resourceKeySorted = (resourceIds || []).slice().sort().join(",");
        const daysCacheKey = `DAYSCACHE_${DAYS_CACHE_VERSION}__${String(resolvedServiceId)}__${_hashKey(resourceKeySorted)}__${yearMonth}`;
        const item = await withTimeout(
            queryFirstItem({
                dataCollectionId: CONTROL_COL,
                filter: wql.and(
                    wql.eq("controlType", CT_DAYS_CACHE),
                    wql.eq("dedupeKey", daysCacheKey),
                    wql.gt("expiresAt", new Date())
                ),
                consistency: STRONG,
            }),
            WATCHDOG_TIMEOUT_MS,
            "readDaysCacheMonth"
        );
        if (!item) return null;
        const payload = JSON.parse(item.payloadJson || "{}");
        if (!payload.fromYmd || !payload.toYmd) return null;
        return {
            fromYmd: String(payload.fromYmd),
            toYmd: String(payload.toYmd),
            emptyDaysYmds: Array.isArray(payload.emptyDaysYmds) ? payload.emptyDaysYmds : [],
        };
    } catch (e) {
        log.warn("_readDaysCacheMonth skipped", { traceId, message: e?.message });
        return null;
    }
}

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
    const cacheKey = `${String(resolvedServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0
        }`;
    if (!skipCache) {
        const cached = availabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) {
            return cached.data;
        }
        const inflight = inflightRequests.get(cacheKey);
        if (inflight) return inflight;
        /* PEND-09 resuelto: lectura de DAYS_CACHE persistida en
         * ControlOperativo (escritura real en getAvailableDays). La cache
         * por mes permite saltar la llamada a Slots API cuando el dia
         * consultado esta cubierto por el rango cacheado y no tiene
         * slots. */
        const monthHit = await _readDaysCacheMonth(resolvedServiceId, normalizedResourceIds, fromKey.slice(0, 7), traceId);
        if (monthHit) {
            const fromMs = Date.parse(`${fromKey}T00:00:00`);
            const toMs = Date.parse(`${toKey}T23:59:59`);
            const covered =
                Date.parse(`${String(monthHit.fromYmd)}T00:00:00`) <= fromMs &&
                Date.parse(`${String(monthHit.toYmd)}T23:59:59`) >= toMs;
            if (covered) {
                const emptySet = new Set(monthHit.emptyDaysYmds || []);
                const days = [];
                for (let d = new Date(fromMs); d.getTime() <= toMs;) {
                    const ymd = d.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
                    if (!emptySet.has(ymd)) days.push(ymd);
                    d = new Date(d.getTime() + 86400000);
                }
                if (days.length === 0) return [];
            }
        }
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
                locations: [{ id: LOCATION_TS_ID, locationType: LOCATION_TS_TYPE }],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
            };
            if (resourceTypes.length) payload.resourceTypes = resourceTypes;
            if (normalizedNativeAddonIds.length > 0) {
                payload.customerChoices = { addOnIds: normalizedNativeAddonIds };
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
            log.error("_listTimeSlotsV2 failed", { traceId, message: e?.message });
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
 * STAFF LOAD BALANCING (CMS: CitasF2) — RES-16/RES-17/RES-19
 * ==========================================================================*/
/**
 * C8 + RES-16 + RES-17:
 *   - dateYmd valido exigido.
 *   - bookingStatus canonico CMS: PENDING / CONFIRMED (PENDING_PAYMENT no
 *     existe en el enum persistido; la saga traduce a PENDING).
 *   - slotStart/slotEnd son Date en wix-data: se leen con _toDateSafe.
 */
async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, traceId) {
    const ymd = String(dateYMD || "").slice(0, 10);
    if (!_isValidMadridYmd(ymd)) return {};
    const ids = Array.isArray(resourceIds)
        ? resourceIds.map(String).filter(Boolean)
        : [];
    if (!ids.length) return {};
    /* C8: purga paginada completa (queryAllPages sustituye el bucle
     * hasNext/next del builder legacy). */
    let items;
    try {
        items = await withTimeout(
            queryAllPages({
                dataCollectionId: CITAS_COL,
                filter: wql.and(
                    wql.eq("dateYmd", ymd),
                    wql.hasSome("bookingStatus", ["PENDING", "CONFIRMED"]),
                    wql.hasSome("resourceId", ids)
                ),
                pageSize: 1000,
                consistency: STRONG,
            }),
            WATCHDOG_TIMEOUT_MS,
            "balance:queryCitas"
        );
    } catch (e) {
        log.warn("_getBookedMinutesByResourceForDay query aborted", {
            traceId,
            message: e?.message,
        });
        return {};
    }
    const minutes = {};
    ids.forEach((rid) => (minutes[rid] = 0));
    for (const it of items) {
        const rid = String(it?.resourceId || "").trim();
        if (!rid || minutes[rid] === undefined) continue;
        /* RES-17: Date reales de wix-data; fallback a startDate/endDate. */
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
    ).catch(() => ({}));
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

/**
 * C3: rechazo estricto de resourceId no GUID antes de buscar.
 */
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
            error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" },
        };
    }
    const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
    if (!fromLocal) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_DATES", message: "fromLocalDateTime invalid" },
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
 * RES-12: RESOLUCION DE STAFF PARA SLOT EXACTO (consumidor: bookingSaga)
 * =============================================================================
 * Contrato de entrada (bookingSaga v5013 PHASE 1):
 *   { serviceId, f1Start, f1End, f2Start, f2End, requestedResourceId,
 *     addOnIds, traceId }
 * Contrato de salida:
 *   { status:"SUCCESS", data:{ resourceId, resourceName, slotF1, slotF2,
 *     dateYMD }, error:null }
 *   slotF1/slotF2: slots Wix normalizados con serviceId inyectado y
 *   localStartDate/localEndDate canonicos (los consume
 *   bookingCore._forceStaffInPristineSlot).
 * Reglas:
 *   - Match EXACTO de F1 (start, y end si se aporta).
 *   - Dual: F2 en el mismo dia Madrid, match exacto de start (y end si se
 *     aporta), gap >= exposureDuration y <= MAX_DUAL_GAP_MINUTES, mismo
 *     staff en F1 y F2 (interseccion de candidatos).
 *   - requestedResourceId debe estar entre los candidatos; si no, error.
 *   - Sin requestedResourceId: staff con menor carga del dia.
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
                error: { code: "INVALID_SLOT_RECHECK", message: "f1Start is required." },
            };
        }
        const resolvedServiceId = await _resolveServiceIdInternal(params?.serviceId);
        if (!resolvedServiceId) {
            return {
                status: "ERROR",
                data: null,
                error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" },
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
        /* C9: el servicio padre debe ser visible. */
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
        const isDual = serviceCfg.allowCombine === true && _looksLikeGuid(linkedServiceId);
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
                error: { code: "INVALID_DATES", message: "f1Start has invalid Madrid day." },
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
        /* --- F1: match exacto --- */
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
                error: { code: "SLOT_UNAVAILABLE", message: "F1 slot could not be normalized." },
            };
        }
        let candidateResourceIds = _getResourceIdsFromSlot(slotF1);
        let slotF2 = null;
        /* --- F2: match exacto + gap + mismo staff --- */
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
            /* SAGA-25: F2 es NO_FEE y sin add-ons. */
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
                    error: { code: "F2_UNAVAILABLE", message: "F2 slot could not be normalized." },
                };
            }
            /* C6: gap minimo (exposure) y maximo, F2 despues de F1. */
            const f1EndLocal = _normalizeLocalIsoStr(slotF1.localEndDate);
            const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (!f1EndUtc || !f2StartUtc || f2StartUtc.getTime() < f1EndUtc.getTime()) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_GAP", message: "F2 must start after F1 ends." },
                };
            }
            const gapMinutes = _minutesBetweenUtcDates(f1EndUtc, f2StartUtc);
            const minimumGapMinutes = Math.max(0, Number(serviceCfg.exposureDuration || 0));
            if (gapMinutes < minimumGapMinutes || gapMinutes > MAX_DUAL_GAP_MINUTES) {
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
        /* --- Seleccion de staff --- */
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
                        message: "Selected staff is not available for this slot.",
                    },
                };
            }
        }
        const finalResourceId = requestedResourceId ||
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
 * DUAL SLOT ENGINE + CACHE (RES-18: ControlOperativo)
 * ==========================================================================*/
export async function _cleanExpiredDualSlotsInternal({
    limit = 100,
    traceId = null,
} = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const now = new Date();
    const result = await withTimeout(
        queryItems({
            dataCollectionId: CONTROL_COL,
            filter: wql.and(
                wql.eq("controlType", CT_DUAL_CACHE),
                wql.lt("expiresAt", now)
            ),
            limit: safeLimit,
            consistency: STRONG,
        }),
        WATCHDOG_TIMEOUT_MS,
        "cleanExpiredDualSlotsQuery"
    );
    let removed = 0;
    for (const item of result?.items || []) {
        await withTimeout(
            removeItemIfPresent(CONTROL_COL, item._id),
            WATCHDOG_TIMEOUT_MS,
            "cleanExpiredDualSlotsRemove"
        ).catch(() => null);
        removed += 1;
    }
    log.info("Expired dual cache entries cleaned", { removed, traceId });
    return { status: "SUCCESS", data: { removed }, error: null };
}

/**
 * C1: contrato publico solo slotF1/slotF2.
 * C6: rango dual validado (F2 empieza despues de F1).
 * C9: servicio padre oculto rechazado.
 * RES-18: la cache dual persiste en ControlOperativo (DUAL_CACHE).
 */
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
            error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" },
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
    /* C9: rechazo de servicios ocultos (padre). */
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
    const isDual = service.allowCombine === true && _looksLikeGuid(linkedServiceId);
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
    /* --- Servicio simple --- */
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
    /* --- Servicio dual --- */
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
            /* C6: F2 debe empezar despues de F1. */
            if (s2StartUtc.getTime() < s1EndUtc.getTime()) {
                continue;
            }
            const gapMinutes = _minutesBetweenUtcDates(s1EndUtc, s2StartUtc);
            const minimumGapMinutes = Math.max(0, exposureMinutes);
            if (gapMinutes < minimumGapMinutes || gapMinutes > MAX_DUAL_GAP_MINUTES) {
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
        /* C6: validacion final del rango dual. */
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
    /* RES-18: cache dual en ControlOperativo (payload compacto, sin slotRef). */
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
                payloadJson: JSON.stringify({
                    pairToken: slotPair.pairToken,
                    linkedPhases: String(linkedServiceId),
                    f1Start: slotPair.slotF1.localStartDate,
                    f1End: slotPair.slotF1.localEndDate,
                    f2Start: slotPair.slotF2 ? slotPair.slotF2.localStartDate : null,
                    f2End: slotPair.slotF2 ? slotPair.slotF2.localEndDate : null,
                    candidateResourceIds: slotPair.candidateResourceIds || [],
                }),
                traceId,
            };
            return saveItem(CONTROL_COL, record).catch(() => null);
        });
        await Promise.allSettled(cachePromises);
    }
    return { status: "SUCCESS", data: pairs, error: null };
}

/* =============================================================================
 * CACHE INVALIDATION (RES-18)
 * ==========================================================================*/
/**
 * C2: paginacion con hasNext/next para no dejar registros sin eliminar.
 */
async function _removeDualCacheForDay(serviceId, dateYmd, resourceId, traceId) {
    const ids = _normalizeResourceIdsStrict(resourceId, traceId);
    if (ids === null) return 0;
    const clauses = [
        wql.eq("controlType", CT_DUAL_CACHE),
        wql.eq("serviceId", String(serviceId)),
        wql.eq("dateYmd", String(dateYmd)),
    ];
    if (ids.length === 1) clauses.push(wql.eq("resourceId", ids[0]));
    /* C2: purga completa paginada. queryAllPages acota por tamano de pagina
     * y borra hasta agotar la consulta (equivalente funcional al bucle
     * hasNext/next del builder legacy). */
    const stale = await withTimeout(
        queryAllPages({
            dataCollectionId: CONTROL_COL,
            filter: wql.and(...clauses),
            pageSize: 1000,
            consistency: STRONG,
        }),
        WATCHDOG_TIMEOUT_MS,
        "invalidateDualCacheQuery"
    );
    await Promise.allSettled(
        stale.map((item) =>
            removeItemIfPresent(CONTROL_COL, item._id).catch(() => null)
        )
    );
    return stale.length;
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
    /* RES-18: DAYS_CACHE en ControlOperativo (best-effort; hoy la cache de
     * dias es solo RAM, esta purga cubre escrituras futuras del job). */
    const yearMonth = String(ymd).slice(0, 7);
    const resourceIds = _normalizeResourceIds(resourceId, tId).sort().join(",");
    const daysCacheKey = `DAYSCACHE_${DAYS_CACHE_VERSION}__${String(resolvedServiceId)
        }__${_hashKey(resourceIds)}__${String(yearMonth)}`;
    try {
        const daysItems = await withTimeout(
            queryItems({
                dataCollectionId: CONTROL_COL,
                filter: wql.and(
                    wql.eq("controlType", CT_DAYS_CACHE),
                    wql.eq("dedupeKey", daysCacheKey)
                ),
                limit: 10,
                consistency: STRONG,
            }),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDaysCache"
        );
        await Promise.allSettled(
            (daysItems?.items || []).map((item) =>
                removeItemIfPresent(CONTROL_COL, item._id).catch(() => null)
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
        log.info("Dual cache invalidated", { traceId: tId, removed });
    } catch (e) {
        log.warn(
            "_invalidateCachesInternal: dual cache cleanup failed (best-effort)",
            { traceId: tId, message: e?.message }
        );
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
 * PUBLIC AVAILABILITY METHODS — RES-20: rate limited
 * ==========================================================================*/
export const getAvailableDays = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, year, month, addonIds = []) => {
        const traceId = makeTraceId("wm-days");
        try {
            _rateLimitOrThrow("availability", _safeTrim(resourceId) || "anon");
            const resolved = await _resolveServiceIdInternal(serviceId);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" },
                };
            }
            const resourceIds = _normalizeResourceIdsStrict(resourceId, traceId);
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
            const svcRes = await _getServiceBySlugOrIdInternal(resolved, traceId);
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
            /* C9: servicio oculto no participa en disponibilidad publica. */
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
            const slots = await _listTimeSlotsV2(
                {
                    serviceId: resolved,
                    fromLocalDate: `${fromLocal}T00:00:00`,
                    toLocalDate: `${toLocal}T23:59:59`,
                    resourceIds,
                    nativeAddonIds: addonContext.nativeAddonIds,
                },
                { skipCache: false, timeSlotsPerDay: 1 }
            );
            const dateSet = new Set();
            slots.forEach((s) => {
                if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
            });
            /* PEND-09: escritura REAL de DAYS_CACHE en ControlOperativo.
             * Se persiste el mes consultado con los dias SIN slots
             * (emptyDaysYmds) y su TTL; _listTimeSlotsV2 puede resolver
             * consultas cubiertas sin llamar a Slots API y crons.js
             * cleanExpiredDaysCache purga los expirados. */
            try {
                const allDays = [];
                for (let d = _addDaysYMD(fromLocal, 0); d <= toLocal; d = _addDaysYMD(d, 1)) {
                    allDays.push(d);
                }
                const emptyDaysYmds = allDays.filter((d) => !dateSet.has(d));
                const resourceKeySorted = (resourceIds || []).slice().sort().join(",");
                const daysCacheKey = `DAYSCACHE_${DAYS_CACHE_VERSION}__${String(resolved)}__${_hashKey(resourceKeySorted)}__${yearMonth}`;
                const record = {
                    dedupeKey: daysCacheKey,
                    controlType: CT_DAYS_CACHE,
                    serviceId: String(resolved),
                    resourceId: resourceKeySorted,
                    dateYmd: yearMonth,
                    expiresAt: new Date(Date.now() + SLOTS_CACHE_TTL_MS * 5),
                    payloadJson: JSON.stringify({
                        fromYmd: fromLocal,
                        toYmd: toLocal,
                        emptyDaysYmds,
                    }),
                    traceId,
                };
                await saveItem(CONTROL_COL, record).catch(() => null);
            } catch (e) {
                log.warn("getAvailableDays: days cache write skipped", {
                    traceId,
                    message: e?.message,
                });
            }
            return {
                status: "SUCCESS",
                data: _filterDaysByLimit(Array.from(dateSet).sort()),
                error: null,
            };
        } catch (err) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(err, "DAYS_QUERY_FAILED"),
            };
        }
    }
);

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, dateYMD, addonIds = []) => {
        try {
            _rateLimitOrThrow("availability", _safeTrim(resourceId) || "anon");
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

/**
 * RES-13: getAvailableSlots (consumidor: pagina Calendario de reservas 2,
 * rama de servicios simples). Delega en _getCertifiedDualSlotsInternal, que
 * para servicios no combinables devuelve entradas { slotF1, slotF2: null }.
 * Una sola implementacion del motor de slots (BIBLIA 0.5.1).
 */
export const getAvailableSlots = webMethod(
    Permissions.Anyone,
    async (serviceId, resourceId, dateYMD, addonIds = []) => {
        try {
            _rateLimitOrThrow("availability", _safeTrim(resourceId) || "anon");
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

/**
 * RES-12: envoltorio publico de _resolveStaffForSlotInternal. Mantiene la
 * firma posicional historica (serviceId, start1, rId, addonIds, dualContext).
 */
export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceId, start1, rId, addonIds = [], dualContext = null) => {
        const traceId = makeTraceId("wm-staff");
        try {
            _rateLimitOrThrow("availability", _safeTrim(rId) || "anon");
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
 * FASE5 DTO-WHITELIST — getConfirmedBookingForDisplay
 * Lectura publica del estado de una reserva para la pagina de confirmacion.
 * Contrato dto.whitelist.test.mjs (DTO-01..05): envelope { ok, data, error },
 * proyeccion con lista blanca explicita (nunca expand del registro CMS) y
 * rechazo sin llamada a CMS cuando falta bookingId. Campos vetados por el
 * contrato publico: margin, internalNotes, tipoImpositivo, codigoImpuesto,
 * payloadFiscal, nifEmisor, previousRecordHash, cuentaContable*.
 * ==========================================================================*/
const DISPLAYABLE_BOOKING_STATUSES = new Set([
    CITAS_BOOKING_STATUS.PENDING,
    CITAS_BOOKING_STATUS.CONFIRMED,
    CITAS_BOOKING_STATUS.COMPLETED,
]);

export const getConfirmedBookingForDisplay = webMethod(
    Permissions.Anyone,
    async ({ bookingId } = {}) => {
        const traceId = makeTraceId("wm-booking-display");
        const cleanId = _safeTrim(bookingId);
        // DTO-05: validacion previa, sin tocar CMS.
        if (!cleanId) {
            return { ok: false, data: null, error: "INVALID_PAYLOAD" };
        }
        try {
            const res = await queryItems({
                dataCollectionId: CITAS_COL,
                filter: wql.eq("bookingId", cleanId),
                limit: 5,
            });
            const items = res?.items || [];
            if (items.length === 0) {
                return { ok: false, data: null, error: "NOT_FOUND" };
            }
            const cita = items[0];
            // DTO-02: normalizacion canonica — los registros legacy pueden
            // traer el estado en "status"; el fisico vigente es "bookingStatus".
            const rawStatus = _safeTrim(cita.bookingStatus || cita.status).toUpperCase();
            // Traduciona variantes legacy ortograficas (una L) al enum CMS.
            const status = rawStatus === "CANCELED" ? CITAS_BOOKING_STATUS.CANCELLED : rawStatus;
            // DTO-03: CANCELLED/NO_SHOW/estados no exhibibles se ocultan.
            if (!DISPLAYABLE_BOOKING_STATUSES.has(status)) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }
            // Lista blanca explicita: nada de lo demas cruza la frontera.
            const data = {
                bookingId: cita.bookingId || null,
                bookingStatus: status,
                paymentStatus: _safeTrim(cita.paymentStatus).toUpperCase() || null,
                pairToken: cita.pairToken || null,
                serviceId: cita.serviceId || null,
                dateYmd: cita.dateYmd || null,
                slotStart: _toDateSafe(cita.slotStart) ? _normalizeLocalIsoStr(_toDateSafe(cita.slotStart)) : (cita.slotStart || null),
                slotEnd: _toDateSafe(cita.slotEnd) ? _normalizeLocalIsoStr(_toDateSafe(cita.slotEnd)) : (cita.slotEnd || null),
                resourceId: cita.resourceId || null,
                totalPrice: Number.isFinite(Number(cita.totalPrice)) ? Number(cita.totalPrice) : null,
            };
            return { ok: true, data, error: null };
        } catch (err) {
            logger.error("getConfirmedBookingForDisplay failed", {
                traceId,
                bookingId: cleanId,
                error: err?.message,
            });
            return { ok: false, data: null, error: "BOOKING_LOOKUP_FAILED" };
        }
    }
);
