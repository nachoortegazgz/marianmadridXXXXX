import test from "node:test";
import assert from "node:assert/strict";

const internalConfig = await import("backend/internalConfig");
const bookingUtils = await import("backend/booking/bookingUtils");
const mmUtils = await import("public/mmUtils");

test("DEBT-ZERO-01 retired internalConfig aliases stay absent", () => {
  for (const name of [
    "COLLECTIONS",
    "RECORDTYPECONFIGSISTEMA",
    "INACTIVE_BOOKING_STATUSES",
    "buildInvoiceNumber",
  ]) {
    assert.equal(name in internalConfig, false, `${name} must not return as a legacy alias`);
  }
});

test("DEBT-ZERO-02 retired booking utility aliases stay absent", () => {
  assert.equal("resolveNativeAddOnIds" in bookingUtils, false);
  assert.equal("resolveAddOnIds" in bookingUtils, false);
});

test("DEBT-ZERO-03 unused mmUtils helpers stay out of the public export surface", () => {
  for (const name of [
    "getReferenceIds",
    "cleanGuid",
    "booleanValue",
    "toBoolean",
    "toMadridIsoLocal",
    "formatUtcOffset",
    "isPlainObject",
    "buildLocalDateRange",
    "getMadridTime",
    "getMadridMonthKey",
    "_normalizeAscii",
    "SITE",
    "CURRENCY_CONFIG",
  ]) {
    assert.equal(name in mmUtils, false, `${name} must not be exported without a consumer`);
  }
});

test("DEBT-ZERO-04 cash register status exposes only canonical values", () => {
  assert.deepEqual(
    Object.keys(internalConfig.CASH_REGISTER_STATUS).sort(),
    ["ABIERTA", "CERRADA"]
  );
});

test("DEBT-ZERO-05 inventory writer documents and enforces canonical fields only", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "inventario.web.js"), "utf8");
  assert.doesNotMatch(source, /fallback a nombres legacy \(eventoOrigenId, catalogoId, terceroId\)/);
  assert.doesNotMatch(source, /meta\.(eventoOrigenId|catalogoId|terceroId)/);
  assert.doesNotMatch(source, /stockItem\.stockExpected/);
  assert.match(source, /No fallback to the retired stockExpected field/);
});


test("DEBT-ZERO-06 MapaStaff uses canonical Wix Bookings identity before transitional field", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "staff.js"), "utf8");
  assert.ok(source.includes("staffMemberId: _safeTrim(mapping.wixStaffMemberId || mapping.staffMemberId || staff.staffMemberId)"));
  assert.ok(source.includes("const roleWebsite = _safeTrim(mapping.rolWebsite).toUpperCase()"));
  assert.ok(source.includes('allowedRoles.has(roleWebsite) ? roleWebsite : ""'));
});
