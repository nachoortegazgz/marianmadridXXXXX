import test from "node:test";
import assert from "node:assert/strict";

test("Wix Secrets SDK adapter returns the secret string, not the response object", async () => {
  const state = globalThis.__mmSecretsState || (globalThis.__mmSecretsState = { _map: {}, _default: "mock-secret" });
  state._map.SECRET_FISCALKEY = "fiscal-test-key";
  state._map.EMPTY_SECRET = "";
  const { getSecretValue } = await import("backend/secretVault");

  assert.equal(await getSecretValue("SECRET_FISCALKEY"), "fiscal-test-key");
  assert.equal(await getSecretValue("UNKNOWN_SECRET"), "mock-secret");
  assert.equal(await getSecretValue("EMPTY_SECRET"), "");
  await assert.rejects(() => getSecretValue("  "), { message: "SECRET_NAME_REQUIRED" });
});
