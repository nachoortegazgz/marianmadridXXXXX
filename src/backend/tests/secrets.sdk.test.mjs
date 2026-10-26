import test from "node:test";
import assert from "node:assert/strict";

test("Wix Secrets SDK adapter returns the secret string, not the response object", async () => {
  const state = globalThis.__mmSecretsState || (globalThis.__mmSecretsState = { _map: {}, _default: "mock-secret" });
  state._map.SECRET_FISCALKEY = "fiscal-test-key";
  state._map.EMPTY_SECRET = "";
  state._map.MALFORMED_SECRET = null;
  const { getSecretValue } = await import("backend/secretVault");

  assert.equal(await getSecretValue("SECRET_FISCALKEY"), "fiscal-test-key");
  await assert.rejects(() => getSecretValue("EMPTY_SECRET"), { message: "SECRET_VALUE_UNAVAILABLE" });
  await assert.rejects(() => getSecretValue("MALFORMED_SECRET"), { message: "SECRET_VALUE_UNAVAILABLE" });
  await assert.rejects(() => getSecretValue("  "), { message: "SECRET_NAME_REQUIRED" });
});


test("Secrets SDK migration has no legacy consumers", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const consumers = [
    "cajas.web.js",
    "events.js",
    "fiscalDocuments.web.js",
    "inventario.web.js",
    "marianAssistant.web.js",
    "securityEngine.js",
  ];

  for (const filename of consumers) {
    const source = readFileSync(resolve(here, "..", filename), "utf8");
    assert.match(source, /from ["']backend\/secretVault["']/,
      filename + " must use the central Secrets SDK adapter");
    assert.doesNotMatch(source, /wix-secrets-backend|\bgetSecret\s*\(/,
      filename + " must not use the legacy Secrets API");
  }
});
