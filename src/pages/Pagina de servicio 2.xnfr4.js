/*
=============================================================================
FILE: pages/servicio-2.js
VERSION: v5013.11-CMS-SSOT-ALIGNED
PURPOSE: Load ServiciosCatalogo and provide aligned widget context.
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
  return _safeTrim(value) || (
    fallback != null ? fallback : ""
  );
}

function getReferenceId(value) {
  if (typeof value === "string") {
    return text(value);
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  return text(
    value.serviceId ||
    value.addonId ||
    value._id ||
    value.id ||
    value.value
  );
}

function getMessageType(message) {
  return message && typeof message === "object"
    ? text(message.type).toUpperCase()
    : "";
}

function getPayload(message) {
  var payload = message && message.payload;

  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
    ? payload
    : {};
}

function getServiceId(service) {
  return getReferenceId(
    service && service.serviceId
  );
}

function getServiceSlug(service) {
  return _safeSlugOrId(
    service && service.slug
      ? service.slug
      : ""
  );
}

function getLinkedPhaseId(value) {
  return getReferenceId(
    Array.isArray(value) ? value[0] : value
  );
}

function toFiniteNumber(value, fallback) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback != null ? fallback : 0;
  }

  var parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : (fallback != null ? fallback : 0);
}

function normalizeCurrency(value) {
  var currency = text(value, "EUR").toUpperCase();

  return /^[A-Z]{3}$/.test(currency)
    ? currency
    : "EUR";
}

function normalizeService(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw new Error(
      "El servicio recibido no es valido."
    );
  }

  var metadata = (
    data.metadata &&
    typeof data.metadata === "object"
  )
    ? data.metadata
    : {};

  var serviceId = getServiceId(data);
  var slug = getServiceSlug(data);

  if (!_looksLikeGuid(serviceId)) {
    throw new Error(
      "El servicio no tiene un serviceId valido."
    );
  }

  if (!slug) {
    throw new Error(
      "El servicio no tiene un slug valido."
    );
  }

  var addOnOptions = Array.isArray(
    data.addOnOptions
  )
    ? data.addOnOptions
    : Array.isArray(
      metadata.addOnOptions
    )
      ? metadata.addOnOptions
      : [];

  var recommendations = Array.isArray(
    data.recomendaciones
  )
    ? data.recomendaciones
    : Array.isArray(
      data.recommendations
    )
      ? data.recommendations
      : Array.isArray(
        metadata.recomendaciones
      )
        ? metadata.recomendaciones
        : [];

  return {
    serviceId: serviceId,
    slug: slug,

    title: text(
      data.title ||
      metadata.titulo ||
      metadata.tituloServicio,
      "Servicio"
    ),

    tagLine: text(
      data.tagLine ||
      metadata.resumenCorto
    ),

    description: text(
      data.description ||
      metadata.descripcionLarga
    ),

    location: text(
      data.location ||
      data.localizacion ||
      metadata.localizacion
    ),

    mainMedia:
      data.mainMedia ||
      metadata.mainMedia ||
      "",

    price: Math.max(
      0,
      toFiniteNumber(
        data.price != null
          ? data.price
          : metadata.precio
      )
    ),

    currency: normalizeCurrency(
      data.currency ||
      metadata.currency
    ),

    totalDuration: Math.max(
      0,
      toFiniteNumber(
        data.totalDuration != null
          ? data.totalDuration
          : data.totalDuracion != null
            ? data.totalDuracion
            : data.duracionTotal != null
              ? data.duracionTotal
              : metadata.totalDuration
      )
    ),

    phase1Duration: Math.max(
      0,
      toFiniteNumber(
        data.phase1Duration != null
          ? data.phase1Duration
          : data.fase1Duracion
      )
    ),

    phase2Duration: Math.max(
      0,
      toFiniteNumber(
        data.phase2Duration != null
          ? data.phase2Duration
          : data.fase2Duracion
      )
    ),

    exposureDuration: Math.max(
      0,
      toFiniteNumber(
        data.exposureDuration != null
          ? data.exposureDuration
          : data.exposicionDuracion
      )
    ),

    linkedPhases: getLinkedPhaseId(
      data.linkedPhases
    ),

    allowCombine:
      data.allowCombine === true,

    clientHidden:
      data.clientHidden === true,

    onlinePayment:
      data.onlinePayment === true,

    inPersonPayment:
      data.inPersonPayment === true,

    addOnOptions: addOnOptions,
    recommendations: recommendations
  };
}

function normalizeLookupValue(value) {
  var raw = text(value)
    .replace(/^\/+|\/+$/g, "")
    .trim();

  if (!raw) {
    return "";
  }

  try {
    raw = decodeURIComponent(raw);
  } catch (_) {
    // Keep the original value.
  }

  return _safeSlugOrId(raw);
}

function resolveServiceLookup() {
  var query = wixLocation.query || {};

  var candidates = [
    query.slug,
    query.serviceId,
    query.service
  ];

  for (var i = 0; i < candidates.length; i++) {
    var value = normalizeLookupValue(
      candidates[i]
    );

    if (value) {
      return value;
    }
  }

  var path = Array.isArray(wixLocation.path)
    ? wixLocation.path
    : [];

  for (var p = 0; p < path.length; p++) {
    if (
      normalizeLookupValue(path[p])
        .toLowerCase() === "service-page" &&
      p + 1 < path.length
    ) {
      return normalizeLookupValue(
        path[p + 1]
      );
    }
  }

  var lastPart = normalizeLookupValue(
    path[path.length - 1]
  );

  return lastPart &&
    !EXCLUDED_PATHS.has(lastPart.toLowerCase())
    ? lastPart
    : null;
}

function getAllowedAddOnIds(service) {
  var options = service &&
    Array.isArray(service.addOnOptions)
    ? service.addOnOptions
    : [];

  var result = new Set();

  options.forEach(function (item) {
    var id = getReferenceId(item);

    if (id) {
      result.add(id);
    }
  });

  return result;
}

function getAddOnIds(payload, service) {
  if (!Array.isArray(payload.addOnIds)) {
    return [];
  }

  var allowed = getAllowedAddOnIds(service);
  var seen = new Set();
  var result = [];

  payload.addOnIds.forEach(function (value) {
    var id = getReferenceId(value);

    if (
      id &&
      allowed.has(id) &&
      !seen.has(id)
    ) {
      seen.add(id);
      result.push(id);
    }
  });

  return result.slice(
    0,
    MAX_ADDONS_PER_BOOKING
  );
}

function buildBookingUrl(service, payload) {
  var base = text(
    URLS && URLS.CALENDARIO_2,
    "/booking-calendar/calendario-2"
  );

  var params = new URLSearchParams();

  params.set(
    "serviceId",
    getServiceId(service)
  );

  params.set(
    "slug",
    getServiceSlug(service)
  );

  params.set(
    "referral",
    "servicio-2"
  );

  if (service.allowCombine === true) {
    params.set("allowCombine", "true");
    params.set(
      "phase1Duration",
      String(service.phase1Duration)
    );
    params.set(
      "exposureDuration",
      String(service.exposureDuration)
    );
    params.set(
      "phase2Duration",
      String(service.phase2Duration)
    );

    if (service.linkedPhases) {
      params.set(
        "linkedPhases",
        service.linkedPhases
      );
    }
  }

  var addOnIds = getAddOnIds(
    payload,
    service
  );

  if (addOnIds.length) {
    params.set(
      "addOnIds",
      addOnIds.join(",")
    );
  }

  return base + "?" + params.toString();
}

function getServicesUrl() {
  return text(
    URLS && URLS.SERVICIOS,
    "/reserva-online"
  );
}

function createError(code, message) {
  return {
    status: "ERROR",
    data: null,
    error: {
      code: text(code, "SERVICE_ERROR"),
      message: text(
        message,
        "No se pudo cargar el servicio."
      )
    }
  };
}

function showError(message, code) {
  var errorPayload = createError(
    code,
    message
  );

  console.error(
    "[servicio-2]",
    errorPayload.error.code,
    errorPayload.error.message
  );

  if (!bridge) {
    return;
  }

  try {
    bridge.send(
      MESSAGE_TYPES.CONTEXT,
      errorPayload
    );
  } catch (error) {
    console.warn(
      "[servicio-2] Error al notificar al widget:",
      error && error.message
    );
  }
}

function isRetryableError(error) {
  var code = text(
    error && (
      error.code ||
      (
        error.error &&
        error.error.code
      )
    )
  ).toUpperCase();

  if (
    code &&
    RETRYABLE_CODES.has(code)
  ) {
    return true;
  }

  var message = String(
    error && error.message || ""
  ).toLowerCase();

  return (
    message.indexOf("timeout") >= 0 ||
    message.indexOf("network") >= 0 ||
    message.indexOf("connection") >= 0 ||
    message.indexOf("fetch failed") >= 0
  );
}

function sleep(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

async function loadServiceWithRetry(
  lookupValue,
  traceId
) {
  var lastError = null;

  for (
    var attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      var result = await getServiceBySlugOrId(
        lookupValue
      );

      if (
        result &&
        result.status === "SUCCESS" &&
        result.data &&
        typeof result.data === "object"
      ) {
        return normalizeService(result.data);
      }

      var serviceError = new Error(
        result &&
        result.error &&
        result.error.message ||
        "Servicio no encontrado."
      );

      serviceError.code =
        result &&
        result.error &&
        result.error.code ||
        "SERVICE_LOOKUP_FAILED";

      if (!isRetryableError(serviceError)) {
        throw serviceError;
      }

      lastError = serviceError;
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }

      lastError = error;
    }

    if (attempt < MAX_RETRIES) {
      await sleep(
        BASE_DELAY_MS * Math.pow(2, attempt)
      );
    }
  }

  console.error(
    "[servicio-2] Carga fallida",
    {
      traceId: traceId,
      code: lastError && lastError.code
    }
  );

  throw lastError || new Error(
    "No se pudo cargar el servicio."
  );
}

function onBridgeError(
  error,
  detail,
  traceId
) {
  var cause = (
    error &&
    error.cause
  ) || (
    detail &&
    detail.cause
  ) || detail;

  console.error(
    "[servicio-2] Error bridge",
    {
      traceId: traceId,
      code: error && error.code,
      causeCode: cause && cause.code
    }
  );

  showError(
    cause && cause.message ||
    error && error.message ||
    "No se pudo cargar el servicio.",
    error && error.code
  );
}

$w.onReady(function () {
  var traceId = makeTraceId("servicio");
  var widget;

  try {
    widget = $w(
      "#htmlWidgetCustomService"
    );
  } catch (_) {
    showError(
      "El widget del servicio no esta disponible.",
      "WIDGET_NOT_FOUND"
    );
    return;
  }

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    showError(
      "El widget del servicio no esta disponible.",
      "WIDGET_INVALID"
    );
    return;
  }

  var lookupValue = resolveServiceLookup();

  if (!lookupValue) {
    showError(
      "No se pudo localizar el servicio en la URL.",
      "SERVICE_LOOKUP_MISSING"
    );
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
        resolvedService =
          await loadServiceWithRetry(
            lookupValue,
            traceId
          );

        return resolvedService;
      },

      onWidgetMessage: async function (
        message,
        reply
      ) {
        var type = getMessageType(message);

        if (
          type === MESSAGE_TYPES.READY ||
          type === MESSAGE_TYPES.CONTEXT
        ) {
          return;
        }

        var payload = getPayload(message);

        if (!resolvedService) {
          if (type === MESSAGE_TYPES.BOOK) {
            reply(
              MESSAGE_TYPES.BOOK,
              createError(
                "SERVICE_NOT_READY",
                "El servicio aun se esta cargando."
              )
            );
          }

          return;
        }

        if (type === MESSAGE_TYPES.BOOK) {
          wixLocation.to(
            buildBookingUrl(
              resolvedService,
              payload
            )
          );

          return;
        }

        if (type === MESSAGE_TYPES.NAV) {
          var target = text(
            payload.target
          ).toUpperCase();

          if (
            !target ||
            target === "SERVICIOS"
          ) {
            wixLocation.to(
              getServicesUrl()
            );

            return;
          }

          reply(
            MESSAGE_TYPES.NAV,
            createError(
              "UNSUPPORTED_NAV_TARGET",
              "Destino de navegacion no permitido."
            )
          );
        }
      },

      onError: function (
        error,
        detail
      ) {
        onBridgeError(
          error,
          detail,
          traceId
        );
      }
    });
  } catch (error) {
    showError(
      error && error.message ||
      "No se pudo inicializar el servicio.",
      error && error.code ||
      "SERVICE_PAGE_INIT_FAILED"
    );
  }
});
