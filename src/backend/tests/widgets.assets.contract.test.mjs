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
  assert.match(bridge, /PRIVACY_POLICY:\s*"\/politica-de-privacidad"/);
});

test('WIDGET-ASSET-03 confirmation widget and Velo contract use the dedicated handshake', () => {
  assert.match(confirmationHtml, /MM_CONFIRMATION_READY/);
  assert.match(confirmationHtml, /MM_CONFIRMATION_CONTEXT/);
  assert.match(contract, /MM_CONFIRMATION_READY/);
  assert.match(contract, /MM_CONFIRMATION_CONTEXT/);
  assert.match(contract, /no se sincroniza automáticamente desde GitHub|no se actualiza automáticamente desde el repositorio/i);
});

test('WIDGET-ASSET-04 calendar remains on the canonical bridge protocol', () => {
  assert.match(calendarHtml, /MM_READY/);
  assert.match(calendarHtml, /MM_CONTEXT/);
  assert.match(contract, /#html1/);
  assert.match(contract, /processDualBooking/);
});

test('WIDGET-ASSET-05 payment-required bookings are never rendered as confirmed before checkout', () => {
  assert.match(calendarHtml, /p\.status==="SUCCESS"&&p\.data\?\.requiresPayment===true/);
  assert.match(calendarHtml, /Pago pendiente/);
  assert.match(calendarHtml, /No repitas la solicitud/);
  assert.match(calendarPage, /if \(bookingResult\.data\.requiresPayment\) \{/);
  assert.match(calendarPage, /Checkout URL missing for payment-required booking/);
  assert.match(calendarPage, /wixLocation\.to\(bookingResult\.data\.checkoutUrl\)/);
  const paymentBranch = calendarPage.indexOf('if (bookingResult.data.requiresPayment) {');
  const confirmationBranch = calendarPage.indexOf('openLightbox("ConfirmacionReserva"', paymentBranch);
  assert.notEqual(paymentBranch, -1);
  assert.notEqual(confirmationBranch, -1);
  assert.match(calendarPage.slice(paymentBranch, confirmationBranch), /Checkout URL missing for payment-required booking/);
  assert.match(calendarPage.slice(paymentBranch, confirmationBranch), /return;/);
});
