import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "..", "eventLog.js"), "utf8");
const cashSource = fs.readFileSync(path.resolve(here, "..", "cajas.web.js"), "utf8");

test("FISCAL-DATE-01 normalize date-only input and store Wix CMS DATE values", () => {
  assert.match(source, /function _dateOnly\\(value\\)/);
  assert.match(source, /function _dateOnlyToCmsDate\\(value\\)/);
  assert.match(source, /fechaExpedicionFactura: _dateOnlyToCmsDate\\(canonIssueDate\\)/);
  assert.match(source, /fechaOperacion: _dateOnlyToCmsDate\\(canonOperationDate\\)/);
  assert.match(source, /const canonIssueDate = _dateOnly\\(input\\.fechaExpedicionFactura\\)/);
  assert.match(source, /const canonOperationDate = _dateOnly\\(input\\.fechaOperacion\\) \\|\\| canonIssueDate/);
  assert.match(source, /throw new Error\\("INVALID_FISCAL_DATE"\\)/);
});

test("FISCAL-DATE-02 all direct cash-ledger writers persist CMS DATE values", () => {
  assert.match(cashSource, /function _dateOnlyToCmsDate\\(value\\)/);
  assert.equal(
    (cashSource.match(/fechaExpedicionFactura: _dateOnlyToCmsDate\\(operationDate\\)/g) || []).length,
    3,
    "manual movement, gift-card sale, and gift-card redemption must store DATE values"
  );
  assert.equal(
    (cashSource.match(/fechaOperacion: _dateOnlyToCmsDate\\(operationDate\\)/g) || []).length,
    3,
    "all direct writers must store operationDate as a CMS DATE value"
  );
  // Read paths share the canonical date helper; do not reintroduce raw
  // date queries or legacy field aliases in cashier state/count/Z closing.
  assert.match(cashSource, /function _queryMovementsOfDay\\(day\\)/);
  assert.match(cashSource, /_queryMovementsOfDay\\(day\\)/);
  assert.match(cashSource, /_queryMovementsOfDay\\(diaKey\\)/);
  assert.match(cashSource, /_queryMovementsOfDay\\(cleanDiaKey\\)/);
  assert.doesNotMatch(cashSource, /MOVEMENT_LEGACY_READ_ALIASES\\.fechaExpedicionFactura/);
  assert.match(source, /previousInvoiceIssueDate: _dateOnlyToCmsDate\\(input\\.previousInvoiceIssueDate\\)/);
});
