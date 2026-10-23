import test from 'node:test';
import assert from 'node:assert/strict';

const { wixDataMock } = await import('./loader.mjs');
const RW = await import('backend/reservas.web.js');

const SOURCE = 'ServiciosCatalogo';
const PRIVATE_KEYS = new Set([
  'margin',
  'internalNotes',
  'precioCosteBase',
  'cuentaContableIngreso',
  'cuentaContableContrapartida',
  'codigoImpuesto',
  'claveRegimen',
  'tipoImpositivo',
  'payloadFiscal',
  'nifEmisor',
  'previousRecordHash',
]);

function deepKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    deepKeys(child, result);
  }
  return result;
}

function seedService(overrides = {}) {
  const serviceId = overrides.serviceId || 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001';
  const row = {
    _id: serviceId,
    catalogEntryType: 'SERVICE',
    serviceId,
    sku: 'QA-SERVICE',
    slug: 'qa-private-source',
    title: 'Servicio QA',
    description: 'Descripción pública',
    tagLine: 'Prueba',
    price: 39,
    currency: 'EUR',
    location: 'Zaragoza',
    locationId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffff0001',
    mainMedia: 'https://example.invalid/service.jpg',
    totalDuration: 45,
    phase1Duration: 45,
    phase2Duration: 0,
    exposureDuration: 0,
    allowCombine: false,
    linkedPhases: '',
    clientHidden: false,
    onlinePayment: true,
    inPersonPayment: true,
    recomendaciones: ['Consejo público'],
    name: [],
    margin: 15,
    internalNotes: 'No publicar',
    precioCosteBase: 12,
    cuentaContableIngreso: '705000',
    cuentaContableContrapartida: '430000',
    codigoImpuesto: 'S1',
    claveRegimen: '01',
    tipoImpositivo: 21,
    payloadFiscal: { internalNotes: 'No publicar' },
    nifEmisor: 'NO_PUBLICAR',
    previousRecordHash: 'NO_PUBLICAR',
    ...overrides,
  };
  const rows = wixDataMock._store.get(SOURCE) || [];
  rows.push(row);
  wixDataMock._store.set(SOURCE, rows);
  return row;
}

test('CATALOG-SOURCE-01 public lookup reads ServiciosCatalogo and returns only the public DTO', async () => {
  wixDataMock._reset();
  const row = seedService({ slug: 'qa-source-' + Date.now() });

  const result = await RW.getServiceBySlugOrId(row.slug);

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.data.serviceId, row.serviceId);
  assert.equal(result.data.title, 'Servicio QA');
  assert.equal(result.data.price, 39);
  assert.deepEqual(
    deepKeys(result.data).filter((key) => PRIVATE_KEYS.has(key)),
    [],
    'public webMethod must not expose private/fiscal fields from the source collection'
  );
  assert.equal(wixDataMock._store.has('ServiciosCatalogoPublico'), false);
});

test('CATALOG-SOURCE-02 dual service resolves F2 from the same canonical source collection', async () => {
  wixDataMock._reset();
  const f2Id = 'cccccccc-dddd-4eee-8fff-aaaaaaaa0002';
  const parent = seedService({
    serviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002',
    slug: 'qa-dual-source-' + Date.now(),
    allowCombine: true,
    linkedPhases: f2Id,
    phase1Duration: 50,
    exposureDuration: 40,
    phase2Duration: 60,
    totalDuration: 150,
  });
  seedService({
    serviceId: f2Id,
    slug: 'qa-dual-f2-source-' + Date.now(),
    clientHidden: true,
    allowCombine: false,
    linkedPhases: '',
    title: 'Fase 2 interna',
    price: 0,
  });

  const result = await RW.getServiceBySlugOrId(parent.slug);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.data.allowCombine, true);
  assert.equal(result.data.linkedPhases, f2Id);
  assert.equal(result.data.totalDuration, 150);
  assert.equal(wixDataMock._store.has('ServiciosCatalogoPublico'), false);
});

test('CATALOG-SOURCE-03 unresolved F2 fails closed without requiring a public mirror', async () => {
  wixDataMock._reset();
  const parent = seedService({
    serviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0003',
    slug: 'qa-dual-missing-source-' + Date.now(),
    allowCombine: true,
    linkedPhases: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbb0003',
    phase1Duration: 50,
    exposureDuration: 40,
    phase2Duration: 60,
    totalDuration: 150,
  });

  const result = await RW.getServiceBySlugOrId(parent.slug);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.data, null);
  assert.ok(['DATABASE_ERROR', 'SERVICE_NOT_FOUND'].includes(result.error.code));
  assert.equal(wixDataMock._store.has('ServiciosCatalogoPublico'), false);
});
