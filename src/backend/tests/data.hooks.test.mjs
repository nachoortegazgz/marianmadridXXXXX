/*
=============================================================================
SUITE: data.hooks (v13.0-MINIMAL alignment, 2026-10-14)
Purpose: sell the RETIREMENT decisions DATA-01..DATA-05 (hooks that added
friction without real benefit: duplicated point-of-use validation and
compliance-free collections) AND verify the conserved legal guards
(Ley 11/2021 caja ledger, PGC double entry, RD 8/2019 time clock,
WEBHOOK_EVENT append-only). Runs offline via tests/loader.mjs mocks.
G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

const { wixDataMock } = await import('./loader.mjs');
const H = await import('backend/data');
const IC = await import('backend/internalConfig');

// -----------------------------------------------------------------------------
// DATA-04: CitasF2 enum/pairToken hooks RETIRED (validated in bookingCore /
// bookingSaga at point of use; CMS hook only duplicated work and broke admin
// manual edits). This test seals the removal so it cannot silently return.
// -----------------------------------------------------------------------------

test('HOOK-DATA04 CitasF2 enum/pairToken hooks retired', () => {
  assert.strictEqual(H.CitasF2_beforeInsert, undefined);
  assert.strictEqual(H.CitasF2_beforeUpdate, undefined);
});

// -----------------------------------------------------------------------------
// DATA-01: InventarioStockVenta / MovimientosInventario hooks RETIRED
// (no compliance value; reconciliation handled by cron job).
// -----------------------------------------------------------------------------

test('HOOK-DATA01 inventory hooks retired', () => {
  assert.strictEqual(H.MovimientosInventario_beforeUpdate, undefined);
  assert.strictEqual(H.MovimientosInventario_beforeRemove, undefined);
  assert.strictEqual(H.InventarioStockVenta_beforeUpdate, undefined);
});

test('HOOK-APPEND-02 retired blocked-collection hooks are gone (ADR-02)', () => {
  assert.strictEqual(H.SecuenciaTickets_beforeUpdate, undefined);
  assert.strictEqual(H.InventarioStockVentaCierre_beforeUpdate, undefined);
  assert.strictEqual(H.InventarioStockVentaCierre_beforeRemove, undefined);
});

// -----------------------------------------------------------------------------
// MovimientosCaja hardening (traceId + recordHash + schemaVersion) — SSOT v13
// -----------------------------------------------------------------------------

function cajaBase() {
  return {
    eventType: IC.EVENT_TYPE ? Object.values(IC.EVENT_TYPE)[0] : 'VENTA_LINEA',
    movementType: Object.values(IC.MOVEMENT_TYPE)[0],
    totalAmount: 100,
    thirdPartyId: null,
    schemaVersion: 'LEDGER_V5_FISCAL',
    traceId: 'trace-caja-001',
    recordHash: 'a'.repeat(64),
  };
}

test('HOOK-CAJA-01 rejects write without traceId', () => {
  const item = cajaBase();
  delete item.traceId;
  assert.throws(() => H.MovimientosCaja_beforeInsert(item), /traceId/);
});

test('HOOK-CAJA-02 rejects missing schemaVersion', () => {
  const item = { ...cajaBase() };
  delete item.schemaVersion;
  assert.throws(() => H.MovimientosCaja_beforeInsert(item), /schemaVersion/);
});

test('HOOK-CAJA-04 accepts valid baseline', () => {
  assert.doesNotThrow(() => H.MovimientosCaja_beforeInsert(cajaBase()));
});

test('HOOK-CAJA-03 update/remove remain forbidden', () => {
  assert.throws(() => H.MovimientosCaja_beforeUpdate({}), /FISCAL_VIOLATION/);
  assert.throws(() => H.MovimientosCaja_beforeRemove({}), /FISCAL_VIOLATION/);
});

test('HOOK-CAJA-05 rejects write without recordHash (ledger integrity)', () => {
  const item = { ...cajaBase() };
  delete item.recordHash;
  assert.throws(() => H.MovimientosCaja_beforeInsert(item), /recordHash/);
});

test('HOOK-CAJA-06 normalizes legacy hash alias to canonical recordHash', () => {
  // Historicos pre-migracion: "hash" es alias tolerado de entrada; la
  // normalizacion destructiva debe promoverlo a recordHash y purgar el alias.
  const item = { ...cajaBase(), hash: 'b'.repeat(64) };
  delete item.recordHash;
  assert.doesNotThrow(() => H.MovimientosCaja_beforeInsert(item));
  assert.equal(item.recordHash, 'b'.repeat(64));
  assert.ok(!("hash" in item), "el alias 'hash' debe eliminarse del documento");
});

// -----------------------------------------------------------------------------
// LibroAsientosContablesDetalle (PGC partida doble minima) — CONSERVED
// -----------------------------------------------------------------------------

test('HOOK-LIBRO-01 requires traceId/debit/credit and blocks update/remove', () => {
  assert.throws(
    () => H.LibroAsientosContablesDetalle_beforeInsert({ debit: 1, credit: 1 }),
    /traceId/,
  );
  assert.throws(
    () => H.LibroAsientosContablesDetalle_beforeInsert({ traceId: 't1', credit: 1 }),
    /debit/,
  );
  assert.doesNotThrow(() => H.LibroAsientosContablesDetalle_beforeInsert({
    traceId: 't1', debit: 10, credit: 10,
  }));
  assert.throws(() => H.LibroAsientosContablesDetalle_beforeUpdate({}), /append-only/);
  assert.throws(() => H.LibroAsientosContablesDetalle_beforeRemove({}), /append-only/);
});

// -----------------------------------------------------------------------------
// HistoricoCierresZ — CONSERVED (update restricted to signature fields)
// -----------------------------------------------------------------------------

test('HOOK-CIERREZ-01 insert needs traceId; update limited to signature fields', () => {
  assert.throws(() => H.HistoricoCierresZ_beforeInsert({}), /traceId/);
  assert.doesNotThrow(() => H.HistoricoCierresZ_beforeInsert({ traceId: 't1' }));
  assert.doesNotThrow(() => H.HistoricoCierresZ_beforeUpdate({
    _id: 'x', closingSignature: 'sig', csvAEAT: 'csv',
  }));
  assert.throws(() => H.HistoricoCierresZ_beforeUpdate({
    _id: 'x', totalImporte: 999,
  }), /signature\/verification/);
  assert.throws(() => H.HistoricoCierresZ_beforeRemove({}), /append-only/);
});

// -----------------------------------------------------------------------------
// RegistrosHorariosStaff (RD 8/2019) — CONSERVED as append-only minimal guard
// -----------------------------------------------------------------------------

test('HOOK-CLOCK-01 insert requires traceId', () => {
  /* DEC-IC-02: el alias TIMECLOCK_TYPE fue eliminado; consumidores usan
     CLOCK_EVENT_TYPE directamente (SSOT). */
  assert.throws(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: IC.CLOCK_EVENT_TYPE.ENTRADA,
  }), /traceId/);
  assert.doesNotThrow(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: IC.CLOCK_EVENT_TYPE.ENTRADA, traceId: 't1',
  }));
});

test('HOOK-CLOCK-02 update/remove forbidden (RD 8/2019)', () => {
  assert.throws(() => H.RegistrosHorariosStaff_beforeUpdate({}), /append-only/);
  assert.throws(() => H.RegistrosHorariosStaff_beforeRemove({}), /append-only/);
});

// keep wixDataMock referenced so loader seeds reset between suites
test('HOOK-MOCK-00 loader mock available', () => {
  wixDataMock._reset();
  assert.ok(true);
});
