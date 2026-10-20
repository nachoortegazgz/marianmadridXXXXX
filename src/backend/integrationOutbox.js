/*
=============================================================================
MODULE: backend/integrationOutbox.js
RESPONSIBILITY: Idempotent integration outbox for downstream external record
                systems. Business collections remain the source of truth.
SCHEMA: RegistroIntegracion v1.
SECURITY: Backend-only callers; no client-supplied payload is accepted directly.
=============================================================================
*/
import {
    getItem as dalGet,
    insertItem as dalInsert,
    updateItem as dalUpdate,
} from "backend/dataAccess";
import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/logger";

const COLLECTION = "RegistroIntegracion";
const SCHEMA_VERSION = "1.0";
const MAX_PAYLOAD_BYTES = 400000;
const log = logger;

const IMMUTABLE_FIELDS = Object.freeze([
    "eventId",
    "eventType",
    "sourceModule",
    "sourceCollection",
    "sourceItemId",
    "occurredAt",
    "traceId",
    "correlationId",
    "idempotencyKey",
    "schemaVersion",
    "payload",
    "payloadHash",
]);

const DELIVERY_STATUS = Object.freeze({
    PENDING: "PENDING",
    DELIVERED: "DELIVERED",
    RETRY: "RETRY",
    FAILED: "FAILED",
});

function _cleanText(value, max = 160) {
    return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function _canonicalize(value) {
    if (Array.isArray(value)) return value.map(_canonicalize);
    if (value && typeof value === "object" && !(value instanceof Date)) {
        return Object.keys(value).sort().reduce((result, key) => {
            if (value[key] !== undefined) result[key] = _canonicalize(value[key]);
            return result;
        }, {});
    }
    if (value instanceof Date) return value.toISOString();
    return value;
}

function _stableJson(value) {
    return JSON.stringify(_canonicalize(value));
}

function _validateEvent(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("INVALID_INTEGRATION_EVENT");
    }
    for (const key of ["eventType", "sourceModule", "sourceCollection", "sourceItemId", "idempotencyKey"]) {
        if (!_cleanText(input[key], 240)) throw new Error("MISSING_" + key.toUpperCase());
    }
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
        throw new Error("INVALID_INTEGRATION_PAYLOAD");
    }
}

function _eventIdFromHash(hash) {
    return "INT_" + hash.slice(0, 64);
}

function _duplicateError(error) {
    const message = String(error?.message || error || "");
    return /WDE0123|duplicate|already exists|unique constraint/i.test(message);
}

/**
 * Writes one immutable event snapshot. Repeating the same idempotencyKey
 * returns the first saved event; it never overwrites the original payload.
 */
export async function recordIntegrationEvent(input) {
    _validateEvent(input);
    const payload = _canonicalize(input.payload);
    const payloadJson = _stableJson(payload);
    if (payloadJson.length > MAX_PAYLOAD_BYTES) throw new Error("INTEGRATION_PAYLOAD_TOO_LARGE");

    const idempotencyKey = _cleanText(input.idempotencyKey, 240);
    const eventId = _eventIdFromHash(await hashSHA256(idempotencyKey));
    const existing = await dalGet(COLLECTION, eventId, "strong");
    if (existing) return { ok: true, created: false, eventId, item: existing };

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) throw new Error("INVALID_OCCURRED_AT");

    const item = {
        _id: eventId,
        eventId,
        eventType: _cleanText(input.eventType, 100).toUpperCase(),
        sourceModule: _cleanText(input.sourceModule, 120),
        sourceCollection: _cleanText(input.sourceCollection, 120),
        sourceItemId: _cleanText(input.sourceItemId, 190),
        occurredAt,
        traceId: _cleanText(input.traceId, 120) || eventId,
        correlationId: _cleanText(input.correlationId, 160) || eventId,
        idempotencyKey,
        schemaVersion: SCHEMA_VERSION,
        payload,
        payloadHash: await hashSHA256(payloadJson),
        deliveryStatus: DELIVERY_STATUS.PENDING,
        deliveryAttempts: 0,
        nextAttemptAt: new Date(),
        deliveredAt: null,
        lastDeliveryError: "",
    };

    try {
        const saved = await dalInsert(COLLECTION, item);
        return { ok: true, created: true, eventId, item: saved || item };
    } catch (error) {
        if (_duplicateError(error)) {
            const duplicate = await dalGet(COLLECTION, eventId, "strong");
            if (duplicate) return { ok: true, created: false, eventId, item: duplicate };
        }
        log.error("integration outbox write failed", {
            eventType: item.eventType,
            sourceModule: item.sourceModule,
            sourceItemId: item.sourceItemId,
            traceId: item.traceId,
            errorCode: _cleanText(error?.code || error?.message, 100) || "WRITE_FAILED",
        });
        throw error;
    }
}

/**
 * Delivery state is mutable; event identity, payload and payloadHash are not.
 * The external system must not be treated as a successful destination until
 * the delivery acknowledgement has been confirmed.
 */
export async function updateIntegrationDelivery(eventId, delivery) {
    const id = _cleanText(eventId, 100);
    if (!id) throw new Error("INVALID_EVENT_ID");
    if (!delivery || !Object.values(DELIVERY_STATUS).includes(delivery.deliveryStatus)) {
        throw new Error("INVALID_DELIVERY_STATUS");
    }
    const existing = await dalGet(COLLECTION, id, "strong");
    if (!existing) throw new Error("INTEGRATION_EVENT_NOT_FOUND");

    const updated = {
        ...existing,
        deliveryStatus: delivery.deliveryStatus,
        deliveryAttempts: Math.max(0, Number(delivery.deliveryAttempts ?? existing.deliveryAttempts ?? 0)),
        nextAttemptAt: delivery.nextAttemptAt ? new Date(delivery.nextAttemptAt) : existing.nextAttemptAt,
        deliveredAt: delivery.deliveryStatus === DELIVERY_STATUS.DELIVERED
            ? (delivery.deliveredAt ? new Date(delivery.deliveredAt) : new Date())
            : existing.deliveredAt,
        lastDeliveryError: _cleanText(delivery.lastDeliveryError, 500),
    };
    await dalUpdate(COLLECTION, updated);
    return { ok: true, eventId: id, deliveryStatus: updated.deliveryStatus };
}

export const INTEGRATION_DELIVERY_STATUS = DELIVERY_STATUS;
export const INTEGRATION_IMMUTABLE_FIELDS = IMMUTABLE_FIELDS;
