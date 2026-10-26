/**
 * public/widgetBridge.js
 * Versión segura v5014
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
  HANDSHAKE_TIMEOUT_MS: 15000,
  CONTEXT_TIMEOUT_MS: 30000
});

export const WIDGET_ERROR_CODE = Object.freeze({
  INVALID_WIDGET: "WIDGET_INVALID_HTML_COMPONENT",
  DESTROYED: "WIDGET_BRIDGE_DESTROYED",
  ORIGIN_REJECTED: "WIDGET_ORIGIN_REJECTED",
  ORIGIN_OPAQUE_REJECTED: "WIDGET_ORIGIN_OPAQUE_REJECTED",
  MESSAGE_TOO_LARGE: "WIDGET_MESSAGE_TOO_LARGE",
  PAYLOAD_TOO_COMPLEX: "WIDGET_PAYLOAD_TOO_COMPLEX",
  TYPE_MISSING: "WIDGET_MESSAGE_TYPE_MISSING",
  TYPE_NOT_ALLOWED: "WIDGET_MESSAGE_TYPE_NOT_ALLOWED",
  VERSION_UNSUPPORTED: "WIDGET_PROTOCOL_VERSION_UNSUPPORTED",
  MESSAGE_REJECTED: "WIDGET_MESSAGE_REJECTED",
  MESSAGE_ID_INVALID: "WIDGET_MESSAGE_ID_INVALID",
  HANDSHAKE_TIMEOUT: "WIDGET_HANDSHAKE_TIMEOUT",
  CONTEXT_TIMEOUT: "WIDGET_CONTEXT_TIMEOUT",
  CONTEXT_FAILED: "WIDGET_CONTEXT_FAILED",
  LISTENER_FAILED: "WIDGET_MESSAGE_LISTENER_FAILED",
  HANDLER_FAILED: "WIDGET_MESSAGE_HANDLER_FAILED"
});

const MAX_TYPE_LENGTH = 40;
const MAX_MESSAGE_ID_LENGTH = 120;
const MAX_MESSAGE_BYTES = 100000;
const MAX_PAYLOAD_KEYS = 400;
const RESPONSE_SUFFIX = "_RES";
const ADMIN_RESPONSE_TYPE = "MM_ADMIN_RESPONSE";

const DEFAULT_ORIGIN_SUFFIXES = Object.freeze([
  ".parastorage.com",
  ".wix.com",
  ".wixsite.com",
  ".editorx.com"
]);

const DEFAULT_ALLOWED_TYPES = Object.freeze(
  Object.values(MESSAGE_TYPES)
);

const OPAQUE_PREFIXES = Object.freeze([
  "blob:",
  "data:",
  "filesystem:"
]);

const encoder =
  typeof TextEncoder === "function" ? new TextEncoder() : null;

let instanceCounter = 0;

function safeObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function safeType(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .slice(0, MAX_TYPE_LENGTH);
}

function safeMessageId(value) {
  const id = String(value ?? "").trim();

  if (
    !id ||
    id.length > MAX_MESSAGE_ID_LENGTH ||
    !/^[a-zA-Z0-9._:-]+$/.test(id)
  ) {
    return "";
  }

  return id;
}

function safeVersion(value) {
  if (value === undefined || value === null || value === "") {
    return PROTOCOL_VERSION;
  }

  const version = Number(value);

  return Number.isInteger(version) && version > 0
    ? version
    : null;
}

function byteSize(value) {
  try {
    const json = JSON.stringify(value);

    if (typeof json !== "string") {
      return MAX_MESSAGE_BYTES + 1;
    }

    return encoder
      ? encoder.encode(json).length
      : json.length;
  } catch (_) {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function keyCount(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  let total = 0;
  const stack = [value];

  while (stack.length && total <= MAX_PAYLOAD_KEYS) {
    const current = stack.pop();

    if (!current || typeof current !== "object") {
      continue;
    }

    const keys = Object.keys(current);
    total += keys.length;

    for (const key of keys) {
      const child = current[key];

      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }

  return total;
}

function isResponseType(type) {
  return /^[A-Z][A-Z0-9_]{0,38}_RES$/.test(type);
}

function responseBase(type) {
  return isResponseType(type)
    ? type.slice(0, -RESPONSE_SUFFIX.length)
    : "";
}

function normalizeSuffix(value) {
  const suffix = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");

  return suffix ? `.${suffix}` : "";
}

function classifyOrigin(rawOrigin) {
  const origin = String(rawOrigin ?? "")
    .trim()
    .toLowerCase();

  if (!origin || origin === "null") {
    return {
      opaque: true,
      value: origin
    };
  }

  return {
    opaque: OPAQUE_PREFIXES.some((prefix) =>
      origin.startsWith(prefix)
    ),
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
  const exact = String(options.allowedOrigin ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/$/, "");

  if (exact) {
    return Object.freeze({
      mode: "exact",
      exact,
      suffixes: Object.freeze([]),
      allowOpaqueOrigin: options.allowOpaqueOrigin === true
    });
  }

  const customSuffixes = Array.isArray(
    options.allowedOriginSuffixes
  )
    ? options.allowedOriginSuffixes
        .map(normalizeSuffix)
        .filter(Boolean)
    : [];

  return Object.freeze({
    mode: options.strictOrigin === false ? "off" : "suffix",
    exact: "",
    suffixes: Object.freeze(
      customSuffixes.length
        ? customSuffixes
        : DEFAULT_ORIGIN_SUFFIXES
    ),
    allowOpaqueOrigin: options.allowOpaqueOrigin === true
  });
}

function isOriginAllowed(origin, policy) {
  if (policy.mode === "off") {
    return true;
  }

  if (policy.mode === "exact") {
    return origin === policy.exact;
  }

  const host = originHost(origin);

  return policy.suffixes.some((suffix) => {
    const base = suffix.slice(1);
    return host === base || host.endsWith(suffix);
  });
}

function managedTimeout(promise, timeout, code, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      timers.delete(timer);

      const error = new Error(code);
      error.code = code;
      reject(error);
    }, Math.max(1, Number(timeout) || 1));

    timers.add(timer);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);
        reject(error);
      }
    );
  });
}

export function createWidgetBridge(widgetElement, options = {}) {
  if (
    !widgetElement ||
    typeof widgetElement.onMessage !== "function" ||
    typeof widgetElement.postMessage !== "function"
  ) {
    const error = new TypeError(
      WIDGET_ERROR_CODE.INVALID_WIDGET
    );

    error.code = WIDGET_ERROR_CODE.INVALID_WIDGET;
    throw error;
  }

  const settings = safeObject(options);
  const bridgeId = `wbridge-${++instanceCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const originPolicy = createOriginPolicy(settings);

  const allowedTypes = new Set(
    Array.isArray(settings.allowedTypes) &&
      settings.allowedTypes.length
      ? settings.allowedTypes.map(safeType).filter(Boolean)
      : DEFAULT_ALLOWED_TYPES
  );

  const handshakeTimeoutMs =
    Number(settings.handshakeTimeoutMs) > 0
      ? Number(settings.handshakeTimeoutMs)
      : PROTOCOL_UI.HANDSHAKE_TIMEOUT_MS;

  const contextTimeoutMs =
    Number(settings.contextTimeoutMs) > 0
      ? Number(settings.contextTimeoutMs)
      : PROTOCOL_UI.CONTEXT_TIMEOUT_MS;

  const onWidgetMessage =
    typeof settings.onWidgetMessage === "function"
      ? settings.onWidgetMessage
      : null;

  const onContextReady =
    typeof settings.onContextReady === "function"
      ? settings.onContextReady
      : null;

  const onError =
    typeof settings.onError === "function"
      ? settings.onError
      : () => {};

  let destroyed = false;
  let sequence = 0;
  let handshakeCompleted = false;
  let contextInFlight = false;
  let bridge = null;
  let handshakeTimer = null;

  const listeners = new Set();
  const timers = new Set();

  function reportError(code, detail = null, cause = null) {
    const error = new Error(code);
    error.code = code;
    error.bridgeId = bridgeId;

    if (detail !== null) {
      error.detail = detail;
    }

    if (cause) {
      error.cause = cause;
    }

    try {
      onError(error, detail);
    } catch (_) {
      // Nunca interrumpir el puente.
    }

    return error;
  }

  function clearTimers() {
    for (const timer of timers) {
      clearTimeout(timer);
    }

    timers.clear();
    handshakeTimer = null;
  }

  function extractMessage(event) {
    const origin = classifyOrigin(event?.origin);

    if (origin.opaque) {
      if (!originPolicy.allowOpaqueOrigin) {
        reportError(
          WIDGET_ERROR_CODE.ORIGIN_OPAQUE_REJECTED,
          { origin: origin.value }
        );

        return null;
      }
    } else if (
      originPolicy.mode !== "off" &&
      !isOriginAllowed(origin.value, originPolicy)
    ) {
      reportError(
        WIDGET_ERROR_CODE.ORIGIN_REJECTED,
        { origin: origin.value }
      );

      return null;
    }

    const message = safeObject(event?.data);

    if (byteSize(message) > MAX_MESSAGE_BYTES) {
      reportError(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
      return null;
    }

    if (keyCount(message) > MAX_PAYLOAD_KEYS) {
      reportError(WIDGET_ERROR_CODE.PAYLOAD_TOO_COMPLEX);
      return null;
    }

    return message;
  }

  function normalizeMessage(source) {
    const type = safeType(source.type);

    if (!type) {
      return {
        message: null,
        code: WIDGET_ERROR_CODE.TYPE_MISSING
      };
    }

    const responseBaseType = responseBase(type);
    const allowed =
      allowedTypes.has(type) ||
      type === ADMIN_RESPONSE_TYPE ||
      (responseBaseType && allowedTypes.has(responseBaseType));

    if (!allowed) {
      return {
        message: null,
        code: WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED
      };
    }

    const version = safeVersion(source.version);

    if (version !== PROTOCOL_VERSION) {
      return {
        message: null,
        code: WIDGET_ERROR_CODE.VERSION_UNSUPPORTED
      };
    }

    const messageId = safeMessageId(source.messageId);
    const requiresId = [
      MESSAGE_TYPES.AVAIL,
      MESSAGE_TYPES.BOOK,
      MESSAGE_TYPES.NAV
    ].includes(type);

    if (requiresId && !messageId) {
      return {
        message: null,
        code: WIDGET_ERROR_CODE.MESSAGE_ID_INVALID
      };
    }

    return {
      message: Object.freeze({
        type,
        payload: Object.freeze(safeObject(source.payload)),
        messageId,
        requestId: safeMessageId(source.requestId) || messageId,
        version: PROTOCOL_VERSION,
        bridgeId
      }),
      code: null
    };
  }

  function nextMessageId() {
    sequence += 1;

    return safeMessageId(
      `${bridgeId}-${Date.now().toString(36)}-${sequence.toString(36)}`
    );
  }

  function isAllowedType(type) {
    if (allowedTypes.has(type) || type === ADMIN_RESPONSE_TYPE) {
      return true;
    }

    const base = responseBase(type);
    return Boolean(base && allowedTypes.has(base));
  }

  function send(type, payload = {}, messageId = null) {
    if (destroyed) {
      throw reportError(WIDGET_ERROR_CODE.DESTROYED);
    }

    const normalizedType = safeType(type);

    if (!isAllowedType(normalizedType)) {
      throw reportError(WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED);
    }

    const message = Object.freeze({
      type: normalizedType,
      payload: safeObject(payload),
      messageId: safeMessageId(messageId) || nextMessageId(),
      version: PROTOCOL_VERSION,
      bridgeId
    });

    if (byteSize(message) > MAX_MESSAGE_BYTES) {
      throw reportError(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
    }

    widgetElement.postMessage(message);
    return message.messageId;
  }

  function correlationId(message) {
    if (!message || typeof message !== "object") {
      return "";
    }

    return (
      safeMessageId(message.messageId) ||
      safeMessageId(message.requestId)
    );
  }

  function reply(type, payload = {}, requestMessage = null) {
    return send(
      type,
      payload,
      correlationId(requestMessage) || null
    );
  }

  async function publishContext(message) {
    if (
      !onContextReady ||
      contextInFlight ||
      destroyed
    ) {
      return;
    }

    contextInFlight = true;

    try {
      const context = await managedTimeout(
        Promise.resolve().then(() =>
          onContextReady(message, bridge)
        ),
        contextTimeoutMs,
        WIDGET_ERROR_CODE.CONTEXT_TIMEOUT,
        timers
      );

      if (
        destroyed ||
        context === undefined ||
        context === null
      ) {
        return;
      }

      send(
        MESSAGE_TYPES.CONTEXT,
        context,
        message.messageId || null
      );
    } catch (cause) {
      reportError(
        cause?.code === WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
          ? WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
          : WIDGET_ERROR_CODE.CONTEXT_FAILED,
        {
          causeCode: cause?.code || null,
          causeMessage: cause?.message || String(cause)
        },
        cause
      );
    } finally {
      contextInFlight = false;
    }
  }

  function notifyListeners(message) {
    for (const listener of listeners) {
      try {
        listener(message, bridge);
      } catch (error) {
        reportError(
          WIDGET_ERROR_CODE.LISTENER_FAILED,
          null,
          error
        );
      }
    }
  }

  const unsubscribeWidget = widgetElement.onMessage((event) => {
    if (destroyed) return;

    try {
      const extracted = extractMessage(event);
      if (!extracted) return;

      const normalized = normalizeMessage(extracted);

      if (!normalized.message) {
        reportError(
          normalized.code || WIDGET_ERROR_CODE.MESSAGE_REJECTED,
          {
            receivedType: extracted.type ?? null,
            receivedVersion: extracted.version ?? null
          }
        );

        return;
      }

      const message = normalized.message;

      if (message.type === MESSAGE_TYPES.READY) {
        handshakeCompleted = true;

        if (handshakeTimer !== null) {
          clearTimeout(handshakeTimer);
          timers.delete(handshakeTimer);
          handshakeTimer = null;
        }
      }

      notifyListeners(message);

      if (onWidgetMessage) {
        const replyToMessage = (
          responseType,
          payload = {},
          requestMessage = message
        ) => reply(
          responseType,
          payload,
          requestMessage
        );

        Promise.resolve()
          .then(() =>
            onWidgetMessage(
              message,
              replyToMessage,
              bridge
            )
          )
          .catch((error) =>
            reportError(
              error?.code ||
                WIDGET_ERROR_CODE.HANDLER_FAILED,
              null,
              error
            )
          );
      }

      if (message.type === MESSAGE_TYPES.READY) {
        void publishContext(message);
      }
    } catch (error) {
      reportError(
        error?.code || WIDGET_ERROR_CODE.HANDLER_FAILED,
        null,
        error
      );
    }
  });

  handshakeTimer = setTimeout(() => {
    timers.delete(handshakeTimer);
    handshakeTimer = null;

    if (!destroyed && !handshakeCompleted) {
      reportError(
        WIDGET_ERROR_CODE.HANDSHAKE_TIMEOUT,
        { bridgeId }
      );
    }
  }, handshakeTimeoutMs);

  timers.add(handshakeTimer);

  // Importante: se asigna antes de que pueda procesarse el siguiente mensaje.
  bridge = Object.freeze({
    type: "WIX_HTML_COMPONENT_BRIDGE",
    bridgeId,
    protocolVersion: PROTOCOL_VERSION,
    widget: widgetElement,
    originPolicyMode: originPolicy.mode,
    allowedTypes: Object.freeze([...allowedTypes]),

    get destroyed() {
      return destroyed;
    },

    get handshakeCompleted() {
      return handshakeCompleted;
    },

    send,
    reply,

    postMessage(payload = {}, type = MESSAGE_TYPES.CONTEXT) {
      return send(type, payload);
    },

    addListener(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      if (destroyed) return;

      destroyed = true;
      listeners.clear();
      clearTimers();

      if (typeof unsubscribeWidget === "function") {
        try {
          unsubscribeWidget();
        } catch (_) {
          // No interrumpir la destrucción.
        }
      }
    }
  });

  return bridge;
}

export default createWidgetBridge;


Después de guardar, publica y prueba en una ventana privada para descartar una copia antigua del código.
