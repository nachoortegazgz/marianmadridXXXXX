/*
=============================================================================
MODULE: backend/crons.js
VERSION: v5010-TELEMETRY-ATOMIC
BASE: v5009-FISCAL-V20.1 + correcciones auditoría P1/P2 (CRON-07..CRON-14)
RESPONSIBILITY: Jobs programados (cron). 6 crons existentes + 3 nuevos de
reconciliación.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero COLLECTIONS alias.

CORRECCIONES v5010-TELEMETRY-ATOMIC:
CRON-07 (P0): Reemplazo COLLECTIONS por BUSINESS_COLLECTIONS y
OPERATIONAL_COLLECTIONS (internalConfig v12).
CRON-08 (P0): Migración completa a backend/dataAccess. Cero wixData directo.
Cero suppressAuth. Lecturas con consistencyMode:"strong".
CRON-09 (P2): Contadores precisos: solo incrementan tras éxito confirmado.
CRON-10 (P2): Retorno de removed, failed y muestras de errores.
CRON-11 (P1): Nuevo job reconcileUnknownTransactions para reconciliar
transacciones RESULT_UNKNOWN de bookingSaga.
CRON-12 (P1): Nuevo job reconcileInconsistentDualPairs para reconciliar
pares duales marcados como DUAL_INCONSISTENT.
CRON-13 (P1): Nuevo job retryCompletionRequired para reintentar
_completeTransaction en transacciones COMPLETION_RETRY_REQUIRED.
CRON-14 (P2): Eliminación de referencia a COLLECTIONS.ALERTAS_OPERATIVAS
(no existe en internalConfig v12).

FIXES HEREDADOS v5009-FISCAL-V20.1: CRON-01..CRON-06.
PENDIENTES:
- Actualizar jobs.config con los 3 nuevos jobs.
- Verificar que dataAccess soporta todas las operaciones necesarias.
=============================================================================
*/
import { query as dalQuery, insertItem as dalInsert, updateItem as dalUpdate, removeById as dalRemove } from "backend/dataAccess";
import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
import {
BUSINESS_COLLECTIONS,
OPERATIONAL_COLLECTIONS,
CONTROL_TYPE,
CONCURRENCY,
SDK_CONFIG,
} from "backend/internalConfig";
import { makeTraceId, _safeTrim, _looksLikeGuid, withTimeout } from "public/mmUtils";
import { logger } from "backend/logger";
import { verifyFiscalHashChainIntegrity } from "backend/cajas.web";
import { cancelBookingElevated } from "backend/booking/bookingCore";
import { reconcileUnknownTransaction } from "backend/events";

const log = logger;
const API_TIMEOUT_MS =
Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const MAX_COMPENSATION_ATTEMPTS =
Math.max(1, Number(CONCURRENCY?.MAX_COMPENSATION_RETRIES) || 3);

// CRON-08: elevatedGet para reconciliación
const getBookingElevated = auth.elevate(bookings.getBooking);

// =============================================================================
// CRON 1: cleanExpiredLocks - 15 * * * *
// =============================================================================
/**
* CRON-09/10: contadores precisos. Solo incrementa tras éxito confirmado.
* Retorna removed, failed y muestras de errores.
*/
export async function cleanExpiredLocks() {
const traceId = makeTraceId("cron-locks");
const result = { removed: 0, failed: 0, errors: [] };

try {
const now = new Date();
const res = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.SLOT_LOCK)
.lt("expiresAt", now)
.limit(100)
.find({ consistencyMode: "strong" });

for (const item of res?.items || []) {
try {
await dalRemove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id);
result.removed++;
} catch (removeError) {
result.failed++;
if (result.errors.length < 5) {
result.errors.push({
id: item._id,
error: removeError?.message || "UNKNOWN",
});
}
log.warn("cleanExpiredLocks: remove failed", {
lockId: item._id,
error: removeError?.message,
traceId,
});
}
}

log.info("cleanExpiredLocks completed", {
removed: result.removed,
failed: result.failed,
traceId,
});
} catch (err) {
log.error("cleanExpiredLocks failed", { error: err?.message, traceId });
result.errors.push({ query: "main", error: err?.message });
}

return result;
}

// =============================================================================
// CRON 2: cleanupExpiredDualCache - 20 * * * *
// =============================================================================
/**
* CRON-09/10: contadores precisos. Solo incrementa tras éxito confirmado.
*/
export async function cleanupExpiredDualCache() {
const traceId = makeTraceId("cron-dual-cache");
const result = { removed: 0, failed: 0, errors: [] };

try {
const now = new Date();
const limit =
Number(SDK_CONFIG?.JOBS?.DUAL_CACHE_CLEANUP_LIMIT) || 100;
const res = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.DUAL_CACHE)
.lt("expiresAt", now)
.limit(limit)
.find({ consistencyMode: "strong" });

for (const item of res?.items || []) {
try {
await dalRemove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id);
result.removed++;
} catch (removeError) {
result.failed++;
if (result.errors.length < 5) {
result.errors.push({
id: item._id,
error: removeError?.message || "UNKNOWN",
});
}
log.warn("cleanupExpiredDualCache: remove failed", {
cacheId: item._id,
error: removeError?.message,
traceId,
});
}
}

