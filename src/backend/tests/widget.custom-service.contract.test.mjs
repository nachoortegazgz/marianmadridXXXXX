import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const page = readFileSync(join(root, "src", "pages", "#htmlWidgetCustomService.txt"), "utf8");
const velo = readFileSync(join(root, "src", "pages", "Pagina de servicio 2.xnfr4.js"), "utf8");
const bridge = readFileSync(join(root, "src", "public", "widgetBridge.js"), "utf8");

test("WIDGET-SERVICE-01 canonical service widget parses and exposes the current UI elements", () => {
  assert.match(page, /<html lang="es">/);
  for (const id of ["serviceTitle", "btnBookNow", "addonsContainer", "serviceDescription"]) {
    assert.ok(page.includes('id="' + id + '"'), "widget must contain #" + id);
  }
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "one inline script is expected");
  assert.doesNotThrow(() => new Function(scripts[0][1]), "inline script must parse");
});

test("WIDGET-SERVICE-02 uses the current Velo bridge protocol and validates incoming messages", () => {
  for (const type of ["MM_READY", "MM_CONTEXT", "MM_BOOK", "MM_NAV"]) {
    assert.ok(page.includes('"' + type + '"'), "widget must support " + type);
  }
  assert.match(page, /window\.parent\.postMessage/);
  assert.match(page, /isTrustedOrigin\(event\.origin\)/);
  assert.match(page, /parsed\.protocol !== "https:"/);
  assert.match(page, /CONFIG\.PARENT_ORIGIN = resolveParentOrigin\(\)/);
  assert.match(page, /new URL\(origin\)\.protocol === "https:" && isTrustedOrigin\(origin\)/);
  assert.match(page, /Number\(message\.version\) !== CONFIG\.PROTOCOL_VERSION/);
  assert.match(page, /messageId: createMessageId\(\)/);
  assert.match(bridge, /READY: "MM_READY"/);
  assert.match(bridge, /CONTEXT: "MM_CONTEXT"/);
  assert.match(velo, /onContextReady: async/);
  assert.match(velo, /createWidgetBridge\(widget,\s*\{/);
});

test("WIDGET-SERVICE-03 booking sends only allowed add-on IDs and the plan-specific ID", () => {
  assert.match(page, /const bookPayload = \{[\s\S]*addOnIds: Array\.from\(state\.selectedAddonIds\)/);
  assert.match(page, /state\.catalogEntryType === "PRICING_PLAN" && state\.pricingPlanId/);
  assert.match(page, /bookPayload\.pricingPlanId = state\.pricingPlanId/);
  assert.doesNotMatch(page, /resourceId\s*:/, "the public widget must not choose or send a staff resource");
  assert.doesNotMatch(page, /staffName|staffMemberId|wixStaffMemberId/, "internal staff identities must not be exposed");
  assert.match(velo, /buildBookingUrl\(/);
  assert.match(velo, /getAddOnIds\(\s*payload,\s*service\s*\)/);
});

test("WIDGET-SERVICE-04 renders CMS strings as text and rejects hidden or invalid catalog entries", () => {
  assert.match(page, /el\("serviceTitle"\)\.textContent = title/);
  assert.match(page, /catalogEntryType === "PRICING_PLAN"/);
  assert.match(page, /service\.clientHidden === true/);
  assert.doesNotMatch(page, /innerHTML\s*=/, "untrusted CMS strings must not be inserted as HTML");
});

test("WIDGET-SERVICE-05 retries READY with bounded backoff until context arrives", () => {
  assert.match(page, /HANDSHAKE_ATTEMPTS/);
  assert.match(page, /handshakeAttempt/);
  assert.match(page, /setTimeout\(retry/);
  assert.match(page, /clearTimeout\(handshakeTimer\)/);
});
