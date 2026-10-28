import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, path), 'utf8');

const calendarHtml = read('../../pages/#html1.txt');
const confirmationHtml = read('../../pages/#html2.txt');
const calendarPage = read('../../pages/Calendario de reservas 2.q39h6.js');
const bridge = read('../../public/widgetBridge.js');
const contract = read('../../../docs/CONTRATO_WIDGETS_HTML.md');

test('WIDGET-ASSET-01 canonical embedded widgets contain no example-domain asset references', () => {
  for (const [name, html] of [['#html1', calendarHtml], ['#html2', confirmationHtml]]) {
    assert.doesNotMatch(html, /https?:\/\/tu-dominio\.com/i, name + ' must not use the example domain');
    assert.doesNotMatch(html, /https?:\/\/[^"'\s<>]+\/assets\/widget\.(?:css|js)(?:[?#][^"'\s<>]*)?/i,
      name + ' must not depend on unverified widget.css/widget.js assets');
  }
});

test('WIDGET-ASSET-02 bridge keeps canonical internal routes', () => {
  assert.match(bridge, /SERVICIOS:\s*"\/reserva-online"/);
  assert.match(bridge, /CALENDARIO_2:\s*"\/booking-calendar\/calendario-2"/);
  // Do not invent a privacy URL: the current published route is not confirmed
  // as /politica-de-privacidad, so the bridge must not advertise that legacy path.
  assert.doesNotMatch(bridge, /PRIVACY_POLICY:\s*"/);
  assert.doesNotMatch(bridge, /\/politica-de-privacidad/);
});

test('WIDGET-ASSET-03 confirmation widget and Velo contract use the dedicated handshake', () => {
  assert.match(confirmationHtml, /MM_CONFIRMATION_READY/);
  assert.match(confirmationHtml, /MM_CONFIRMATION_CONTEXT/);
  assert.match(contract, /MM_CONFIRMATION_READY/);
  assert.match(contract, /MM_CONFIRMATION_CONTEXT/);
  assert.match(contract, /no se sincroniza automáticamente (?:desde|con) GitHub|no se actualiza automáticamente desde el repositorio/i);
});

test('WIDGET-ASSET-04 calendar remains on the canonical bridge protocol', () => {
  assert.match(calendarHtml, /const MESSAGE_TYPES=Object\.freeze\(/);
  assert.match(calendarHtml, /READY:"MM_READY"/);
  assert.match(calendarHtml, /AVAIL:"MM_AVAIL"/);
  assert.match(calendarHtml, /BOOK:"MM_BOOK"/);
  assert.match(calendarHtml, /MM_CONTEXT/);
  assert.match(calendarHtml, /isTrustedOrigin\(e\.origin\)/);
  assert.match(calendarHtml, /parsed\.protocol!=="https:"/);
  assert.match(calendarHtml, /CONFIG\.parentOrigin=resolveParentOrigin\(\)/);
  assert.match(calendarHtml, /new URL\(o\)\.protocol==="https:"&&isTrustedOrigin\(o\)/);
  assert.match(contract, /#html1/);
  assert.match(contract, /processDualBooking/);
});

test('WIDGET-ASSET-05 payment-required bookings remain pending until checkout navigation', () => {
  // The page adapter deliberately normalizes Wix's requiresPayment to the
  // widget contract paymentPending; test the end-to-end contract, not an old
  // intermediate field name.
  assert.match(calendarHtml, /const paymentPending=p\.data\?\.paymentPending===true/);
  assert.match(calendarHtml, /Reserva creada\. Redirigiendo al pago/);
  assert.match(calendarHtml, /state\.completed=true/);
  assert.match(calendarPage, /bookingResult\.data\.requiresPayment === true/);
  assert.match(calendarPage, /CHECKOUT_URL_MISSING/);
  assert.match(calendarPage, /location\.to\(checkoutUrl\)/);

  const missingCheckoutGuard = calendarPage.indexOf('if (requiresPayment && !checkoutUrl) {');
  const redirectBranch = calendarPage.indexOf('if (requiresPayment) {', missingCheckoutGuard);
  const confirmationBranch = calendarPage.indexOf('openLightbox("ConfirmacionReserva"', redirectBranch);
  assert.notEqual(missingCheckoutGuard, -1, 'payment-required booking must reject a missing checkout URL');
  assert.notEqual(redirectBranch, -1, 'payment-required booking must have a checkout redirect branch');
  assert.notEqual(confirmationBranch, -1, 'non-payment confirmation remains available');
  assert.ok(missingCheckoutGuard < redirectBranch, 'checkout URL guard must precede redirect');
  assert.ok(redirectBranch < confirmationBranch, 'checkout branch must precede confirmation lightbox');
  assert.match(calendarPage.slice(missingCheckoutGuard, redirectBranch), /return;/);
  assert.match(calendarPage.slice(redirectBranch, confirmationBranch), /wixLocation\.to\(checkoutUrl\)/);
  assert.match(calendarPage.slice(redirectBranch, confirmationBranch), /return;/);
});

test('WIDGET-ASSET-06 confirmation widget pins messages to an allowlisted HTTPS origin', () => {
  assert.match(confirmationHtml, /ALLOWED_ORIGIN_SUFFIXES/);
  assert.match(confirmationHtml, /parsed\.protocol !== "https:"/);
  assert.match(confirmationHtml, /event\.origin !== PARENT_ORIGIN/);
  assert.match(confirmationHtml, /\}, PARENT_ORIGIN\)/);
  assert.doesNotMatch(confirmationHtml, /postMessage\([\s\S]{0,500},\s*["']\*["']\)/,
    'confirmation widget must not post messages to every origin');
  const scripts = [...confirmationHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'one inline confirmation script is expected');
  assert.doesNotThrow(() => new Function(scripts[0][1]), 'confirmation script must parse');
});
