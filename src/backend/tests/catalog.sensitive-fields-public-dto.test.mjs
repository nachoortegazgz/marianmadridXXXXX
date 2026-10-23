import test from 'node:test';
import assert from 'node:assert/strict';

const { wixDataMock } = await import('./loader.mjs');
const RW = await import('backend/reservas.web.js');

const FORBIDDEN_PUBLIC_KEYS = [
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
];

function deepKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    deepKeys(child, result);
  }
  return result;
}

test('CATALOG-DTO-01 public service DTO excludes private, cost and fiscal fields', () => {
  wixDataMock._reset();

  const input = {
    catalogEntryType: 'SERVICE',
    serviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001',
    slug: 'corte-de-autor',
    title: 'Corte de Autor',
    description: 'Servicio de prueba',
    tagLine: 'Estilo personalizado',
    location: 'Zaragoza',
    price: 39,
    currency: 'EUR',
    mainMedia: 'https://example.invalid/service.jpg',
    totalDuration: 45,
    phase1Duration: 45,
    phase2Duration: 0,
    exposureDuration: 0,
    allowCombine: false,
    linkedPhases: null,
    clientHidden: false,
    recommendations: ['Llegar con el cabello seco'],
    addOnOptions: [{
      addonId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffff0001',
      name: 'Tratamiento adicional',
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
  };

  const dto = RW._toPublicService(input);
  assert.ok(dto && typeof dto === 'object', 'public DTO must be produced');

  const leaked = deepKeys(dto).filter((key) => FORBIDDEN_PUBLIC_KEYS.includes(key));
  assert.deepEqual(leaked, [], `private fields leaked into public DTO: ${leaked.join(', ')}`);

  assert.equal(dto.title, 'Corte de Autor');
  assert.equal(dto.price, 39);
  assert.equal(dto.addOnOptions.length, 1);
  assert.deepEqual(Object.keys(dto.addOnOptions[0]).sort(), ['addonId', 'name', 'price']);
});

test('CATALOG-DTO-02 pricing plan DTO excludes private and fiscal fields', () => {
  wixDataMock._reset();

  const dto = RW._toPublicService({
    catalogEntryType: 'PRICING_PLAN',
    pricingPlanId: 'cccccccc-dddd-4eee-8fff-aaaaaaaa0001',
    title: 'Bono 5 sesiones',
    slug: 'bono-5-sesiones',
    price: 75,
    currency: 'EUR',
    sessionCount: 5,
    margin: 30,
    internalNotes: 'No publicar',
    precioCosteBase: 10,
    cuentaContableIngreso: '705000',
    codigoImpuesto: 'S1',
    claveRegimen: '01',
  });

  const leaked = deepKeys(dto).filter((key) => FORBIDDEN_PUBLIC_KEYS.includes(key));
  assert.deepEqual(leaked, [], `private fields leaked into pricing-plan DTO: ${leaked.join(', ')}`);
  assert.equal(dto.catalogEntryType, 'PRICING_PLAN');
  assert.equal(dto.price, 75);
  assert.equal(dto.sessionCount, 5);
});
