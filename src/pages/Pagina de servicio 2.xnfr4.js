/*
=============================================================================
FILE: pages/servicio-2.js
VERSION: v5013.10-WIDGET-ERROR-FIX
PURPOSE: Load the CMS service and provide aligned widget context.
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
var pendingWidgetError = null;

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
    value.addOnId ||
    value.nativeId ||
    value._id ||
    value.id ||
    value.value
  );
}

function getMessageType(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  return text(message.type).toUpperCase();
}

function getPayload(message) {
  var payload = message && message.payload;

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {};
  }

  return payload;
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
      "El servicio no tiene un identificador valido."
    );
  }

  if (!slug) {
    throw new Error(
      "El servicio no tiene un slug valido."
    );
  }

  return {
    serviceId: serviceId,
    slug: slug,

    title: text(
      data.title ||
      metadata.titulo ||
      metadata.tituloServicio,
      "Servicio"
    ),

    description: text(
      data.description ||
      metadata.descripcionLarga
    ),

    tagLine: text(
      data.tagLine ||
      metadata.resumenCorto
    ),

    location: text(
      data.location ||
      data.localizacion ||
      metadata.localizacion
    ),

    totalDuration: Math.max(
      0,
      toFiniteNumber(
        data.totalDuration != null
          ? data.totalDuration
          : data.duracionTotal != null
            ? data.duracionTotal
            : metadata.duracionTotal
      )
    ),

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

    mainMedia:
      data.mainMedia ||
      metadata.mainMedia ||
      "",

    addOnOptions:
      Array.isArray(data.addOnOptions)
        ? data.addOnOptions
        : Array.isArray(metadata.addOnOptions)
          ? metadata.addOnOptions
          : [],

    linkedPhases: getLinkedPhaseId(
      data.linkedPhases
    ),

    availableStaff:
      Array.isArray(data.availableStaff)
        ? data.availableStaff
        : [],

    clientHidden:
      data.clientHidden === true,

    allowCombine:
      data.allowCombine === true,

    phase1Duration: Math.max(
      0,
      toFiniteNumber(
        data.phase1Duration != null
          ? data.phase1Duration
          : data.tiempoFase1
      )
    ),

    exposureDuration: Math.max(
      0,
      toFiniteNumber(
        data.exposureDuration != null
          ? data.exposureDuration
          : data.tiempoExposicion
      )
    ),

    phase2Duration: Math.max(
      0,
      toFiniteNumber(
        data.phase2Duration != null
          ? data.phase2Duration
          : data.tiempoFase2
      )
    ),

    recommendations:
      Array.isArray(data.recommendations)
        ? data.recommendations
        : Array.isArray(metadata.recomendaciones)
          ? metadata.recomendaciones
          : []
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
  } catch (ignored) {
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
    var queryValue = normalizeLookupValue(
      candidates[i]
    );

    if (queryValue) {
      return queryValue;
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
      var serviceSlug = normalizeLookupValue(
        path[p + 1]
      );

      if (serviceSlug) {
        return serviceSlug;
      }
    }
  }

  var lastPart = normalizeLookupValue(
    path[path.length - 1]
  );

  if (
    !lastPart ||
    EXCLUDED_PATHS.has(lastPart.toLowerCase())
  ) {
    return null;
  }

  return lastPart;
}

function getAllowedAddOnIds(service) {
  var options = (
    service &&
    Array.isArray(service.addOnOptions)
  )
    ? service.addOnOptions
    : [];

  var allowed = new Set();

  for (var i = 0; i < options.length; i++) {
    var id = getReferenceId(options[i]);

    if (id) {
      allowed.add(id);
    }
  }

  return allowed;
}

function getAddOnIds(payload, service) {
  if (!Array.isArray(payload.addOnIds)) {
    return [];
  }

  var allowed = getAllowedAddOnIds(service);
  var seen = new Set();
  var result = [];

  for (var i = 0; i < payload.addOnIds.length; i++) {
    var id = getReferenceId(
      payload.addOnIds[i]
    );

    if (
      id &&
      allowed.has(id) &&
      !seen.has(id)
    ) {
      seen.add(id);
      result.push(id);
    }
  }

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
    "slug",
    getServiceSlug(service)
  );

  params.set(
    "serviceId",
    getServiceId(service)
  );

  params.set(
    "referral",
    "servicio-2"
  );

  var addOnIds = getAddOnIds(
    payload,
    service
  );

  if (addOnIds.length > 0) {
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

function createErrorContext(code, message) {
  return {
    status: "ERROR",
    data: null,
    error: {
      code: text(code, "SERVICE_LOOKUP_FAILED"),
      message: text(
        message,
        "No se pudo cargar el servicio."
      )
    }
  };
}

function showError(message, code) {
  var context = createErrorContext(
    code,
    message
  );

  pendingWidgetError = context;

  console.error(
    "[servicio-2] Error:",
    context.error.code,
    context.error.message
  );

  if (!bridge) {
    return;
  }

  try {
    bridge.send(
      MESSAGE_TYPES.CONTEXT,
      context
    );

    pendingWidgetError = null;
  } catch (error) {
    console.warn(
      "[servicio-2] No se pudo enviar el error al widget:",
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
    message.indexOf("fetch failed") >= 0 ||
    message.indexOf("connection") >= 0 ||
    message.indexOf("econnreset") >= 0 ||
    message.indexOf("etimedout") >= 0
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
        (
          result &&
          result.error &&
          result.error.message
        ) || "Servicio no encontrado."
      );

      serviceError.code = (
        result &&
        result.error &&
        result.error.code
      ) || "SERVICE_LOOKUP_FAILED";

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
      code: lastError && lastError.code,
      message: lastError && lastError.message
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
    "[servicio-2] Error del bridge",
    {
      traceId: traceId,
      code: error && error.code,
      causeCode: cause && cause.code,
      causeMessage: cause && cause.message
    }
  );

  showError(
    (
      cause &&
      cause.message
    ) ||
    (
      error &&
      error.message
    ) ||
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
  } catch (error) {
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
        try {
          resolvedService =
            await loadServiceWithRetry(
              lookupValue,
              traceId
            );

          return resolvedService;
        } catch (error) {
          var contextError = createErrorContext(
            error && error.code,
            error && error.message
          );

          pendingWidgetError = contextError;

          return contextError;
        }
      },

      onWidgetMessage: async function (
        message,
        reply,
        currentBridge
      ) {
        void currentBridge;

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
              createErrorContext(
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
            createErrorContext(
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

    if (!bridge) {
      showError(
        "No se pudo inicializar el widget.",
        "BRIDGE_NOT_INITIALIZED"
      );
      return;
    }

    if (pendingWidgetError) {
      try {
        bridge.send(
          MESSAGE_TYPES.CONTEXT,
          pendingWidgetError
        );

        pendingWidgetError = null;
      } catch (error) {
        console.warn(
          "[servicio-2] Error pendiente no enviado:",
          error && error.message
        );
      }
    }
  } catch (error) {
    showError(
      error && error.message ||
      "No se pudo inicializar el servicio.",
      error && error.code ||
      "SERVICE_PAGE_INIT_FAILED"
    );
  }
});
