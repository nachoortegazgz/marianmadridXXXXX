import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..");
const read = (relativePath) => readFileSync(join(backend, relativePath), "utf8");

test("SDK-LAZY-01 Bookings, eCommerce, CRM, Secrets and cron methods are not eagerly elevated", () => {
  const sources = [
    ["booking/bookingCore.js", read("booking/bookingCore.js")],
    ["booking/bookingSaga.js", read("booking/bookingSaga.js")],
    ["crons.js", read("crons.js")],
    ["staff.js", read("staff.js")],
    ["secretVault.js", read("secretVault.js")],
  ];

  const directSdkElevation = /auth\\.elevate\\(\\s*(?:bookings|cartV2|staffMembers|contactsV5|secrets)\\./;
  for (const [path, source] of sources) {
    assert.doesNotMatch(source, directSdkElevation, path + " must resolve SDK methods inside a callable wrapper");
  }
});

test("SDK-LAZY-02 elevated SDK wrappers validate callable operations and defer proxy invocation", () => {
  const sources = [
    read("booking/bookingCore.js"),
    read("booking/bookingSaga.js"),
    read("crons.js"),
    read("staff.js"),
    read("secretVault.js"),
  ];

  for (const source of sources) {
    assert.match(source, /auth\\.elevate\\(function \\(\\.\\.\\.runtimeArgs\\)/);
    assert.match(source, /typeof operation !== "function"/);
    assert.match(source, /typeof elevatedOperation !== "function"/);
  }
});
