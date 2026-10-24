import {
    CONCURRENCY,
    CONTROL_STATUS,
    CONTROL_TYPE,
    OPERATIONAL_COLLECTIONS,
} from "backend/internalConfig";
import { dalGet, dalInsert, dalUpdate } from "backend/dataAccess";
import { log, makeTraceId } from "backend/logging";

const LOCK_ID = "FISCAL_LEDGER_WRITE_LOCK";
const LOCK_COLLECTION = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const LEASE_MS = Number(CONCURRENCY?.TRANSACTION_LEASE_MS) || 300000;
const MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;
const POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;

function _payload(lock) {
    return lock?.payload && typeof lock.payload === "object" ? lock.payload : {};
}

function _isLive(lock, now) {
    const expiresAt = lock?.expiresAt ? new Date(lock.expiresAt).getTime() : NaN;
    return Number.isFinite(expiresAt) && expiresAt > now &&
        lock?.status === CONTROL_STATUS.ACTIVE &&
        _payload(lock).lockStatus === "ACTIVE";
}

function _buildLock(ownerToken, traceId, now, existing = null) {
    const lock = {
        ...(existing || {}),
        _id: LOCK_ID,
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: LOCK_ID,
        resourceId: "FISCAL_LEDGER",
        status: CONTROL_STATUS.ACTIVE,
        expiresAt: new Date(now + LEASE_MS),
        traceId: traceId || makeTraceId("fiscal-ledger-lock"),
        payload: {
            ..._payload(existing),
            lockName: "FISCAL_LEDGER_WRITE",
            lockStatus: "ACTIVE",
            ownerToken,
            acquiredAt: new Date(now).toISOString(),
        },
        _updatedDate: new Date(now),
    };
    if (!existing) lock._createdDate = new Date(now);
    if (existing?._revision !== undefined) lock._revision = existing._revision;
    return lock;
}

const _delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes fiscal ledger sequence allocation, previous-hash selection and
 * insertion across caja.web.js and eventLog.js. A deterministic CMS _id makes
 * initial acquisition atomic; expired leases are reclaimed with Wix revision
 * concurrency. The lock fails closed when the CMS revision is unavailable.
 */
export async function acquireFiscalLedgerWriteLock(traceId = null) {
    const ownerToken = makeTraceId("fiscal-ledger-owner");
    const deadline = Date.now() + MAX_WAIT_MS;
    let lastError = null;

    while (Date.now() < deadline) {
        const now = Date.now();
        let existing = null;

        try {
            existing = await dalGet(LOCK_COLLECTION, LOCK_ID, "strong");
        } catch (error) {
            lastError = error;
        }

        if (!existing) {
            const candidate = _buildLock(ownerToken, traceId || makeTraceId("fiscal-ledger-lock"), now);
            try {
                await dalInsert(LOCK_COLLECTION, candidate);
                return { ownerToken, lockId: LOCK_ID, traceId: candidate.traceId };
            } catch (error) {
                lastError = error;
                // A competing writer may have inserted the deterministic ID.
                await _delay(25 + Math.floor(Math.random() * 50));
                continue;
            }
        }

        if (_isLive(existing, now)) {
            await _delay(POLL_BASE_MS + Math.floor(Math.random() * 100));
            continue;
        }

        const expiry = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : NaN;
        if (!Number.isFinite(expiry) || expiry > now) {
            // Malformed lease metadata is not safe to steal.
            await _delay(POLL_BASE_MS + Math.floor(Math.random() * 100));
            continue;
        }

        if (existing._revision === undefined || existing._revision === null) {
            lastError = new Error("FISCAL_LEDGER_LOCK_REVISION_UNAVAILABLE");
            await _delay(POLL_BASE_MS + Math.floor(Math.random() * 100));
            continue;
        }

        const candidate = _buildLock(ownerToken, traceId || makeTraceId("fiscal-ledger-lock"), now, existing);
        try {
            await dalUpdate(LOCK_COLLECTION, candidate);
            const verified = await dalGet(LOCK_COLLECTION, LOCK_ID, "strong");
            if (_payload(verified).ownerToken === ownerToken && _isLive(verified, Date.now())) {
                return { ownerToken, lockId: LOCK_ID, traceId: candidate.traceId };
            }
        } catch (error) {
            lastError = error;
        }
        await _delay(25 + Math.floor(Math.random() * 75));
    }

    const error = new Error("FISCAL_LEDGER_BUSY");
    error.code = "FISCAL_LEDGER_BUSY";
    error.cause = lastError || undefined;
    log.warn("Fiscal ledger lock acquisition timed out", {
        traceId,
        message: lastError?.message || null,
    });
    throw error;
}

export async function releaseFiscalLedgerWriteLock(lockHandle) {
    if (!lockHandle?.ownerToken) return false;
    try {
        const existing = await dalGet(LOCK_COLLECTION, LOCK_ID, "strong");
        if (!existing || _payload(existing).ownerToken !== lockHandle.ownerToken) return false;
        if (existing._revision === undefined || existing._revision === null) {
            log.error("Fiscal ledger lock release skipped: CMS revision unavailable", {
                traceId: lockHandle.traceId,
            });
            return false;
        }
        const now = new Date();
        await dalUpdate(LOCK_COLLECTION, {
            ...existing,
            status: CONTROL_STATUS.CLOSED,
            expiresAt: new Date(0),
            payload: {
                ..._payload(existing),
                lockStatus: "RELEASED",
                ownerToken: "",
                releasedAt: now.toISOString(),
            },
            _updatedDate: now,
        });
        return true;
    } catch (error) {
        // A release error must never replace the business result. The lease
        // expires automatically; subsequent writers fail closed while active.
        log.error("Fiscal ledger lock release failed", {
            traceId: lockHandle.traceId,
            message: error?.message || String(error),
        });
        return false;
    }
}
