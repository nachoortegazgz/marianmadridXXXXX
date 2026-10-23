import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "ecosystem-workflow-simulation.fixture.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("ECOSYSTEM-QA-01 fixture is explicitly isolated from production", () => {
  assert.equal(fixture.generatedFor, "QA_ONLY_SYNTHETIC");
  assert.equal(fixture.doNotImportToProduction, true);
  assert.equal(fixture.currency, "EUR");
  assert.equal(fixture.timezone, "Europe/Madrid");
});

test("ECOSYSTEM-QA-02 all critical workflow families have unique trace and scenario IDs", () => {
  const required = ["BK-01", "BK-02", "BK-03", "PAY-01", "PAY-02", "CAN-01", "POS-01", "STO-01", "GC-01", "CASH-01", "TIME-01", "ACC-01"];
  const ids = fixture.scenarios.map((s) => s.scenarioId);
  const traces = fixture.scenarios.map((s) => s.traceId);
  assert.deepEqual(ids, required);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(traces).size, traces.length);
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.title);
    assert.ok(scenario.syntheticInput);
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length >= 2);
    assert.ok(Array.isArray(scenario.expectedCollections));
    assert.ok(Array.isArray(scenario.invariants) && scenario.invariants.length > 0);
    for (const step of scenario.steps) {
      assert.ok(Number.isInteger(step.n));
      assert.ok(step.action);
      assert.ok(Array.isArray(step.writes));
    }
  }
});

test("ECOSYSTEM-QA-03 no scenario can treat unapproved accounting or tax rules as certified", () => {
  const pgc = fixture.scenarios.find((s) => s.scenarioId === "ACC-01");
  const giftCard = fixture.scenarios.find((s) => s.scenarioId === "GC-01");
  const serviceSale = fixture.scenarios.find((s) => s.scenarioId === "POS-01");
  assert.equal(pgc.expectedStatus, "EXPECTED_SAFE_BLOCK");
  assert.equal(pgc.syntheticInput.journalShouldBeCreated, false);
  assert.equal(giftCard.expectedStatus, "BLOCKED_PENDING_TAX_RULE");
  assert.ok(giftCard.invariants.some((i) => i.includes("not guessed")));
  assert.ok(serviceSale.invariants.some((i) => i.includes("unapproved PGC")));
});

test("ECOSYSTEM-QA-04 payment, booking, stock and cash scenarios require idempotency", () => {
  const byId = Object.fromEntries(fixture.scenarios.map((s) => [s.scenarioId, s]));
  for (const id of ["BK-01", "BK-02", "PAY-01", "PAY-02", "CAN-01", "STO-01", "CASH-01"]) {
    assert.ok(
      byId[id].invariants.some((i) => /idempotent|duplicate|twice|duplicat|duplicate|same scheduled period/i.test(i)),
      `${id} must explicitly cover idempotency/duplicate protection`,
    );
  }
});

test("ECOSYSTEM-QA-05 fixture distinguishes simulated expectations from real execution", () => {
  for (const scenario of fixture.scenarios) {
    assert.match(scenario.expectedStatus, /PASS_IF_REAL_BACKEND_CONFIRMS|MUST_PROVE_COMPENSATION|KNOWN_RECONCILIATION_PATH|KNOWN_PGC_BLOCK|BLOCKED_PENDING_TAX_RULE|EXPECTED_SAFE_BLOCK/);
  }
});
