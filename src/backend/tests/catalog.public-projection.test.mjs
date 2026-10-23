import test from 'node:test';
import assert from 'node:assert/strict';

const { wixDataMock } = await import('./loader.mjs');
const RW = await import('backend/reservas.web.js');

const PUBLIC_SERVICES = 'ServiciosCatalogoPublico';
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
  'taxIncluded',
]);

function deepKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    deepKeys(child, result);
  }
  return result;
}

function seedPublicService(overrides = {}) {
  const serviceId = overrides.serviceId || 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001';
  const row = {
    _id: serviceId,
    sourceId: serviceId,
    catalogEntryType: 'SERVICE',
    serviceId,
    sku: 'QA-SERVICE',
    slug: 'qa-service',
    title: 'Servicio QA',
    description: 'Descripción pública',
    tagLine: 'Prueba',
    price: 39,
    currency: 'EUR',
    location: 'Zaragoza',
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
    recommendations: ['Consejo público'],
    addOnOptions: [{
      addonId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffff0001',
      name: 'Tratamiento',
      price: 5,
      margin: 2,
      internalNotes: 'No publicar',
      precioCosteBase: 3,
      cuentaContableIngreso: '705000',
      codigoImpuesto: 'S1',
      claveRegimen: '01',
    }],
    margin: 15,
    internalNotes: 'Notas internas',
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
  const rows = wixDataMock._store.get(PUBLIC_SERVICES) || [];
  rows.push(row);
  wixDataMock._store.set(PUBLIC_SERVICES, rows);
  return row;
}

test('CATALOG-PROJECTION-01 public lookup reads the public projection and strips sensitive fields recursively', async () => {
  wixDataMock._reset();
  const row = seedPublicService({ slug: 'qa-public-projection-' + Date.now() });

  const result = await RW.getServiceBySlugOrId(row.slug);

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.data.serviceId, row.serviceId);
  assert.equal(result.data.title, 'Servicio QA');
  assert.equal(result.data.price, 39);

  const leaked = deepKeys(result.data).filter((key) => PRIVATE_KEYS.has(key));
  assert.deepEqual(leaked, [], 'public webMethod leaked private/fiscal projection fields');
  assert.deepEqual(Object.keys(result.data.addOnOptions[0]).sort(), ['addonId', 'name', 'price']);
});

test('CATALOG-PROJECTION-02 dual service requires a resolvable F2 in the public projection', async () => {
  wixDataMock._reset();
  const f2Id = 'cccccccc-dddd-4eee-8fff-aaaaaaaa0002';
  const parent = seedPublicService({
    serviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002',
    slug: 'qa-dual-parent-' + Date.now(),
    allowCombine: true,
    linkedPhases: f2Id,
    phase1Duration: 50,
    exposureDuration: 40,
    phase2Duration: 60,
    totalDuration: 150,
  });
  seedPublicService({
    serviceId: f2Id,
    slug: 'qa-dual-f2-' + Date.now(),
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
});

test('CATALOG-PROJECTION-03 malformed dual reference fails closed', async () => {
  wixDataMock._reset();
  const parent = seedPublicService({
    serviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0003',
    slug: 'qa-dual-missing-f2-' + Date.now(),
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
  assert.equal(result.error.code, 'PUBLIC_CATALOG_LOOKUP_FAILED');
});
