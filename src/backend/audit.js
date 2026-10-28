/*
MODULE: src/backend/audit.js
RESPONSIBILITY: Writes structured operational audit events to the canonical CMS audit collection.
STATIC DEPENDENCIES: backend/dataAccess, backend/internalConfig, public/mmUtils, backend/logger
NAMED EXPORT DECLARATIONS DETECTED: logAuditEvent, logAuditEventWithTimeout
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are intentionally omitted.
*/
import {
    insertItem as dalInsert,
} from "backend/dataAccess";



import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,
    SDK_CONFIG,
} from "backend/internalConfig";

import {
    _cloneDeep,
    _cleanText,
    _normalizeIdPart,
    _safeTrim,
    withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

const CONTROL_OPERATIVO_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

const DEFAULT_ENTITY_ID = "system";
const DEFAULT_SOURCE = "backend/audit.js";

const VALID_LEVELS = new Set([
    "INFO",
    "WARNING",
    "ERROR",
    "CRITICAL",
]);

// =============================================================================
// HELPERS
// =============================================================================

function _normalizeLevel(level) {
    const normalized = _safeTrim(level).toUpperCase();
    return VALID_LEVELS.has(normalized) ? normalized : "INFO";
}

function _normalizeEventType(eventType) {
    return _normalizeIdPart(eventType, 60).toUpperCase() || "UNKNOWN_EVENT";
}

function _normalizeTraceId(traceId) {
    return _normalizeIdPart(traceId, 80) || "no-trace";
}

function _normalizeEntityId(entityId) {
    return (
        _normalizeIdPart(entityId || DEFAULT_ENTITY_ID, 80) ||
        DEFAULT_ENTITY_ID
    );
}

function _normalizeSource(source) {
    return (
        _normalizeIdPart(source || DEFAULT_SOURCE, 120) ||
        DEFAULT_SOURCE
    );
}

function _normalizeMessage(message) {
    return _cleanText(message, 1000) || "Audit event";
}

function _normalizeData(data) {
    if (!data || typeof data !== "object") {
        return {};
    }
    try {
        return _cloneDeep(data);
    } catch {
        return {
            details: "Audit data could not be cloned safely.",
        };
    }
}

function _buildAuditId(eventType, entityId, traceId) {
    const safeEventType = _normalizeIdPart(eventType, 60);
    const safeEntityId = _normalizeIdPart(entityId, 80);
    const safeTraceId = _normalizeIdPart(traceId, 80);
    const baseId = `AUDIT_${safeEventType}_${safeEntityId}_${safeTraceId}`;
    return baseId.slice(0, 190);
}

/**
 * ALN-02/04: mapea el registro de auditoria al contrato de ControlOperativo.
 * Los campos propios de auditoria viajan en payload (objeto canonico).
 */
function _buildControlOperativoRecord({
    eventType,
    level,
    message,
    data,
    traceId,
    entityId,
    source,
}) {
    const safeEventType = _normalizeEventType(eventType);
    const safeLevel = _normalizeLevel(level);
    const safeMessage = _normalizeMessage(message);
    const safeTraceId = _normalizeTraceId(traceId);
    const safeEntityId = _normalizeEntityId(entityId);
    const safeSource = _normalizeSource(source);
    const now = new Date();

    const auditId = _buildAuditId(safeEventType, safeEntityId, safeTraceId);
    const status =
        safeLevel === "CRITICAL" || safeLevel === "ERROR"
            ? CONTROL_STATUS.OPEN
            : CONTROL_STATUS.COMPLETED;

    return {
        _id: auditId,
        controlType: CONTROL_TYPE.ALERT,
        dedupeKey: auditId,
        resourceId: safeEntityId,
        status,
        payload: {
            eventType: safeEventType,
            level: safeLevel,
            message: safeMessage,
            data: _normalizeData(data),
            source: safeSource,
            loggedAt: now.toISOString(),
        },
        traceId: safeTraceId,
        _createdDate: now,
    };
}

// =============================================================================
// REGISTRO SINCRONO NO BLOQUEANTE
// =============================================================================

export async function logAuditEvent(
    eventType,
    level,
    message,
    data = {},
    traceId = null,
    entityId = DEFAULT_ENTITY_ID,
    source = DEFAULT_SOURCE
) {
    const record = _buildControlOperativoRecord({
        eventType,
        level,
        message,
        data,
        traceId,
        entityId,
        source,
    });

    try {
        await dalInsert(CONTROL_OPERATIVO_COL, record);
    } catch (error) {
        log.error("logAuditEvent failed (non-blocking)", {
            message: error?.message || String(error),
            traceId: record.traceId,
            eventType: eventType,
        });
    }
}

// =============================================================================
// REGISTRO CON TIMEOUT
// =============================================================================

export async function logAuditEventWithTimeout(
    eventType,
    level,
    message,
    data = {},
    traceId = null,
    entityId = DEFAULT_ENTITY_ID,
    source = DEFAULT_SOURCE
) {
    const record = _buildControlOperativoRecord({
        eventType,
        level,
        message,
        data,
        traceId,
        entityId,
        source,
    });

    try {
        await withTimeout(
            () => dalInsert(CONTROL_OPERATIVO_COL, record),
            API_TIMEOUT_MS,
            "audit_insert"
        );
    } catch (error) {
        log.error("logAuditEventWithTimeout failed (non-blocking)", {
            message: error?.message || String(error),
            traceId: record.traceId,
            eventType: eventType,
        });
    }
}