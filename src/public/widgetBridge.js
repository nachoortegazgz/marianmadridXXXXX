/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5013.10-CONTINUITY-ALIGNED
PURPOSE: Secure bridge between Wix Velo and HTML Components.
=============================================================================
*/

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  READY: "MM_READY",
  CONTEXT: "MM_CONTEXT",
  AVAIL: "MM_AVAIL",
  SELECT: "MM_SELECT",
  BOOK: "MM_BOOK",
  NAV: "MM_NAV"
});

export const PROTOCOL_URLS = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO_2: "/booking-calendar/calendario-2",
  PRIVACY_POLICY: "/politica-de-privacidad"
});

export const PROTOCOL_UI = Object.freeze({
  FRONTEND_API_TIMEOUT_MS: 190000,
  HANDSHAKE_TIMEOUT_MS: 60000,
  CONTEXT_TIMEOUT_MS: 180000
});

export const WIDGET_ERROR_CODE = Object.freeze({
  INVALID_WIDGET: "WIDGET_INVALID_HTML_COMPONENT",
  DESTROYED: "WIDGET_BRIDGE_DESTROYED",
  ORIGIN_REJECTED: "WIDGET_ORIGIN_REJECTED",
  ORIGIN_OPAQUE_REJECTED: "WIDGET_ORIGIN_OPAQUE_REJECTED",
  MESSAGE_TOO_LARGE: "WIDGET_MESSAGE_TOO_LARGE",
  PAYLOAD_TOO_COMPLEX: "WIDGET_PAYLOAD_TOO_COMPLEX",
  TYPE_MISSING: "WIDGET_MESSAGE_TYPE_MISSING",
  TYPE_NOT_ALLOWED: "WIDGET_TYPE_NOT_ALLOWED",
  VERSION_UNSUPPORTED: "WIDGET_PROTOCOL_VERSION_UNSUPPORTED",
  MESSAGE_ID_INVALID: "WIDGET_MESSAGE_ID_INVALID",
  HANDSHAKE_TIMEOUT: "WIDGET_HANDSHAKE_TIMEOUT",
  CONTEXT_TIMEOUT: "WIDGET_CONTEXT_TIMEOUT",
  CONTEXT_FAILED: "WIDGET_CONTEXT_FAILED",
  HANDLER_FAILED: "WIDGET_MESSAGE_HANDLER_FAILED"
});

var MAX_TYPE_LENGTH = 40;
var MAX_MESSAGE_ID_LENGTH = 120;
var MAX_MESSAGE_BYTES = 100000;
var MAX_PAYLOAD_KEYS = 400;

var DEFAULT_ALLOWED_ORIGIN_SUFFIXES = Object.freeze([
  ".parastorage.com",
  ".wix.com",
  ".wixsite.com",
  ".editorx.com"
]);

var OPAQUE_ORIGIN_PREFIXES = Object.freeze([
  "blob:",
  "data:",
  "filesystem:"
]);

var RESPONSE_PATTERN = /^[A-Z][A-Z0-9_]{0,38}_RES$/;
var ADMIN_RESPONSE_TYPE = "MM_ADMIN_RESPONSE";

var bridgeCounter = 0;

function safeObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function safeType(value) {
  return String(value == null ? "" : value)
    .trim()
    .toUpperCase()
    .slice(0, MAX_TYPE_LENGTH);
}

function safeMessageId(value) {
  var result = String(value == null ? "" : value).trim();

  if (
    !result ||
    result.length > MAX_MESSAGE_ID_LENGTH ||
    !/^[a-zA-Z0-9._:-]+$/.test(result)
  ) {
    return "";
  }

  return result;
}

