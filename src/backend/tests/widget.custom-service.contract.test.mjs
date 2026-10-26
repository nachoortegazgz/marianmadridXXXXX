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

test("WIDGET-SERVICE-01 canonical service widget exists and has valid inline JavaScript", () => {
  assert.match(page, /<html lang="es">/);
  assert.match(page, /id="serviceTitle"/);
  assert.match(page, /id="primaryAction"/);
  assert.match(page, /id="addonsList"/);
  const scripts = [...page.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)];
  assert.equal(scripts.length, 1, "one inline script is expected");
  assert.doesNotThrow(() => new Function(scripts[0][1]), "inline script must parse");
});

test("WIDGET-SERVICE-02 uses the Velo bridge's canonical protocol envelope", () => {
  for (const type of ["MM_READY", "MM_CONTEXT", "MM_BOOK", "MM_NAV"]) {
    assert.ok(page.includes('"' + type + '"'), "widget must support " + type);
  }
  assert.match(page, /window\.parent\.postMessage/);
  assert.match(page, /event\.source !== window\.parent/);
  assert.match(page, /messageId: messageId\(type\.toLowerCase\(\)\)/);
  assert.match(page, /message\.version !== VERSION/);
  assert.match(bridge, /READY: "MM_READY"/);
  assert.match(bridge, /CONTEXT: "MM_CONTEXT"/);
  assert.match(velo, /onContextReady: async/);
  assert.match(velo, /createWidgetBridge\(widget/);
});

test("WIDGET-SERVICE-03 booking action sends only the allowed add-on selection", () => {
  assert.match(page, /send\(TYPES\.BOOK, \{[\\s\\S]*addOnIds: Array\.from\(state\.selectedAddons\)/);
  assert.doesNotMatch(page, /resourceId\s*:/, "the public widget must not choose or send a staff resource");
  assert.doesNotMatch(page, /staffName|staffMemberId|wixStaffMemberId/, "internal staff identities must not be exposed");
  assert.match(velo, /buildBookingUrl\(/);
  assert.match(velo, /getAddOnIds\(\s*payload,\s*service\s*\)/);
});

test("WIDGET-SERVICE-04 renders dynamic content as text and handles both service and pricing-plan entries", () => {
  assert.match(page, /textContent = text\(service\.title/);
  assert.match(page, /service\.catalogEntryType === "PRICING_PLAN"/);
  assert.match(page, /service\.primaryActionLabel/);
  assert.match(page, /service\.clientHidden === true/);
  assert.doesNotMatch(page, /innerHTML\s*=/, "untrusted CMS strings must not be inserted as HTML");
});

test("WIDGET-SERVICE-05 retries READY until the context handshake succeeds", () => {
  assert.match(page, /handshakeDelays/);
  assert.match(page, /handshakeCount/);
  assert.match(page, /clearTimeout\(handshakeTimer\)/);
});