log.info("cleanupExpiredDualCache completed", {
removed: result.removed,
failed: result.failed,
traceId,
});
} catch (err) {
log.error("cleanupExpiredDualCache failed", {
error: err?.message,
traceId,
});
result.errors.push({ query: "main", error: err?.message });
}

return result;
}

// =============================================================================
// CRON 3: runPendingCompensationsJob - 30 * * * *
// =============================================================================
async function _runOneCompensation(comp, traceId) {
const payload = JSON.parse(comp?.payloadJson || "{}");
const kind = _safeTrim(payload.compensationKind || payload.kind).toUpperCase();
const bookingId = _safeTrim(payload.bookingId || comp?.bookingId);

if (kind === "CANCEL_BOOKING") {
if (!bookingId || !_looksLikeGuid(bookingId)) {
throw new Error("CANCEL_BOOKING requires a valid bookingId GUID");
}
await withTimeout(
() =>
cancelBookingElevated(bookingId, {
// CRON-08: cero suppressAuth. auth.elevate ya eleva.
}),
API_TIMEOUT_MS,
"cron:cancelBookingCompensation"
);
return { ok: true, action: "CANCEL_BOOKING", bookingId };
}

if (kind === "FISCAL_LEDGER" || kind === "RESYNC_LEDGER_ACCOUNTING") {
try {
const { registerBookingPayment } = await import("backend/cajas.web");
const amount = Number(payload.totalAmount || comp?.totalAmount);
const hasAmount = Number.isFinite(amount) && amount !== 0;
const transactionId = _safeTrim(payload.transactionId || comp?.transactionId);
const bookingIds = payload.bookingIds || payload.bookingId || comp?.bookingIds || comp?.bookingId || null;

if (kind === "FISCAL_LEDGER" && hasAmount && transactionId) {
const result = await withTimeout(
() =>
registerBookingPayment(bookingIds, amount, payload.paymentMethod || "ONLINE", {
operationDescription: payload.operationDescription || "Fiscal recovery retry",
transactionId: transactionId,
orderId: payload.orderId || null,
refundId: payload.refundId || null,
tipoMovimiento: payload.movementType || null,
origen: "CRON_FISCAL_RECOVERY",
resourceId: "online",
traceId: traceId,
}),
API_TIMEOUT_MS,
"cron:fiscalLedgerRecovery"
);
if (result?.status === "SUCCESS") {
return { ok: true, action: kind, transactionId };
}
throw new Error(
(result && result.error && result.error.message) ||
"FISCAL_LEDGER recovery returned non-SUCCESS"
);
}
throw new Error(
kind +
" requires manual or extended processor (payload incomplete or RESYNC)"
);
} catch (err) {
throw err;
}
}

throw new Error(`Unsupported compensation kind: ${kind || "UNKNOWN"}`);
}

/**
* CRON-09/10: contadores precisos. Solo incrementa tras éxito confirmado.
* CRON-14: eliminada referencia a COLLECTIONS.ALERTAS_OPERATIVAS.
*/
export async function runPendingCompensationsJob() {
const traceId = makeTraceId("cron-comp");
const result = { processed: 0, failed: 0, errors: [] };

try {
const batchSize =
Number(SDK_CONFIG?.JOBS?.FISCAL_RECOVERY_BATCH_SIZE) || 25;
const statuses = ["PENDING", "RETRYING", "PENDING_RECOVERY"];

const queryResults = await Promise.all(
statuses.map((status) =>
dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.COMPENSATION)
.eq("status", status)
.lt("attempts", MAX_COMPENSATION_ATTEMPTS)
.limit(batchSize)
.find({ consistencyMode: "strong" })
)
);

const seenIds = new Set();
const compensationItems = queryResults
.flatMap((res) => res?.items || [])
.filter((item) => {
if (!item?._id || seenIds.has(item._id)) return false;
seenIds.add(item._id);
return true;
})
.sort((a, b) =>
new Date(a?._createdDate || 0).getTime() -
new Date(b?._createdDate || 0).getTime()
)
.slice(0, batchSize);

for (const comp of compensationItems) {
try {
await _runOneCompensation(comp, traceId);
const payload = JSON.parse(comp?.payloadJson || "{}");
payload.status = "COMPLETED";
payload.lastError = null;
payload._updatedDate = new Date();
await dalUpdate(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
...comp,
payloadJson: JSON.stringify(payload),
});
result.processed++;
} catch (compErr) {
const payload = JSON.parse(comp?.payloadJson || "{}");
const attempts = Number(payload.attempts || comp.attempts || 0) + 1;
payload.attempts = attempts;
payload.lastError = compErr?.message || "UNKNOWN";
payload.status =
attempts >= MAX_COMPENSATION_ATTEMPTS ? "FAILED" : "RETRYING";
payload._updatedDate = new Date();

try {
await dalUpdate(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
...comp,
payloadJson: JSON.stringify(payload),
});
} catch (updateError) {
log.error("runPendingCompensationsJob: update failed", {
compId: comp._id,
error: updateError?.message,
traceId,
});
}

result.failed++;
if (result.errors.length < 10) {
result.errors.push({
compId: comp._id,
error: compErr?.message || "UNKNOWN",
});
}

// CRON-14: eliminada inserción en COLLECTIONS.ALERTAS_OPERATIVAS
// (no existe en internalConfig v12). Solo log.
if (payload.status === "FAILED") {
log.error("CRON-14: compensation failed permanently", {
compId: comp._id,
kind: payload.compensationKind || payload.kind,
error: payload.lastError,
traceId,
});
}
}
}

