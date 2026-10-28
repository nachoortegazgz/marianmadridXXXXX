/*
MODULE: src/backend/responseUtils.js
RESPONSIBILITY: Normalizes backend errors and constructs safe public response payloads.
STATIC DEPENDENCIES: public/mmUtils
NAMED EXPORT DECLARATIONS DETECTED: AppError, successResponse, errorResponse, _toPublicError
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are intentionally omitted.
*/
import { _cloneDeep, _safeTrim } from "public/mmUtils";

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_ERROR_CODE = "INTERNAL_ERROR";
const DEFAULT_ERROR_MESSAGE = "Error interno";
const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

// =============================================================================
// BLOQUE 2 - ERROR DE APLICACION
// =============================================================================

export class AppError extends Error {
    constructor(
        code = DEFAULT_ERROR_CODE,
        message = DEFAULT_ERROR_MESSAGE,
        meta = {}
    ) {
        super(String(message || DEFAULT_ERROR_MESSAGE));

        this.name = "AppError";
        this.code = String(code || DEFAULT_ERROR_CODE);
        this.meta = _cloneMeta(meta);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }
}

// =============================================================================
// BLOQUE 3 - HELPERS INTERNOS
// =============================================================================

function _cloneMeta(value) {
    if (!value || typeof value !== "object") {
        return value === undefined ? {} : { details: value };
    }

    try {
        return _cloneDeep(value);
    } catch {
        return {
            details: "Metadata could not be cloned safely.",
        };
    }
}

function _normalizeMeta(metaExtra) {
    if (!metaExtra || typeof metaExtra !== "object") {
        return {};
    }
    return _cloneMeta(metaExtra);
}

function _truncateMessage(value) {
    const rawMessage =
        value instanceof Error
            ? value.message || String(value)
            : String(value || "");

    const safeMessage = _safeTrim(rawMessage);

    if (safeMessage.length <= MAX_ERROR_MESSAGE_LENGTH) {
        return safeMessage;
    }

    return `${safeMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
}

function _extractErrorValues(code, message) {
    if (code instanceof Error) {
        return {
            code: code.code || code.name || UNKNOWN_ERROR_CODE,
            message: code.message || DEFAULT_ERROR_MESSAGE,
        };
    }

    if (code && typeof code === "object") {
        return {
            code: code.code || code.name || UNKNOWN_ERROR_CODE,
            message:
                code.message ||
                code.error ||
                code.reason ||
                DEFAULT_ERROR_MESSAGE,
        };
    }

    if (
        typeof code === "string" &&
        (message === undefined || message === null)
    ) {
        return {
            code: UNKNOWN_ERROR_CODE,
            message: code,
        };
    }

    return {
        code: code || DEFAULT_ERROR_CODE,
        message: message || DEFAULT_ERROR_MESSAGE,
    };
}

// =============================================================================
// BLOQUE 4 - RESPUESTAS PUBLICAS
// =============================================================================

export function successResponse(data = null, metaExtra = {}) {
    const extra = _normalizeMeta(metaExtra);

    return {
        status: "SUCCESS",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data,
        error: null,
    };
}

export function errorResponse(
    code = DEFAULT_ERROR_CODE,
    message = DEFAULT_ERROR_MESSAGE,
    metaExtra = {}
) {
    const extracted = _extractErrorValues(code, message);
    const safeMessage =
        _truncateMessage(extracted.message) || DEFAULT_ERROR_MESSAGE;

    const extra = _normalizeMeta(metaExtra);

    return {
        status: "ERROR",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data: null,
        error: {
            code: String(extracted.code || DEFAULT_ERROR_CODE),
            message: safeMessage,
        },
    };
}

// =============================================================================
// BLOQUE 5 - CONVERSION DE ERRORES PUBLICOS
// =============================================================================

export function _toPublicError(
    err,
    fallbackCode = DEFAULT_ERROR_CODE,
    fallbackMessage = DEFAULT_ERROR_MESSAGE
) {
    const code = err?.code || fallbackCode;
    const message = err?.message || fallbackMessage;

    return {
        code: String(code),
        message: _truncateMessage(message) || fallbackMessage,
    };
}

// =============================================================================
// CERO-DEUDA ZC-07: eliminados toWebMethodResult e isSuccess
// (0 consumidores en src/ y tests; los web methods construyen respuestas
// explicitamente con successResponse/errorResponse).
// =============================================================================
