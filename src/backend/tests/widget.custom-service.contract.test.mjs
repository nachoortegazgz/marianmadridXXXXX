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
const backend = readFileSync(join(root, "src", "backend", "reservas.web.js"), "utf8");

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

test("WIDGET-SERVICE-06 registers the bridge before waiting for Wix app-page data", () => {
  assert.ok(
    velo.indexOf("bridge = createWidgetBridge(widget") < velo.indexOf("const appPageData = await withLocalTimeout"),
    "the widget listener must exist before the potentially slow page-data lookup"
  );
  assert.match(velo, /await lookupReady/);
  assert.match(velo, /lookupError\.code = "SERVICE_LOOKUP_MISSING"/);
  assert.match(bridge, /send\([\s\S]*?MESSAGE_TYPES\.CONTEXT/);
  assert.match(velo, /withLocalTimeout\([\s\S]*?8000[\s\S]*?APP_PAGE_DATA_TIMEOUT/);
});

test("WIDGET-SERVICE-07 timeout budgets are aligned and handshake retries are capped exponential", () => {
  assert.match(bridge, /HANDSHAKE_TIMEOUT_MS:\s*55000/);
  assert.match(bridge, /CONTEXT_TIMEOUT_MS:\s*155000/);
  assert.match(page, /HANDSHAKE_ATTEMPTS:\s*9/);
  assert.match(page, /HANDSHAKE_MAX_BACKOFF_MS:\s*8000/);
  assert.match(page, /CONTEXT_TIMEOUT_MS:\s*165000/);
  assert.match(page, /BOOK_NOTICE_TIMEOUT_MS:\s*60000/);
  assert.match(page, /Math\.min\([\s\S]*?HANDSHAKE_MAX_BACKOFF_MS[\s\S]*?2 \*\* \(handshakeAttempt - 1\)/);
});

test("WIDGET-SERVICE-08 transient service reads retry with bounded exponential backoff; booking actions are not replayed", () => {
  assert.match(velo, /async function loadServiceWithRetry\(lookupValue, traceId\)/);
  assert.match(velo, /const maxAttempts = 3/);
  assert.match(velo, /SERVICE_LOOKUP_TIMEOUT/);
  assert.match(velo, /35000,[\s\S]*?SERVICE_LOOKUP_TIMEOUT/);
  assert.match(velo, /TIMEOUT\|TRANSIENT\|NETWORK/);
  assert.match(backend, /SERVICE_LOOKUP_TRANSIENT/);
  assert.match(velo, /500 \* 2 \*\* \(attempt - 1\)/);
  assert.doesNotMatch(velo, /const retryable =\s*!code\s*\|\|/, "validation errors must not be retried blindly");
  assert.match(page, /No vuelvas a pulsar ni repitas la compra o reserva/);
});

test("WIDGET-SERVICE-09 context errors use the same MM_CONTEXT envelope the HTML widget consumes", () => {
  assert.ok(bridge.includes("send(\n          MESSAGE_TYPES.CONTEXT"));
  assert.ok(bridge.includes("userMessage"));
  assert.ok(page.includes("if (type === MESSAGE_TYPES.CONTEXT)"));
  assert.ok(page.includes("context.error"));
  assert.ok(page.includes("ctxError.message"));
  assert.doesNotMatch(velo, /notifyContextError/);
});

test("WIDGET-SERVICE-10 backend classifies transport failures as transient without retrying domain errors", () => {
  assert.ok(backend.includes("const transientCode = /TIMEOUT|NETWORK|TEMPORARY|UNAVAILABLE"));
  assert.ok(backend.includes("const transientMessage = /TIMEOUT|NETWORK|TEMPORARY"));
  assert.ok(backend.includes("const transient = transientCode || transientMessage"));
  assert.ok(backend.includes('const publicCode = transient ? "SERVICE_LOOKUP_TRANSIENT" : "DATABASE_ERROR"'));
  assert.ok(velo.includes("TRANSIENT"));
});

test("WIDGET-SERVICE-11 calendar availability has bounded retries and aligned timeout margins", () => {
  const calendar = readFileSync(join(root, "src", "pages", "Calendario de reservas 2.q39h6.js"), "utf8");
  const calendarHtml = readFileSync(join(root, "src", "pages", "#html1.txt"), "utf8");
  assert.match(calendar, /FRONTEND_API_TIMEOUT_MS\) \|\| 60000/);
  assert.match(calendar, /BOOKING_API_TIMEOUT_MS\) \|\| 150000/);
  assert.match(calendarHtml, /availabilityTimeoutMs:65000/);
  assert.match(calendarHtml, /availabilityMaxAttempts:3/);
  assert.match(calendarHtml, /availabilityBackoffBaseMs\*2\*\*\(state\.availabilityAttempt-1\)/);
  assert.match(calendarHtml, /No repitas la solicitud/);
  assert.match(calendarHtml, /BOOKING_STATUS_UNCERTAIN/);
});

test("WIDGET-SERVICE-12 URL slug is primary and a failed slug lookup falls back to the native Wix service GUID", () => {
  assert.match(velo, /function resolveServiceLookupCandidates\(\)/);
  assert.match(velo, /add\(query\.slug, "query\.slug"\)/);
  assert.match(velo, /"route\.service-page"/);
  assert.match(velo, /add\(query\.serviceId, "query\.serviceId"\)/);
  assert.match(velo, /lookupCandidates = \[\.\.\.urlCandidates\]/);
  assert.match(velo, /source: "getAppPageData\.service\.id"/);
  assert.match(velo, /for \(const candidate of lookupCandidates\)/);
  assert.match(velo, /loadServiceWithRetry\(candidate\.value, traceId\)/);
  assert.match(velo, /if \(error\?\.code !== "SERVICE_NOT_FOUND"\)\s*\{\s*break;/);
  assert.match(backend, /\.eq\("slug", clean\)\.find\(CONSISTENT_READ\)/);
  assert.match(backend, /\.eq\("serviceId", clean\)\.find\(CONSISTENT_READ\)/);
  for (const field of ["slug", "title", "description", "tagLine", "mainMedia", "recommendations", "serviceId", "totalDuration", "addOnOptions"]) {
    assert.ok(backend.includes(field), "backend public DTO must include " + field);
  }
  assert.match(page, /service\.recommendations/);
  assert.match(page, /const slug = clean\(\s*service\.slug \|\| service\.serviceSlug \|\| service\.urlSlug\s*\)/);
});