log.info("runPendingCompensationsJob completed", {
processed: result.processed,
failed: result.failed,
traceId,
});
} catch (err) {
log.error("runPendingCompensationsJob failed", {
error: err?.message,
traceId,
});
result.errors.push({ query: "main", error: err?.message });
}

return result;
}

// =============================================================================
// CRON 4: cleanExpiredDaysCache - 0 1 * * *
// =============================================================================
/**
* CRON-09/10: contadores precisos. Solo incrementa tras éxito confirmado.
*/
export async function cleanExpiredDaysCache() {
const traceId = makeTraceId("cron-days-cache");
const result = { removed: 0, failed: 0, errors: [] };

try {
const now = new Date();
const res = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.DAYS_CACHE)
.lt("expiresAt", now)
.limit(200)
.find({ consistencyMode: "strong" });

for (const item of res?.items || []) {
try {
await dalRemove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id);
result.removed++;
} catch (removeError) {
result.failed++;
if (result.errors.length < 5) {
result.errors.push({
id: item._id,
error: removeError?.message || "UNKNOWN",
});
}
log.warn("cleanExpiredDaysCache: remove failed", {
cacheId: item._id,
error: removeError?.message,
traceId,
});
}
}

log.info("cleanExpiredDaysCache completed", {
removed: result.removed,
failed: result.failed,
traceId,
});
} catch (err) {
log.error("cleanExpiredDaysCache failed", {
error: err?.message,
traceId,
});
result.errors.push({ query: "main", error: err?.message });
}

return result;
}

// =============================================================================
// CRON 5: cleanExpiredSlotsCache - 10 1 * * *
// =============================================================================
export async function cleanExpiredSlotsCache() {
const traceId = makeTraceId("cron-slots-cache");
try {
log.info(
"cleanExpiredSlotsCache completed (RAM cache auto-resets on cold start)", { traceId }
);
} catch (err) {
log.error("cleanExpiredSlotsCache failed", {
error: err?.message,
traceId,
});
}
return { removed: 0, failed: 0, errors: [] };
}

// =============================================================================
// CRON 6: systemHealthCheck - 0 7 * * *
// =============================================================================
/**
* CRON-14: eliminada inserción en COLLECTIONS.ALERTAS_OPERATIVAS.
* Solo log de issues.
*/
export async function systemHealthCheck() {
const traceId = makeTraceId("cron-health");
const result = {
timestamp: new Date().toISOString(),
collections: {},
fiscalChain: null,
secrets: {},
issues: [],
};

try {
const criticalCols = [
BUSINESS_COLLECTIONS.CITAS_F2,
BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA,
OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
BUSINESS_COLLECTIONS.MAPA_STAFF,
];

for (const col of criticalCols) {
try {
const count = await dalQuery(col).limit(1).count();
result.collections[col] = { accessible: true, count };
} catch (err) {
result.collections[col] = { accessible: false, count: 0 };
result.issues.push({
type: "COLLECTION_INACCESSIBLE",
collection: col,
error: err?.message,
});
}
}

try {
const chainResult = await verifyFiscalHashChainIntegrity({
traceId,
limit: 100,
});
result.fiscalChain = chainResult.status;
if (chainResult.status !== "SUCCESS") {
result.issues.push({
type: "FISCAL_CHAIN_BROKEN",
status: chainResult.status,
});
}
} catch (err) {
result.fiscalChain = "ERROR";
result.issues.push({
type: "FISCAL_CHAIN_CHECK_FAILED",
error: err?.message,
});
}

log.info("systemHealthCheck completed", { result, traceId });

// CRON-14: eliminada inserción en COLLECTIONS.ALERTAS_OPERATIVAS
if (result.issues.length > 0) {
log.error("CRON-14: systemHealthCheck detected issues", {
issues: result.issues,
traceId,
});
}
} catch (err) {
log.error("systemHealthCheck failed", { error: err?.message, traceId });
result.issues.push({
type: "HEALTH_CHECK_FAILED",
error: err?.message,
});
}

return result;
}

