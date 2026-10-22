import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "..");
const cashSource = fs.readFileSync(path.join(backendDir, "cajas.web.js"), "utf8");
const hooksSource = fs.readFileSync(path.join(backendDir, "data.js"), "utf8");

function extractObject(source, anchor) {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `missing source anchor: ${anchor}`);
  const end = source.indexOf("const saved = await dalInsert", start);
  assert.ok(end > start, "missing end of Z record writer");
  return source.slice(start, end);
}

test("Z-CLOSE-SCHEMA-01 writer persists every required canonical CMS field", () => {
  const record = extractObject(cashSource, "const zRecord =");
  for (const field of [
    "closeDate",
    "operationDate",
    "fiscalPeriod",
    "closedBy",
    "recordDomain",
    "snapshotJson",
    "totalCash",
    "totalCard",
    "totalBizum",
    "totalOnline",
    "totalTaxBase",
    "totalTaxAmount",
    "traceId",
  ]) {
    assert.match(record, new RegExp(`\\b${field}\\s*(?:,|:)`), `zRecord must persist ${field}`);
  }
  assert.match(record, /closeDate:\s*new Date\(/);
  assert.match(record, /operationDate:\s*new Date\(/);
  assert.match(record, /snapshotJson:\s*_stableSerialize\(auditSnapshot\)/);
});

test("Z-CLOSE-ACTOR-01 manual close records authenticated staff; cron close records system actor", () => {
  assert.match(cashSource, /currentMember\.getMember\(\)/);
  assert.match(cashSource, /findStaffByContactId\(contactId, traceId\)/);
  assert.match(cashSource, /return \{ closedBy: "SYSTEM_CRON", recordDomain: "SYSTEM" \}/);
  assert.match(cashSource, /closedBy: closingActor\.closedBy/);
  assert.match(cashSource, /recordDomain: closingActor\.recordDomain/);
});

test("Z-CLOSE-TRACE-01 append-only CMS hook requires a traceId", () => {
  const start = hooksSource.indexOf("export function HistoricoCierresZ_beforeInsert");
  assert.ok(start >= 0);
  const hook = hooksSource.slice(start, start + 500);
  assert.match(hook, /traceId obligatorio en HistoricoCierresZ/);
});
