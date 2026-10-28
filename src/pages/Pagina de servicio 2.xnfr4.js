/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5028-SDK-ASYNC-FIX
 * APIS: @wix/site-location; @wix/site-pricing-plans; backend/reservas.web.js;
 *       public/mmUtils; public/widgetBridge.
 * DOC: https://dev.wix.com/docs/sdk/frontend-modules/location/introduction
 *      https://dev.wix.com/docs/sdk/frontend-modules/pricing-plans/checkout/setup
 */
import { location } from "@wix/site-location";
import { window } from "@wix/site-window";
import { checkout } from "@wix/site-pricing-plans";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES, URLS, BOOKINGS_ADDON_CONFIG, makeTraceId,
    _safeTrim, _safeSlugOrId, _safePathSlugOrId, _looksLikeGuid, toFiniteNumber,
    _getMessageType, _getPayload
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set(["servicios", "service", "service-page", "servicio", "servicio-2"]);
const MAX_ADDONS_PER_BOOKING = Number(BOOKINGS_ADDON_CONFIG && BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA) || 5;

let bridge = null;
let resolvedService = null;

/* ---------------- Helpers de error (agrupados) ---------------- */
function isOriginError(code) {
    return [
        "WIDGET_ORIGIN_OPAQUE_REJECTED",
        "WIDGET_ORIGIN_REJECTED",
        "ORIGIN_OPAQUE_REJECTED",
        "ORIGIN_REJECTED"
    ].includes(code);
}

function bridgeError(code, message, traceId, detail = null) {
    console.error("[servicio-2] Error del bridge", { traceId, code, message, detail });

    // El detalle del bridge llega directamente en `detail`; el mensaje
    // original del Error ya viene en `message`. Se usa `message` tal cual
    // (sin intentar leer detail.cause.message, que el bridge v5015 no rellena).
    const userMessage = isOriginError(code)
        ? "No se pudo conectar el componente de reserva. Recarga la página."
        : message || "No se pudo cargar el servicio.";

    showError(userMessage);
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

// ALINEADO con refId() del HTML (widgetBridge cliente):
// acepta addonId, _id, id, referenceId y value, y también cadenas/números
// directos. Así, el conjunto de IDs permitidos coincide exactamente con el
// `addonId` normalizado que el HTML envía de vuelta en `addOnIds`, aunque
// el CMS/backend proyecte el complemento con otro nombre de clave.
function getAddonId(item) {
    if (typeof item === "string" || typeof item === "number") {
        return _safeTrim(item);
    }
    if (item && typeof item === "object") {
        return _safeTrim(
            item.addonId || item._id || item.id || item.referenceId || item.value
        );
    }
    return "";
}

function normalizeCatalogEntry(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("La entrada de catálogo recibida no es válida.");
    }
    const catalogEntryType = text(data.catalogEntryType, "SERVICE").toUpperCase();
    const slug = getServiceSlug(data);
    if (!slug) throw new Error("La entrada de catálogo no tiene un slug válido.");
    if (!["SERVICE", "PRICING_PLAN"].includes(catalogEntryType)) {
        throw new Error("Tipo de catálogo no compatible.");
    }

    const common = {
        catalogEntryType,
        slug,
        title: text(data.title, "Servicio"),
        description: text(data.description),
        tagLine: text(data.tagLine),
        location: text(data.location),
        price: Math.max(0, toFiniteNumber(data.price)),
        currency: /^[A-Z]{3}$/.test(text(data.currency, "EUR").toUpperCase())
            ? text(data.currency, "EUR").toUpperCase()
            : "EUR",
        mainMedia: data.mainMedia || "",
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        clientHidden: data.clientHidden === true,
    };

    if (catalogEntryType === "PRICING_PLAN") {
        const pricingPlanId = _safeTrim(data.pricingPlanId);
        const sessionCount = Number(data.sessionCount);
        if (!_looksLikeGuid(pricingPlanId)) {
            throw new Error("El plan no tiene un identificador de Pricing Plans válido.");
        }
        if (!Number.isSafeInteger(sessionCount) || sessionCount < 1) {
            throw new Error("El plan debe incluir un número válido de sesiones.");
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
            primaryActionLabel: text(data.primaryActionLabel, "Comprar bono"),
        };
    }

    const serviceId = getServiceId(data);
    if (!_looksLikeGuid(serviceId)) throw new Error("El servicio no tiene un identificador válido.");
    return {
        ...common,
        serviceId,
        pricingPlanId: "",
        sessionCount: 0,
        totalDuration: Math.max(0, toFiniteNumber(data.totalDuration)),
        addOnOptions: Array.isArray(data.addOnOptions) ? data.addOnOptions : [],
        allowCombine: data.allowCombine === true,
        phase1Duration: Math.max(0, toFiniteNumber(data.phase1Duration)),
        exposureDuration: Math.max(0, toFiniteNumber(data.exposureDuration)),
        phase2Duration: Math.max(0, toFiniteNumber(data.phase2Duration)),
        linkedPhases: _safeTrim(data.linkedPhases) || "",
        primaryActionLabel: text(data.primaryActionLabel, "Reservar cita"),
    };
}

