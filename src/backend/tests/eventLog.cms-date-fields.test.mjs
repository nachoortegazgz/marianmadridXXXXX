import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "..", "eventLog.js"), "utf8");

test("FISCAL-DATE-01 normalize date-only input and store Wix CMS DATE values", () => {
  assert.match(source, /function _dateOnly\(value\)/);
  assert.match(source, /function _dateOnlyToCmsDate\(value\)/);
  assert.match(source, /fechaExpedicionFactura: _dateOnlyToCmsDate\(canonIssueDate\)/);
  assert.match(source, /fechaOperacion: _dateOnlyToCmsDate\(canonOperationDate\)/);
  assert.match(source, /const canonIssueDate = _dateOnly\(input\.fechaExpedicionFactura\)/);
  assert.match(source, /const canonOperationDate = _dateOnly\(input\.fechaOperacion\) \|\| canonIssueDate/);
  assert.match(source, /throw new Error\("INVALID_FISCAL_DATE"\)/);
});
