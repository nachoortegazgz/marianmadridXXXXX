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