// =============================================================================
// CRON 11: reconcileUnknownTransactions - 45 * * * * (NUEVO)
// =============================================================================
/**
* CRON-11: reconcilia transacciones RESULT_UNKNOWN de bookingSaga.
* Busca en ControlOperativo transacciones con status RESULT_UNKNOWN
* y llama a events.reconcileUnknownTransaction para verificar si
* la reserva se creó realmente en Bookings.
*/
export async function reconcileUnknownTransactions() {
const traceId = makeTraceId("cron-reconcile-unknown");
const result = { processed: 0, reconciled: 0, failed: 0, errors: [] };

try {
const res = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.IDEMPOTENCY)
.limit(50)
.find({ consistencyMode: "strong" });

for (const tx of res?.items || []) {
try {
const payload = JSON.parse(tx?.payloadJson || "{}");
if (payload.status !== "RESULT_UNKNOWN") continue;

result.processed++;
const reconciliation = await reconcileUnknownTransaction(tx._id, traceId);

if (reconciliation.ok) {
if (reconciliation.reconciled) {
result.reconciled++;
} else {
result.failed++;
if (result.errors.length < 10) {
result.errors.push({
pairToken: tx._id,
reason: reconciliation.reason || "UNKNOWN",
});
}
}
} else {
result.failed++;
if (result.errors.length < 10) {
result.errors.push({
pairToken: tx._id,
reason: reconciliation.reason || "RECONCILIATION_FAILED",
});
}
}
} catch (txError) {
result.failed++;
if (result.errors.length < 10) {
result.errors.push({
pairToken: tx._id,
error: txError?.message || "UNKNOWN",
});
}
log.warn("reconcileUnknownTransactions: tx failed", {
pairToken: tx._id,
error: txError?.message,
traceId,
});
}
}

log.info("reconcileUnknownTransactions completed", {
processed: result.processed,
reconciled: result.reconciled,
failed: result.failed,
traceId,
});
} catch (err) {
log.error("reconcileUnknownTransactions failed", {
error: err?.message,
traceId,
});
result.errors.push({ query: "main", error: err?.message });
}

return result;
}

// =============================================================================
// CRON 12: reconcileInconsistentDualPairs - 50 * * * * (NUEVO)
// =============================================================================
/**
* CRON-12: reconcilia pares duales marcados como DUAL_INCONSISTENT.
* Busca en ControlOperativo flags con reason DUAL_INCONSISTENT
* y verifica el estado real de F1/F2 en Bookings y CMS.
*/
export async function reconcileInconsistentDualPairs() {
const traceId = makeTraceId("cron-reconcile-dual");
const result = { processed: 0, reconciled: 0, failed: 0, errors: [] };

try {
const res = await dalQuery(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
.eq("controlType", CONTROL_TYPE.SYSTEM_FLAG)
.limit(50)
.find({ consistencyMode: "strong" });

for (const flag of res?.items || []) {
try {
const payload = JSON.parse(flag?.payloadJson || "{}");
if (payload.reason !== "DUAL_INCONSISTENT" &&
payload.status !== "REPAIR_REQUIRED") continue;

result.processed++;
const pairToken = _safeTrim(payload.pairToken || flag?.pairToken);

if (!pairToken) {
result.failed++;
continue;
}

// Consultar CitasF2 para verificar estado del par
const citas = await dalQuery(BUSINESS_COLLECTIONS.CITAS_F2)
.eq(BOOKING_FIELDS.PAIR_TOKEN, pairToken)
.limit(10)
.find({ consistencyMode: "strong" });

const f1Cita = citas?.items?.find(c =>
c.bookingType === "DUAL_F1" || !c.meta?.linkedF1BookingId
);
const f2Cita = citas?.items?.find(c =>
c.bookingType === "DUAL_F2" || c.meta?.linkedF1BookingId
);

if (!f1Cita || !f2Cita) {
log.warn("reconcileInconsistentDualPairs: missing cita", {
pairToken,
hasF1: !!f1Cita,
hasF2: !!f2Cita,
traceId,
});
result.failed++;
continue;
}

// Verificar estado en Bookings
let f1Exists = false;
let f2Exists = false
