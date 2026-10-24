import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("SITE-HOME-01 root fallback lives in masterPage and only redirects the root", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pagesDir = join(here, "..", "..", "pages");
  const master = readFileSync(join(pagesDir, "masterPage.js"), "utf8");
  const entrada = readFileSync(join(pagesDir, "Entrada.an12i.js"), "utf8");
  assert.ok(master.includes('import wixLocation from "wix-location-frontend"'));
  assert.ok(master.includes('import { URLS } from "public/mmUtils"'));
  assert.ok(master.includes('const currentUrl = String(wixLocation.url || "")'));
  assert.ok(master.includes('const isRootPath = path === "/"'));
  assert.ok(master.includes('if (isRootPath && URLS?.SERVICIOS === "/reserva-online")'));
  assert.ok(master.includes("wixLocation.to(URLS.SERVICIOS)"));
  assert.ok(!entrada.includes("wixLocation.to"), "page-specific redirect must not affect non-root pages");
});
