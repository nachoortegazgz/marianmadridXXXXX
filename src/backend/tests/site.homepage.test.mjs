import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("SITE-HOME-01 placeholder home routes to the canonical service catalog", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "..", "pages", "Entrada.an12i.js"), "utf8");
  assert.ok(source.includes('import wixLocation from "wix-location-frontend"'));
  assert.ok(source.includes('import { URLS } from "public/mmUtils"'));
  assert.ok(source.includes('target === "/reserva-online"'));
  assert.ok(source.includes("wixLocation.to(target)"));
});
