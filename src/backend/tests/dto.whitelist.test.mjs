/*
=============================================================================
SUITE: dto.whitelist (FASE3/4 mandatory contract test)
Purpose: no public webMethod response may leak internal/fiscal fields:
margin, internalNotes, tipoImpositivo, codigoImpuesto, payloadFiscal,
nifEmisor, cuentaContable*, previousRecordHash. recordHash is ONLY allowed
in the Verifactu receipt DTO (AEAT public QR contract).
Runs offline via tests/loader.mjs mocks. G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

const { wixDataMock } = await import('./loader.mjs');
// ADR-06 Etapa A: convencion unica backend/<modulo>.web.js (incl. tests)
const RW = await import('backend/reservas.web.js');
const CW = await import('backend/cajas.web.js');
const IC = await import('backend/internalConfig');

const FORBIDDEN_KEYS = [
  'margin', 'internalNotes', 'tipoImpositivo', 'codigoImpuesto',
  'payloadFiscal', 'nifEmisor', 'previousRecordHash',
  'cuentaContableContrapartida', 'cuentaContableCliente', 'cuentaContableIngresos',
];

// RES-30 (P0): el bookingId NO es credencial. La superficie publica exige
// token opaco de un solo uso emitido por generateDisplayToken sobre una
// reserva CONFIRMED existente. Helper shared por los DTO tests.
async function issueToken(bookingId) {
  const gen = await RW.generateDisplayToken({ bookingId });
  assert.strictEqual(gen.ok, true, `token issuance failed: ${gen.error}`);
  return gen.token;
}

// RES-30 (P0): el bookingId NO es credencial y ademas debe pasar la validacion
// de forma _looksLikeGuid (mismo estandar que la superficie publica canonesa
// probada en reservas.web.test.mjs con GUID_OK). Los ids legibles tipo
// 'BK-77' quedan rechazados en INVALID_PAYLOAD fail-fast (anti-enumeracion).
const DTO_GUID_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001';
const DTO_GUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002';
const DTO_GUID_3 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0003';
const DTO_GUID_LEGACY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0004';

function _deepKeys(obj, acc = []) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      acc.push(k);
      _deepKeys(obj[k], acc);
    }
  }
  return acc;
}

test('DTO-01 getConfirmedBookingForDisplay returns whitelisted DTO only', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r1',
    bookingId: 'BK-77',
    bookingStatus: 'CONFIRMED',
    paymentStatus: 'PAID',
    pairToken: 'PT-1',
    serviceId: 'SVC-9',
    dateYmd: '2026-10-05',
    slotStart: '2026-10-05T10:00:00Z',
    slotEnd: '2026-10-05T11:00:00Z',
    resourceId: 'RES-2',
    totalPrice: 4500,
    // fields that MUST NOT leak:
    margin: 1200,
    internalNotes: 'notas internas',
    tipoImpositivo: 21,
    payloadFiscal: { x: 1 },
    nifEmisor: 'B12345678',
    previousRecordHash: 'abc',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-77' });
  assert.strictEqual(res.ok, true);
  const keys = _deepKeys(res.data);
  for (const bad of FORBIDDEN_KEYS) {
    assert.ok(!keys.includes(bad), `leaked forbidden key: ${bad}`);
  }
  assert.strictEqual(res.data.bookingId, 'BK-77');
  assert.strictEqual(res.data.bookingStatus, 'CONFIRMED');
});

// DTO-02 (actualizado v12): la rama legacy rec.status fue ELIMINADA del
// lector canonico por RES-R3-13 (CitasF2 usa bookingStatus como KEY FIELD).
// El test ahora verifica el contrato vigente: fila canonical legible +
// proyeccion whitelist; y como asercion negativa que una fila SOLO legacy
// 'status' ya NO es visible (comportamiento deliberado post-v12).
test('DTO-02 canonical bookingStatus row readable via whitelist projection', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r2', bookingId: 'BK-78', bookingStatus: 'CONFIRMED', paymentStatus: 'PAID',
    totalAmount: 30, internalNotes: 'x',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-78' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.bookingStatus, 'CONFIRMED');
  assert.ok(!_deepKeys(res.data).includes('internalNotes'));
  // Legacy-only row (campo 'status') no proyecta: rama eliminada RES-R3-13.
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r2b', bookingId: 'BK-78L', status: 'CONFIRMED',
  }]);
  const legacy = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-78L' });
  assert.strictEqual(legacy.ok, false);
  assert.strictEqual(legacy.error, 'NOT_CONFIRMED');
});

test('DTO-03 non-displayable booking states are hidden', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r3', bookingId: 'BK-79', bookingStatus: 'CANCELED',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-79' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'NOT_CONFIRMED');
});

test('DTO-04 getMovimientoByBooking exposes only receipt-safe fields', async () => {
  wixDataMock._reset();
  const mod = await import('backend/cajas.web.js');
  // canonical serialized linkedBookingIds produced by _linkedBookingValue([id])
  const seed = [{
    _id: 'm1',
    invoiceNumber: 'EM-2026-10-00000001',
    issuerTaxId: 'B99999999',
    invoiceIssueDate: '2026-10-05',
    totalAmount: 45,
    recordHash: 'HASH1',
    recordTimestamp: '2026-10-05T10:05:00Z',
    operationDescription: 'Cobro reserva BK-80',
    linkedBookingIds: 'BK-80',
    // must not leak:
    tipoImpositivo: 21,
    codigoImpuesto: 'S1',
    payloadFiscal: { firma: 'x' },
    cuentaContableIngresos: '4300',
    previousRecordHash: 'GENESIS',
    internalNotes: 'no publico',
  }];
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, seed);
  const res = await mod.getMovimientoByBooking({ bookingId: 'BK-80' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const keys = _deepKeys(res.data);
  for (const bad of ['tipoImpositivo', 'codigoImpuesto', 'payloadFiscal',
    'cuentaContableIngresos', 'previousRecordHash', 'internalNotes']) {
    assert.ok(!keys.includes(bad), `leaked: ${bad}`);
  }
  assert.strictEqual(res.data.recordHash, 'HASH1'); // AEAT QR contract field
});

test('DTO-05 missing bookingId rejected without CMS call', async () => {
  wixDataMock._reset();
  const before = wixDataMock._calls.length;
  const a = await RW.getConfirmedBookingForDisplay({});
  const b = await CW.getMovimientoByBooking({});
  assert.strictEqual(a.ok, false);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(wixDataMock._calls.length, before);
});
