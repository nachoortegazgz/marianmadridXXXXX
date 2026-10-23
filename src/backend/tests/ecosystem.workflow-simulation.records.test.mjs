import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recordsPath = path.join(here, "fixtures", "ecosystem-workflow-simulation.records.json");
const data = JSON.parse(fs.readFileSync(recordsPath, "utf8"));

test("ECOSYSTEM-RECORDS-01 all projected agenda/CMS rows are synthetic and barred from production", () => {
  assert.equal(data.manifest.environment, "OFFLINE_FIXTURE_ONLY");
  assert.equal(data.manifest.isSynthetic, true);
  assert.equal(data.manifest.doNotImportToProduction, true);
  assert.equal(data.manifest.legalStatus, "SIMULATION_NOT_A_REAL_OPERATION");
  assert.ok(data.agenda.length >= 3);
  assert.ok(data.cms.length >= 8);
  for (const row of [...data.agenda, ...data.cms, ...data.eventTraces]) {
    assert.equal(row.synthetic, true, `${row.recordId || row.eventId} must be synthetic`);
    assert.match(row.traceId, /^qa-20261023-/);
    assert.doesNotMatch(JSON.stringify(row), /@|\+34\d{9}/);
  }
});

test("ECOSYSTEM-RECORDS-02 projected PGC and fiscal records are explicitly blocked", () => {
  const pgc = data.cms.find((row) => row.scenarioId === "ACC-01");
  const giftCard = data.cms.find((row) => row.scenarioId === "GC-01");
  const pos = data.cms.find((row) => row.scenarioId === "POS-01");
  assert.equal(pgc.journalCreated, false);
  assert.equal(pgc.status, "BLOCKED_PENDING_APPROVAL");
  assert.equal(giftCard.status, "BLOCKED_PENDING_APPROVAL");
  assert.equal(pos.fiscalDocumentStatus, "NOT_ISSUED_IN_SIMULATION");
});

test("ECOSYSTEM-RECORDS-03 stock and close projections preserve arithmetic and scope", () => {
  const stock = data.cms.find((row) => row.collection === "InventarioStockVenta");
  const close = data.cms.find((row) => row.collection === "HistoricoCierresZ");
  assert.equal(stock.stockAvailable, stock.stockOnHand - stock.stockReserved);
  assert.ok(Array.isArray(close.includedMovementIds));
  assert.ok(Array.isArray(close.excludedMovementIds));
  assert.equal(close.snapshotHash, "QA-ONLY-NOT-A-FISCAL-HASH");
});

test("ECOSYSTEM-RECORDS-04 agenda fixtures cannot send notifications or masquerade as live bookings", () => {
  for (const booking of data.agenda) {
    assert.match(booking.status, /^SIMULATED_/);
    assert.equal(booking.notificationsAllowed, false);
  }
});

test("ECOSYSTEM-RECORDS-05 review checklist covers critical cross-system safeguards", () => {
  const ids = data.reviewChecklist.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["R01","R02","R03","R04","R05","R06","R07","R08","R09","R10"]) {
    assert.ok(ids.includes(id));
  }
});
