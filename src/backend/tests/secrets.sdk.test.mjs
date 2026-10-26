import test from "node:test";
import assert from "node:assert/strict";

test("Wix Secrets SDK adapter returns the secret string, not the response object", async () => {
  const state = globalThis.__mmSecretsState || (globalThis.__mmSecretsState = { _map: {}, _default: "mock-secret" });
  state._map.SECRET_FISCALKEY = "fiscal-test-key";
  state._map.EMPTY_SECRET = "";
  state._map.MALFORMED_SECRET = null;
  const { getSecretValue } = await import("backend/secretVault");

  assert.equal(await getSecretValue("SECRET_FISCALKEY"), "fiscal-test-key");
  assert.equal(await getSecretValue("UNKNOWN_SECRET"), "mock-secret");
  await assert.rejects(() => getSecretValue("EMPTY_SECRET"), { message: "SECRET_VALUE_UNAVAILABLE" });
  await assert.rejects(() => getSecretValue("MALFORMED_SECRET"), { message: "SECRET_VALUE_UNAVAILABLE" });
  await assert.rejects(() => getSecretValue("  "), { message: "SECRET_NAME_REQUIRED" });
});