function protocolVersion(value) {
  if (value === undefined || value === null || value === "") {
    return PROTOCOL_VERSION;
  }

  var parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function estimateBytes(value) {
  try {
    var serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? serialized.length
      : MAX_MESSAGE_BYTES + 1;
  } catch (_) {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function countKeys(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  var total = 0;
  var stack = [value];

  while (
    stack.length > 0 &&
    total <= MAX_PAYLOAD_KEYS
  ) {
    var current = stack.pop();

    if (!current || typeof current !== "object") {
      continue;
    }

    var keys = Object.keys(current);
    total += keys.length;

    for (var i = 0; i < keys.length; i++) {
      var child = current[keys[i]];

      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }

  return total;
}

function normalizeSuffix(value) {
  var suffix = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");

  return suffix ? "." + suffix : "";
}

function classifyOrigin(value) {
  var origin = String(value == null ? "" : value)
    .trim()
    .toLowerCase();

  if (!origin || origin === "null") {
    return {
      opaque: true,
      value: origin
    };
  }

  return {
    opaque: OPAQUE_ORIGIN_PREFIXES.some(function (prefix) {
      return origin.indexOf(prefix) === 0;
    }),
    value: origin
  };
}

function originHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (_) {
    return origin
      .replace(/^[a-z0-9+.-]+:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
  }
}

function createOriginPolicy(options) {
  var exact = String(
    options.allowedOrigin || ""
  )
    .trim()
    .toLowerCase()
    .replace(/\/$/, "");

  if (exact) {
    return {
      mode: "exact",
      exact: exact,
      suffixes: [],
      allowOpaqueOrigin:
        options.allowOpaqueOrigin === true
    };
  }

  var custom = Array.isArray(
    options.allowedOriginSuffixes
  )
    ? options.allowedOriginSuffixes
        .map(normalizeSuffix)
        .filter(Boolean)
    : [];

  return {
    mode: options.strictOrigin === false
      ? "off"
      : "suffix",
    exact: "",
    suffixes: custom.length
      ? custom
      : DEFAULT_ALLOWED_ORIGIN_SUFFIXES,
    allowOpaqueOrigin:
      options.allowOpaqueOrigin === true
  };
}

function originAllowed(origin, policy) {
  if (policy.mode === "off") {
    return true;
  }

  if (policy.mode === "exact") {
    return origin === policy.exact;
  }

  var host = originHost(origin);

  return policy.suffixes.some(function (suffix) {
    var base = suffix.slice(1);

    return host === base || host.endsWith(suffix);
  });
}

function responseBase(type) {
  return RESPONSE_PATTERN.test(type)
    ? type.slice(0, -4)
    : "";
}

export function buildResponseType(type) {
  return safeType(type) + "_RES";
}

export function createWidgetBridge(
  widgetElement,
  options
) {
  var settings = safeObject(options);

  if (
    !widgetElement ||
    typeof widgetElement.onMessage !== "function" ||
    typeof widgetElement.postMessage !== "function"
  ) {
    var invalid = new Error(
      WIDGET_ERROR_CODE.INVALID_WIDGET
    );

    invalid.code = WIDGET_ERROR_CODE.INVALID_WIDGET;
    throw invalid;
  }

  bridgeCounter += 1;

  var bridgeId =
    "wbridge-" +
    bridgeCounter.toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8);

  var policy = createOriginPolicy(settings);

  var allowedTypes = new Set(
    Array.isArray(settings.allowedTypes) &&
    settings.allowedTypes.length
      ? settings.allowedTypes.map(safeType)
      : Object.values(MESSAGE_TYPES)
  );

  var onContextReady =
    typeof settings.onContextReady === "function"
      ? settings.onContextReady
      : null;

  var onWidgetMessage =
    typeof settings.onWidgetMessage === "function"
      ? settings.onWidgetMessage
      : null;

  var onError =
    typeof settings.onError === "function"
      ? settings.onError
      : function () {};

  var contextTimeoutMs =
    Number(settings.contextTimeoutMs) > 0
      ? Number(settings.contextTimeoutMs)
      : PROTOCOL_UI.CONTEXT_TIMEOUT_MS;

  var destroyed = false;
  var contextInFlight = false;
  var handshakeCompleted = false;
  var sequence = 0;
  var listeners = new Set();

  function report(code, detail, cause) {
    var error = new Error(code);

    error.code = code;
    error.bridgeId = bridgeId;

    if (detail) {
      error.detail = detail;
    }

    if (cause) {
      error.cause = cause;
    }

    try {
      onError(error, detail);
    } catch (_) {
      // Error reporting must not break the bridge.
    }

    return error;
  }

  function nextMessageId() {
    sequence += 1;

    return safeMessageId(
      bridgeId +
      "-" +
      Date.now().toString(36) +
      "-" +
      sequence.toString(36)
    );
  }

  function isAllowedType(type) {
    if (
      allowedTypes.has(type) ||
      type === ADMIN_RESPONSE_TYPE
    ) {
      return true;
    }

    var base = responseBase(type);

    return Boolean(
      base && allowedTypes.has(base)
    );
  }

  function extractMessage(event) {
    var classified = classifyOrigin(
      event && event.origin
    );

    if (classified.opaque) {
      if (!policy.allowOpaqueOrigin) {
        report(
          WIDGET_ERROR_CODE.ORIGIN_OPAQUE_REJECTED,
          { origin: classified.value }
        );
        return null;
      }
    } else if (
      policy.mode !== "off" &&
      !originAllowed(
        classified.value,
        policy
      )
    ) {
      report(
        WIDGET_ERROR_CODE.ORIGIN_REJECTED,
        { origin: classified.value }
      );
      return null;
    }

    var data = safeObject(event && event.data);

    if (
      estimateBytes(data) > MAX_MESSAGE_BYTES
    ) {
      report(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
      return null;
    }

    if (
      countKeys(data) > MAX_PAYLOAD_KEYS
    ) {
      report(WIDGET_ERROR_CODE.PAYLOAD_TOO_COMPLEX);
      return null;
    }

    return data;
  }

  function normalizeMessage(source) {
    var type = safeType(source.type);

    if (!type) {
      return null;
    }

    if (!isAllowedType(type)) {
      report(
        WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED,
        { receivedType: type }
      );
      return null;
    }

    if (
      protocolVersion(source.version) !==
      PROTOCOL_VERSION
    ) {
      report(
        WIDGET_ERROR_CODE.VERSION_UNSUPPORTED
      );
      return null;
    }

    var messageId = safeMessageId(
      source.messageId
    );

    if (
      (
        type === MESSAGE_TYPES.BOOK ||
        type === MESSAGE_TYPES.NAV
      ) &&
      !messageId
    ) {
      report(
        WIDGET_ERROR_CODE.MESSAGE_ID_INVALID
      );
      return null;
    }

    return {
      type: type,
      payload: safeObject(source.payload),
      messageId: messageId,
      requestId: safeMessageId(
        source.requestId
      ) || messageId,
      version: PROTOCOL_VERSION,
      bridgeId: bridgeId
    };
  }

  function send(
    type,
    payload,
    messageId
  ) {
    if (destroyed) {
      var destroyedError = new Error(
        WIDGET_ERROR_CODE.DESTROYED
      );

      destroyedError.code =
        WIDGET_ERROR_CODE.DESTROYED;

      throw destroyedError;
    }

    var normalizedType = safeType(type);

    if (!isAllowedType(normalizedType)) {
      var typeError = new Error(
        WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED
      );

      typeError.code =
        WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED;

      throw typeError;
    }

    var message = {
      type: normalizedType,
      payload: safeObject(payload),
      messageId: safeMessageId(
        messageId
      ) || nextMessageId(),
      version: PROTOCOL_VERSION,
      bridgeId: bridgeId
    };

    if (
      estimateBytes(message) >
      MAX_MESSAGE_BYTES
    ) {
      var sizeError = new Error(
        WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE
      );

      sizeError.code =
        WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE;

      throw sizeError;
    }

    widgetElement.postMessage(message);

    return message.messageId;
  }

  function reply(
    type,
    payload,
    requestMessage
  ) {
    var requestId =
      requestMessage &&
      (
        requestMessage.messageId ||
        requestMessage.requestId
      );

    return send(
      type,
      payload,
      requestId
    );
  }

  function notify(message) {
    listeners.forEach(function (listener) {
      try {
        listener(message, bridge);
      } catch (error) {
        report(
          WIDGET_ERROR_CODE.HANDLER_FAILED,
          null,
          error
        );
      }
    });
  }

  async function publishContext(
    readyMessage
  ) {
    if (
      !onContextReady ||
      contextInFlight ||
      destroyed
    ) {
      return;
    }

    contextInFlight = true;

    try {
      var context = await Promise.race([
        Promise.resolve().then(function () {
          return onContextReady(
            readyMessage,
            bridge
          );
        }),

        new Promise(function (_, reject) {
          setTimeout(function () {
            var timeout = new Error(
              WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
            );

            timeout.code =
              WIDGET_ERROR_CODE.CONTEXT_TIMEOUT;

            reject(timeout);
          }, contextTimeoutMs);
        })
      ]);

      if (
        context !== undefined &&
        context !== null &&
        !destroyed
      ) {
        send(
          MESSAGE_TYPES.CONTEXT,
          context,
          readyMessage.messageId
        );
      }
    } catch (error) {
      report(
        error.code ||
          WIDGET_ERROR_CODE.CONTEXT_FAILED,
        null,
        error
      );
    } finally {
      contextInFlight = false;
    }
  }

  var bridge = {
    type: "WIX_HTML_COMPONENT_BRIDGE",
    bridgeId: bridgeId,
    protocolVersion: PROTOCOL_VERSION,
    widget: widgetElement,

    get destroyed() {
      return destroyed;
    },

    get handshakeCompleted() {
      return handshakeCompleted;
    },

    send: send,

    reply: reply,

    postMessage: function (
      payload,
      type
    ) {
      return send(
        type || MESSAGE_TYPES.CONTEXT,
        payload
      );
    },

    subscribe: function (callback) {
      if (
        destroyed ||
        typeof callback !== "function"
      ) {
        return function () {};
      }

      listeners.add(callback);

      return function () {
        listeners.delete(callback);
      };
    },

    destroy: function () {
      destroyed = true;
      listeners.clear();

      if (
        typeof unsubscribe === "function"
      ) {
        unsubscribe();
      }
    }
  };

  var unsubscribe = widgetElement.onMessage(
    function (event) {
      if (destroyed) {
        return;
      }

      var extracted = extractMessage(event);

      if (!extracted) {
        return;
      }

      var message = normalizeMessage(
        extracted
      );

      if (!message) {
        return;
      }

      if (
        message.type === MESSAGE_TYPES.READY
      ) {
        handshakeCompleted = true;
        notify(message);
        void publishContext(message);
      } else {
        notify(message);

        if (onWidgetMessage) {
          Promise.resolve()
            .then(function () {
              return onWidgetMessage(
                message,
                function (
                  responseType,
                  payload
                ) {
                  return reply(
                    responseType,
                    payload,
                    message
                  );
                },
                bridge
              );
            })
            .catch(function (error) {
              report(
                error.code ||
                  WIDGET_ERROR_CODE.HANDLER_FAILED,
                null,
                error
              );
            });
        }
      }
    }
  );

  return bridge;
}

export default createWidgetBridge;

La reserva dual con `gap` todavía no ocurre en este módulo. Este módulo solo transporta el servicio y los complementos. La lógica de dos reservas simples coordinadas debe permanecer en el calendario/backend, no en el widget ni en `servicio-2.js`.