function normalizeCatalogLookup(value) {
    let raw = _safeTrim(value, 200);
    if (!raw) return "";

    try {
        raw = decodeURIComponent(raw);
    } catch (_) {
        return "";
    }

    raw = raw.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "").normalize("NFC");
    if (!raw || /[\/\\\u0000-\u001F]/.test(raw)) return "";
    if (_looksLikeGuid(raw)) return raw.toLowerCase();
    if (!/^[\p{L}\p{N}]+(?:[._:-]?[\p{L}\p{N}]+)*$/u.test(raw)) return "";
    return raw.toLocaleLowerCase("es-ES");
}

async function resolveServiceLookupCandidates() {
    const [queryResult, pathResult] = await Promise.all([
        location.query(),
        location.path(),
    ]);
    const query = queryResult && typeof queryResult === "object" ? queryResult : {};
    const path = Array.isArray(pathResult) ? pathResult : [];
    const candidates = [];
    const seen = new Set();

    const add = (value, source) => {
        const normalized = normalizeCatalogLookup(value);
        if (!normalized || EXCLUDED_PATHS.has(normalized.toLowerCase())) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ value: normalized, source });
    };

    add(query.slug, "query.slug");

    const servicePageIndex = path.findIndex(
        (segment) => String(segment || "").toLowerCase() === "service-page",
    );
    if (servicePageIndex >= 0) {
        add(path[servicePageIndex + 1], "route.service-page");
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
        add(path[index], "route.last-segment");
    }

    add(query.serviceId, "query.serviceId");
    return candidates;
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
    if (service.catalogEntryType !== "SERVICE" || !_looksLikeGuid(getServiceId(service))) {
        throw new Error("Solo los servicios reservables pueden abrir el calendario de citas.");
    }
    // URL de protocolo: optional chaining por si URLS no expone CALENDARIO_2
    // en algún entorno; fallback literal idéntico al de PROTOCOL_URLS.
    const base = text(URLS?.CALENDARIO_2, "/booking-calendar/calendario-2");
    const query = new URLSearchParams();
    query.set("slug", getServiceSlug(service));
    query.set("serviceId", getServiceId(service));
    query.set("referral", "servicio-2");

    const addOnIds = getAddOnIds(payload, service);
    if (addOnIds.length > 0) query.set("addOnIds", addOnIds.join(","));

    return `${base}?${query.toString()}`;
}
function getServicesUrl() {
    return text(URLS?.SERVICIOS, "/reserva-online");
}

async function loadService(lookupValue, traceId) {
    try {
        const result = await getServiceBySlugOrId(lookupValue);
        if (
            !result ||
            result.status !== "SUCCESS" ||
            !result.data ||
            typeof result.data !== "object" ||
            Array.isArray(result.data)
        ) {
            throw serviceLookupError(result);
        }

        const service = normalizeCatalogEntry(result.data);
        console.info("[servicio-2] Servicio cargado", {
            traceId,
            lookupValue,
            catalogEntryType: service.catalogEntryType,
            serviceId: service.serviceId || null,
            pricingPlanId: service.pricingPlanId || null,
            slug: service.slug,
        });
        return service;
    } catch (error) {
        console.error("[servicio-2] Error cargando servicio", {
            traceId,
            lookupValue,
            code: error?.code || "SERVICE_LOAD_FAILED",
            message: error?.message || String(error),
        });
        throw error;
    }
}

async function loadServiceFromCandidates(candidates, traceId) {
    let lastError = null;
    for (const candidate of candidates) {
        try {
            return await loadServiceWithRetry(candidate.value, traceId);
        } catch (error) {
            lastError = error;
            if (String(error?.code || "").toUpperCase() !== "SERVICE_NOT_FOUND") throw error;
            console.warn("[servicio-2] Candidato no encontrado; probando siguiente", {
                traceId,
                source: candidate.source,
                candidateType: _looksLikeGuid(candidate.value) ? "WIX_SERVICE_GUID" : "URL_SLUG",
            });
        }
    }
    throw lastError || Object.assign(new Error("SERVICE_LOOKUP_FAILED"), { code: "SERVICE_LOOKUP_FAILED" });
}

async function loadServiceWithRetry(lookupValue, traceId) {
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await withLocalTimeout(
                () => loadService(lookupValue, traceId),
                35000,
                "SERVICE_LOOKUP_TIMEOUT",
            );
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
                traceId,
                attempt,
                nextAttempt: attempt + 1,
                delayMs,
                code: code || null,
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError || Object.assign(new Error("SERVICE_LOOKUP_FAILED"), { code: "SERVICE_LOOKUP_FAILED" });
}

function withLocalTimeout(promiseFactory, timeoutMs, code) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(code);
            error.code = code;
            reject(error);
        }, timeoutMs);
    });

    return Promise.race([
        Promise.resolve().then(promiseFactory),
        timeout,
    ]).finally(() => {
        if (timer !== null) clearTimeout(timer);
    });
}

$w.onReady(async () => {
    const traceId = makeTraceId("servicio");
    let widget;
    try { widget = $w("#htmlWidgetCustomService"); } catch (_) { showError("El widget del servicio no esta disponible."); return; }
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        showError("El widget del servicio no esta disponible."); return;
    }

    let lookupCandidates = [];
    let resolveLookupReady;
    const lookupReady = new Promise((resolve) => {
        resolveLookupReady = resolve;
    });

    try {
        // Registrar el bridge antes de leer la URL para que el handshake no
        // dependa de la latencia de site-location.
        bridge = createWidgetBridge(widget, {
            traceId,
            onContextReady: async () => {
                await lookupReady;
                if (resolvedService) return resolvedService;

                let lastError = null;
                if (lookupCandidates.length) {
                    try {
                        resolvedService = await loadServiceFromCandidates(lookupCandidates, traceId);
                        return resolvedService;
                    } catch (error) {
                        lastError = error;
                    }
                }

                if (!lastError || String(lastError?.code || "").toUpperCase() === "SERVICE_NOT_FOUND") {
                    try {
                        const appPageData = await withLocalTimeout(
                            () => window.getAppPageData(),
                            8000,
                            "APP_PAGE_DATA_TIMEOUT",
                        );
                        const nativeService = appPageData?.service;
                        const nativeServiceId = normalizeCatalogLookup(
                            nativeService?.id || nativeService?.serviceId || "",
                        );
                        const alreadyTried = lookupCandidates.some(
                            (candidate) => candidate.value.toLowerCase() === nativeServiceId.toLowerCase(),
                        );
                        if (nativeServiceId && _looksLikeGuid(nativeServiceId) && !alreadyTried) {
                            try {
                                resolvedService = await loadServiceWithRetry(nativeServiceId, traceId);
                                return resolvedService;
                            } catch (fallbackError) {
                                lastError = fallbackError;
                                if (fallbackError?.code !== "SERVICE_NOT_FOUND") throw fallbackError;
                            }
                        }
                    } catch (fallbackError) {
                        console.warn("[servicio-2] getAppPageData fallback no disponible", {
                            traceId,
                            code: fallbackError?.code || "APP_PAGE_DATA_FAILED",
                            message: fallbackError?.message || String(fallbackError),
                        });
                        if (fallbackError?.code && fallbackError.code !== "APP_PAGE_DATA_TIMEOUT") throw fallbackError;
                    }
                }

                const finalError = lastError || Object.assign(
                    new Error("No se pudo localizar el servicio en la URL ni en los datos de Wix."),
                    { code: "SERVICE_LOOKUP_MISSING" },
                );
                showError(finalError.message || "No se pudo cargar el servicio.");
                throw finalError;
            },
            onWidgetMessage: async (message, reply) => {
                const type = _getMessageType(message);
                if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) return;
                const payload = _getPayload(message);
                if (!resolvedService) {
                    if (type === MESSAGE_TYPES.BOOK) {
                        reply(MESSAGE_TYPES.BOOK, {
                            status: "ERROR",
                            error: {
                                code: "SERVICE_NOT_READY",
                                message: "El servicio aun se esta cargando."
                            }
                        });
                    }
                    return;
                }
                if (type === MESSAGE_TYPES.BOOK) {
                    if (resolvedService.catalogEntryType === "PRICING_PLAN") {
                        try {
                            const purchase = await checkout.startOnlinePurchase(resolvedService.pricingPlanId);
                            console.info("[servicio-2] Compra de plan completada", {
                                traceId,
                                pricingPlanId: resolvedService.pricingPlanId,
                                orderId: text(purchase?.order?._id || purchase?._id),
                            });
                            reply(MESSAGE_TYPES.BOOK, {
                                status: "SUCCESS",
                                data: {
                                    catalogEntryType: "PRICING_PLAN",
                                    title: resolvedService.title,
                                    sessionCount: resolvedService.sessionCount,
                                },
                            });
                        } catch (error) {
                            console.warn("[servicio-2] No se pudo completar la compra del plan", {
                                traceId,
                                pricingPlanId: resolvedService.pricingPlanId,
                                code: text(error?.code, "PRICING_PLAN_PURCHASE_FAILED"),
                            });
                            reply(MESSAGE_TYPES.BOOK, {
                                status: "ERROR",
                                error: {
                                    code: "PRICING_PLAN_PURCHASE_FAILED",
                                    message: "No se ha podido completar la compra. Inténtalo de nuevo.",
                                },
                            });
                            showError("No se ha podido completar la compra del bono. Inténtalo de nuevo.");
                        }
                        return;
                    }
                    try {
                        location.to(buildBookingUrl(resolvedService, payload));
                    } catch (error) {
                        console.error("[servicio-2] Error al abrir calendario", {
                            traceId,
                            code: error?.code,
                            message: error?.message
                        });
                        reply(MESSAGE_TYPES.BOOK, {
                            status: "ERROR",
                            error: {
                                code: "BOOKING_URL_FAILED",
                                message: "No se pudo abrir el calendario. Inténtalo de nuevo."
                            }
                        });
                    }
                    return;
                }
                if (type === MESSAGE_TYPES.NAV) {
                    const target = text(payload.target).toUpperCase();
                    if (!target || target === "SERVICIOS") location.to(getServicesUrl());
                }
            },
            onError: (error, detail) => bridgeError(error && error.code, error && error.message, traceId, detail)
        });
        if (!bridge) showError("No se pudo inicializar el widget del servicio.");
    } catch (error) {
        console.error("[servicio-2] Error de inicializacion", { traceId, code: error && error.code, message: error && error.message });
        showError((error && error.message) || "No se pudo cargar el servicio.");
    }

    lookupCandidates = resolveServiceLookupCandidates();
    try {
        lookupCandidates = await lookupCandidates;
    } catch (error) {
        console.error("[servicio-2] No se pudieron resolver candidatos de URL", {
            traceId,
            code: error?.code || "SERVICE_LOCATION_READ_FAILED",
            message: error?.message || String(error),
        });
        lookupCandidates = [];
    }
    console.info("[servicio-2] Candidatos de búsqueda de ServiciosCatalogo", {
        traceId,
        candidates: lookupCandidates.map(({ value, source }) => ({ value, source })),
    });
    resolveLookupReady();
});
