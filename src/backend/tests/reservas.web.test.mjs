/*
=============================================================================
SUITE: reservas.web.js v10 (FASE5, bateria offline)
Purpose: coverage of the availability engine public surface with REAL module
  code (no reimplementation): service catalog mapping (_mapServiceImport2ToUX),
  slug/GUID resolution (_getServiceBySlugOrIdInternal / _resolveServiceIdInternal),
  RAM cache + cycle guard (C4), DTO minimization (RES-23/C10), hidden-service
  rejection at entry points (C9), canonical add-on contract (SAGA-23), staff
  display names (MapaStaff + RES-15 legacy fallback), load-balanced ranking
  (RES-16/17), certified dual slots via mocked Bookings Writer V2
  (availabilityTimeSlots), exact-slot staff resolution for bookingSaga
  (RES-12 contract), DAYS_CACHE persistence (PEND-09/RES-18) and cache
  invalidation (C2 pagination).
Harness notes:
  - LH-09: overrides for 'mock:@wix/bookings::availabilityTimeSlots' MUST be
    registered BEFORE importing reservas.web.js so the ESM binding captures
    the test function (dynamic named-import returns the live namespace).
  - Module-level Maps (serviceCatalogRAM / availabilityCache) persist across
    tests in the same process; fixtures are keyed by unique GUIDs per test to
    avoid cross-contamination.
Runs offline via tests/loader.mjs. G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

const { wixDataMock, mocks } = await import('./loader.mjs');

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const SVC_COL = 'ServiciosCatalogo';
const CITAS_COL = 'CitasF2';
const CONTROL_COL = 'ControlOperativo';
const MAPA_COL = 'MapaStaff';

const STAFF_TYPE = '1cd44cf8-756f-41c3-bd90-3e2ffcaf1155'; // internalConfig API

let seq = 0;
function guid() {
  seq += 1;
  const h = String(seq).padStart(8, '0');
  return `${h}-${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(0, 3)}-${h}${h}${h}abcdef`.slice(0, 36);
}

// Slots API mock state (LH-09 override, mutable per test)
const slotsState = {
  responses: new Map(), // serviceId -> array of raw timeSlots
  calls: [],            // payload audit trail
};

async function listAvailability(payload) {
  slotsState.calls.push(payload);
  const svc = String(payload.serviceId);
  // Writer V2 semantics: a slot survives the resourceTypes filter when it
  // has NO staff-resource group at all (unrestricted/fallback slots, e.g.
  // location-based availability) OR when at least one of its staff resources
  // is in the requested set. Groups of OTHER resource types never qualify.
  let slots = (slotsState.responses.get(svc) || []).slice();
  const reqRes = payload.resourceTypes?.[0]?.resourceIds;
  if (Array.isArray(reqRes) && reqRes.length) {
    slots = slots.filter((s) => {
      const groups = (s.availableResources || []).filter((g) => g.resourceTypeId === STAFF_TYPE);
      if (groups.length === 0) return true;
      const ids = groups.flatMap((g) => (g.resources || []).map((r) => String(r.id ?? r)));
      return reqRes.some((rid) => ids.includes(String(rid)));
    });
  }
  return { timeSlots: slots };
}

function availSlot(startLocal, endLocal, staffIds) {
  return {
    localStartDate: startLocal,
    localEndDate: endLocal,
    bookable: true,
    availableResources: [
      { resourceTypeId: STAFF_TYPE, resources: staffIds.map((id) => ({ id })) },
    ],
  };
}

// Register the @wix/bookings override BEFORE importing the module under test.
// LH-10: namespace members are keyed MODULE_KEY::rootName::member so the
// stub's availabilityTimeSlots Proxy delegates to the live test function.
mocks.webMethods.register('@wix/bookings', 'availabilityTimeSlots::listAvailabilityTimeSlots',
  async (payload) => listAvailability(payload));

const RW = await import('backend/reservas.web.js');

function resetState() {
  wixDataMock._reset();
  slotsState.responses.clear();
  slotsState.calls.length = 0;
}

function seedService(row) {
  const rows = wixDataMock._store.get(SVC_COL) || [];
  rows.push({ _id: row.serviceId, ...row });
  wixDataMock._store.set(SVC_COL, rows);
  return row;
}

function baseServiceRow(over = {}) {
  return {
    serviceId: guid(),
    slug: null,
    title: 'Peluqueria',
    tagLine: null,
    description: null,
    price: 60,
    currency: 'EUR',
    location: 'Zaragoza',
    locationId: [guid()],
    mainMedia: null,
    totalDuration: 90,
    phase1Duration: 60,
    phase2Duration: 0,
    exposureDuration: 0,
    allowCombine: false,
    linkedPhases: null,
    clientHidden: false,
    availableStaff: [],
    addOnOptions: [],
    onlinePayment: true,
    inPersonPayment: true,
    status: 'ACTIVE',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// CATALOG MAPPING (_mapServiceImport2ToUX)
// ---------------------------------------------------------------------------

test('RES-MAP-01 simple service maps canonical keys and durations', async () => {
  resetState();
  const staff = guid();
  // totalDuration=0 fuerza la derivacion p1-only (contrato real:
  // estimatedTotal = Math.max(storedTotal, calculated, 30)).
  const row = baseServiceRow({ availableStaff: [staff], totalDuration: 0 });
  seedService(row);
  wixDataMock._seed(MAPA_COL, [{ _id: staff, resourceId: staff, displayName: 'Ana' }]);
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.strictEqual(mapped.serviceId, row.serviceId);
  assert.strictEqual(mapped.title, 'Peluqueria');
  assert.strictEqual(mapped.price, 60);
  assert.strictEqual(mapped.currency, 'EUR');
  assert.strictEqual(mapped.totalDuration, 60, 'simple => phase1 only (stored 0)');
  assert.strictEqual(mapped.allowCombine, false);
  assert.strictEqual(mapped.linkedPhases, null);
  assert.deepStrictEqual(mapped.availableStaff, [staff]);
  assert.strictEqual(mapped.staffOptions[0].name, 'Ana');
  assert.strictEqual(mapped.locationId, row.locationId[0], 'RES-21 first GUID');
});

test('RES-MAP-02 dual service computes total=p1+exp+p2 and keeps linkedPhases', async () => {
  resetState();
  const linked = guid();
  const row = baseServiceRow({
    allowCombine: true,
    linkedPhases: linked,
    phase1Duration: 60,
    exposureDuration: 15,
    phase2Duration: 30,
    totalDuration: 0,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: linked, clientHidden: true, allowCombine: false }));
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.strictEqual(mapped.allowCombine, true);
  assert.strictEqual(mapped.totalDuration, 105, '60+15+30');
  assert.strictEqual(mapped.linkedPhases, linked);
});

test('RES-MAP-03 C9 semantic: hidden parent never dual-reservable (allowCombine=false)', async () => {
  resetState();
  const linked = guid();
  seedService(baseServiceRow({ serviceId: linked }));
  const row = baseServiceRow({ allowCombine: true, linkedPhases: linked, clientHidden: true });
  seedService(row);
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.strictEqual(mapped.clientHidden, true);
  assert.strictEqual(mapped.allowCombine, false, 'hidden => not dual');
  assert.strictEqual(mapped.linkedPhases, null);
});

test('RES-MAP-04 fail-closed: missing/non-GUID serviceId throws', async () => {
  resetState();
  await assert.rejects(
    () => RW._mapServiceImport2ToUX({ serviceId: 'not-a-guid', title: 'X' }),
    /serviceId missing or not a GUID/,
  );
});

test('RES-MAP-05 fail-closed: allowCombine without GUID linkedPhases throws', async () => {
  resetState();
  await assert.rejects(
    () => RW._mapServiceImport2ToUX(baseServiceRow({ allowCombine: true, linkedPhases: 'slug-f2' })),
    /linkedPhases missing or not a GUID/,
  );
});

test('RES-MAP-06 fail-closed: allowCombine with unresolvable linked service throws', async () => {
  resetState();
  const row = baseServiceRow({ allowCombine: true, linkedPhases: guid() });
  seedService(row); // linked NOT seeded
  await assert.rejects(
    () => RW._mapServiceImport2ToUX(row),
    /linked service unavailable or unresolvable/,
  );
});

test('RES-MAP-07 RES-14: hidden F2 linked child is accepted (design of 24 F2)', async () => {
  resetState();
  const f2 = guid();
  seedService(baseServiceRow({ serviceId: f2, clientHidden: true }));
  const row = baseServiceRow({ allowCombine: true, linkedPhases: f2 });
  seedService(row);
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.strictEqual(mapped.allowCombine, true);
});

test('RES-MAP-08 RES-15: legacy staffDisponible fallback feeds availableStaff', async () => {
  resetState();
  const staff = guid();
  const row = baseServiceRow({ availableStaff: undefined });
  delete row.availableStaff;
  row.staffDisponible = [staff];
  seedService(row);
  wixDataMock._seed(MAPA_COL, [{ _id: staff, resourceId: staff, displayName: 'Luis' }]);
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.deepStrictEqual(mapped.availableStaff, [staff]);
  assert.strictEqual(mapped.staffOptions[0].name, 'Luis');
});

test('RES-MAP-09 addOnOptions canonical addonId, non-GUID silently dropped', async () => {
  resetState();
  const a1 = guid();
  const row = baseServiceRow({
    addOnOptions: [
      { addonId: a1, name: 'Barba', price: 10 },
      { addonId: 'not-a-guid', name: 'Basura', price: 5 },
    ],
  });
  seedService(row);
  const mapped = await RW._mapServiceImport2ToUX(row);
  assert.strictEqual(mapped.addOnOptions.length, 1);
  assert.strictEqual(mapped.addOnOptions[0].addonId, a1);
  assert.strictEqual(mapped.addOnOptions[0].price, 10);
});

test('RES-MAP-10 RES-22: mainMedia tolerant to string URL and Image object', async () => {
  resetState();
  const s1 = baseServiceRow({ mainMedia: 'https://cdn.example/img.jpg' });
  const m1 = await RW._mapServiceImport2ToUX(s1);
  assert.match(String(m1.mainMedia), /img\.jpg/);
  const s2 = baseServiceRow({ mainMedia: { url: 'https://cdn.example/obj.png' } });
  const m2 = await RW._mapServiceImport2ToUX(s2);
  assert.match(String(m2.mainMedia), /obj\.png/);
});

// ---------------------------------------------------------------------------
// LOOKUP / RESOLUTION / CACHE / CYCLE GUARD
// ---------------------------------------------------------------------------

test('RES-LOOK-01 slug lookup SUCCESS + DTO has no forbidden keys (RES-23)', async () => {
  resetState();
  const row = baseServiceRow({ slug: 'corte-hombre-' + seq });
  seedService(row);
  const res = await RW.getServiceBySlugOrId(row.slug);
  assert.strictEqual(res.status, 'SUCCESS');
  for (const banned of ['linkedPhases', 'clientHidden', 'availableStaff', 'status']) {
    assert.ok(!(banned in res.data), `DTO must not expose ${banned}`);
  }
  assert.strictEqual(res.data.serviceId, row.serviceId);
});

test('RES-LOOK-02 unknown slug -> SERVICE_NOT_FOUND', async () => {
  resetState();
  const res = await RW.getServiceBySlugOrId('no-existe-' + seq);
  assert.strictEqual(res.status, 'ERROR');
  assert.strictEqual(res.error.code, 'SERVICE_NOT_FOUND');
});

test('RES-LOOK-03 C9 entry point: hidden parent rejected as SERVICE_NOT_AVAILABLE', async () => {
  resetState();
  const row = baseServiceRow({ slug: 'oculto-' + seq, clientHidden: true });
  seedService(row);
  const res = await RW.getServiceBySlugOrId(row.slug);
  assert.strictEqual(res.status, 'ERROR');
  assert.strictEqual(res.error.code, 'SERVICE_NOT_AVAILABLE');
});

test('RES-LOOK-04 C4 cycle guard: A->B->A yields SERVICE_LINK_CYCLE', async () => {
  resetState();
  const a = guid();
  const b = guid();
  // Self-linked dual service: visiting A again inside its own mapping.
  const rowA = baseServiceRow({ serviceId: a, slug: null, allowCombine: true, linkedPhases: a });
  seedService(rowA);
  const res = await RW._getServiceBySlugOrIdInternal(a, null, new Set([String(a).toLowerCase()]));
  assert.strictEqual(res.status, 'ERROR');
  assert.strictEqual(res.error.code, 'SERVICE_LINK_CYCLE');
  void b;
});

test('RES-LOOK-05 _resolveServiceIdInternal: GUID passthrough, slug resolves, junk null', async () => {
  resetState();
  const row = baseServiceRow({ slug: 'resolver-' + seq });
  seedService(row);
  assert.strictEqual(await RW._resolveServiceIdInternal(row.serviceId), row.serviceId);
  assert.strictEqual(await RW._resolveServiceIdInternal(row.slug), row.serviceId);
  assert.strictEqual(await RW._resolveServiceIdInternal(''), null);
  assert.strictEqual(await RW._resolveServiceIdInternal('inexistent-' + seq), null);
});

test('RES-LOOK-06 resolveServiceId webMethod envelope contract', async () => {
  resetState();
  const row = baseServiceRow({ slug: 'wm-resolver-' + seq });
  seedService(row);
  const ok = await RW.resolveServiceId(row.slug);
  assert.strictEqual(ok.status, 'SUCCESS');
  assert.strictEqual(ok.data, row.serviceId);
  const bad = await RW.resolveServiceId('nadie-' + seq);
  assert.strictEqual(bad.status, 'ERROR');
  assert.strictEqual(bad.error.code, 'SERVICE_NOT_FOUND');
});

test('RES-LOOK-07 RAM cache hit: second lookup skips DB query (cache observability)', async () => {
  resetState();
  const row = baseServiceRow({ slug: 'cached-' + seq });
  seedService(row);
  const before = wixDataMock._calls.length;
  const r1 = await RW._getServiceBySlugOrIdInternal(row.slug);
  assert.strictEqual(r1.status, 'SUCCESS');
  const mid = wixDataMock._calls.length;
  assert.ok(mid > before, 'first lookup queries DB');
  const r2 = await RW._getServiceBySlugOrIdInternal(row.slug);
  assert.strictEqual(r2.status, 'SUCCESS');
  assert.strictEqual(wixDataMock._calls.length, mid, 'second lookup served from RAM cache');
});

// ---------------------------------------------------------------------------
// TO-PUBLIC DTO (pure)
// ---------------------------------------------------------------------------

test('RES-DTO-01 _toPublicService strips internals, tolerates null', () => {
  const pub = RW._toPublicService({
    serviceId: 'x', linkedPhases: 'y', clientHidden: true,
    availableStaff: ['z'], status: 'ACTIVE', title: 'T',
  });
  assert.deepStrictEqual(Object.keys(pub).sort(), ['serviceId', 'title']);
  assert.strictEqual(RW._toPublicService(null), null);
});

// ---------------------------------------------------------------------------
// ADDON CONTEXT (public export of internal resolver)
// ---------------------------------------------------------------------------

test('RES-ADDON-01 valid addon kept, unknown/non-GUID dropped', async () => {
  resetState();
  const a1 = guid();
  const a2 = guid();
  const service = { addOnOptions: [{ addonId: a1, name: 'A1', price: 10 }] };
  const ctx = await RW._resolveAddonContextPublic(service, [a1, a2, 'junk', null]);
  assert.ok(ctx, 'context returned');
  const native = (ctx.nativeAddonIds || []).map(String);
  assert.ok(native.includes(a1), 'catalog addon accepted');
  assert.ok(!native.includes(a2), 'unknown addon rejected');
});

// ---------------------------------------------------------------------------
// STAFF DISPLAY NAME
// ---------------------------------------------------------------------------

test('RES-STAFF-01 MapaStaff displayName resolved; non-GUID falls back default', async () => {
  resetState();
  const st = guid();
  wixDataMock._seed(MAPA_COL, [{ _id: st, resourceId: st, displayName: 'Marta' }]);
  assert.strictEqual(await RW._getStaffDisplayNamePublic(st), 'Marta');
  // SSOT internalConfig.STAFF_DEFAULT_NAME (RES-24/PEND-06): no 'Equipo'.
  assert.strictEqual(await RW._getStaffDisplayNamePublic('no-guid'), 'Marian Madrid');
});

// ---------------------------------------------------------------------------
// CERTIFIED DUAL SLOTS (engine + mocked Writer V2)
// ---------------------------------------------------------------------------

test('RES-DUAL-01 invalid dateYMD -> INVALID_PARAMS (no SDK call)', async () => {
  resetState();
  const res = await RW._getCertifiedDualSlotsInternal(guid(), '', '2026-13-45');
  assert.strictEqual(res.status, 'ERROR');
  assert.strictEqual(res.error.code, 'INVALID_PARAMS');
  assert.strictEqual(slotsState.calls.length, 0);
});

test('RES-DUAL-02 non-GUID resourceId -> INVALID_RESOURCE_ID (C3)', async () => {
  resetState();
  const row = baseServiceRow();
  seedService(row);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, 'staff-name', '2026-10-20');
  assert.strictEqual(res.status, 'ERROR');
  assert.strictEqual(res.error.code, 'INVALID_RESOURCE_ID');
});

test('RES-DUAL-03 simple service -> slotF2 null entries with candidates + pairToken', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  wixDataMock._seed(MAPA_COL, [{ _id: st1, resourceId: st1, displayName: 'Ana' }]);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-20');
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.length, 1);
  const pair = res.data[0];
  assert.strictEqual(pair.slotF2, null);
  assert.strictEqual(pair.slotF1.localStartDate, '2026-10-20T09:00:00');
  assert.ok(pair.pairToken, 'pairToken present');
  assert.deepStrictEqual(pair.candidateResourceIds, [st1]);
  assert.strictEqual(pair.serviceId, row.serviceId);
});

test('RES-DUAL-04 dual pair: gap>=exposure, same staff, DUAL_CACHE persisted (RES-18)', async () => {
  resetState();
  const st1 = guid();
  const f2 = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2,
    exposureDuration: 10, phase2Duration: 30,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2, clientHidden: true }));
  wixDataMock._seed(MAPA_COL, [{ _id: st1, resourceId: st1, displayName: 'Ana' }]);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  slotsState.responses.set(f2, [availSlot('2026-10-20T10:15:00', '2026-10-20T10:45:00', [st1])]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-20');
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.length, 1);
  const p = res.data[0];
  assert.strictEqual(p.slotF1.resourceId, st1);
  assert.strictEqual(p.slotF2.resourceId, st1, 'same-staff pairing');
  assert.strictEqual(p.slotF2.localStartDate, '2026-10-20T10:15:00');
  const ctrl = (wixDataMock._store.get(CONTROL_COL) || []).find((r) => r.controlType === 'DUAL_CACHE');
  assert.ok(ctrl, 'DUAL_CACHE record persisted in ControlOperativo');
  assert.strictEqual(ctrl.dateYmd, '2026-10-20');
  const payload = JSON.parse(ctrl.payloadJson);
  assert.strictEqual(payload.linkedPhases, f2);
  assert.strictEqual(payload.f2Start, '2026-10-20T10:15:00');
});

test('RES-DUAL-05 gap below exposure -> no pair (fail-closed empty)', async () => {
  resetState();
  const st1 = guid();
  const f2 = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2, exposureDuration: 30,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2, clientHidden: true }));
  wixDataMock._seed(MAPA_COL, [{ _id: st1, resourceId: st1, displayName: 'Ana' }]);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  slotsState.responses.set(f2, [availSlot('2026-10-20T10:10:00', '2026-10-20T10:40:00', [st1])]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-20');
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.length, 0, 'gap 10 < exposure 30 => rejected');
});

test('RES-DUAL-06 different-staff F2 -> no pair (same-staff rule)', async () => {
  resetState();
  const st1 = guid();
  const st2 = guid();
  const f2 = guid();
  const row = baseServiceRow({ availableStaff: [st1], allowCombine: true, linkedPhases: f2, exposureDuration: 5 });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2, clientHidden: true }));
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  slotsState.responses.set(f2, [availSlot('2026-10-20T10:10:00', '2026-10-20T10:40:00', [st2])]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-20');
  assert.strictEqual(res.data.length, 0);
});

test('RES-DUAL-07 hidden parent -> SERVICE_NOT_AVAILABLE at engine level (C9)', async () => {
  resetState();
  const row = baseServiceRow({ clientHidden: true });
  seedService(row);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-20');
  assert.strictEqual(res.error.code, 'SERVICE_NOT_AVAILABLE');
});

test('RES-DUAL-08 getAvailableSlots (RES-13) delegates single-service branch', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-21T11:00:00', '2026-10-21T12:00:00', [st1])]);
  const res = await RW.getAvailableSlots(row.serviceId, '', '2026-10-21');
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.length, 1);
  assert.strictEqual(res.data[0].slotF2, null);
});

// ---------------------------------------------------------------------------
// EXACT STAFF RESOLUTION (RES-12 contract consumed by bookingSaga)
// ---------------------------------------------------------------------------

test('RES-RSF-01 missing f1Start -> INVALID_SLOT_RECHECK', async () => {
  resetState();
  const res = await RW._resolveStaffForSlotInternal({ serviceId: guid(), f1Start: '' });
  assert.strictEqual(res.error.code, 'INVALID_SLOT_RECHECK');
});

test('RES-RSF-02 unknown service -> SERVICE_NOT_FOUND', async () => {
  resetState();
  // CONTRATO REAL (reservas.web.js:1365-1380): dos compuertas distintas.
  // a) id NO-GUID -> _resolveServiceIdInternal devuelve null -> SERVICE_NOT_FOUND.
  // b) GUID valido ausente del catalogo -> resolve pasa (passthrough) y la
  //    compuerta de config devuelve SERVICE_CONFIG_MISSING. Se fijan AMBAS.
  const junk = await RW._resolveStaffForSlotInternal({ serviceId: 'not-a-guid', f1Start: '2026-10-20T09:00:00' });
  assert.strictEqual(junk.error.code, 'SERVICE_NOT_FOUND');
  const missingGuid = await RW._resolveStaffForSlotInternal({ serviceId: guid(), f1Start: '2026-10-20T09:00:00' });
  assert.strictEqual(missingGuid.error.code, 'SERVICE_CONFIG_MISSING');
});

test('RES-RSF-03 exact F1 match success with slotF1 injected serviceId', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  wixDataMock._seed(MAPA_COL, [{ _id: st1, resourceId: st1, displayName: 'Ana' }]);
  slotsState.responses.set(row.serviceId, [
    availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1]),
    availSlot('2026-10-20T12:00:00', '2026-10-20T13:00:00', [st1]),
  ]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId,
    f1Start: '2026-10-20T12:00:00',
    f1End: '2026-10-20T13:00:00',
  });
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.resourceId, st1);
  assert.strictEqual(res.data.resourceName, 'Ana');
  assert.strictEqual(res.data.slotF1.serviceId, row.serviceId, '_attachServiceId injection');
  assert.strictEqual(res.data.slotF2, null);
  assert.strictEqual(res.data.dateYMD, '2026-10-20');
});

test('RES-RSF-04 slot taken (no exact match) -> SLOT_UNAVAILABLE', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId, f1Start: '2026-10-20T15:00:00',
  });
  assert.strictEqual(res.error.code, 'SLOT_UNAVAILABLE');
});

test('RES-RSF-05 requested staff not in candidates -> STAFF_NOT_AVAILABLE', async () => {
  resetState();
  const st1 = guid();
  const other = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  // El mock de Slots API debe respetar resourceTypes.resourceIds igual que
  // Writer V2 real: sin slots para 'other' la compuerta F1 devuelve
  // SLOT_UNAVAILABLE (rama ya cubierta por RSF-04). Para alcanzar la
  // compuerta ESPECIFICA de staff (reservas.web.js:1573-1581, "Selected
  // staff is not available") el slot debe existir para el recurso pedido
  // pero sus candidatos normalizados no incluirlo (p.ej. slot sin resources).
  // El mock respeta resourceTypes.resourceIds como Writer V2 real (slot con
  // recursos [st1] no se devuelve cuando se pide 'other'). Para alcanzar la
  // compuerta ESPECIFICA "Selected staff is not available" (reservas.web.js
  // ~1573) el slot debe SURVIVIR al filtro de recursos pero sus candidatos
  // normalizados no incluir el pedido: slot sin resources + requestedResourceId.
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId, f1Start: '2026-10-20T09:00:00', requestedResourceId: other,
  });
  assert.strictEqual(res.error.code, 'STAFF_NOT_AVAILABLE');
});

test('RES-RSF-06 simple service with F2 context -> UNEXPECTED_F2_CONTEXT', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId, f1Start: '2026-10-20T09:00:00', f2Start: '2026-10-20T10:30:00',
  });
  assert.strictEqual(res.error.code, 'UNEXPECTED_F2_CONTEXT');
});

test('RES-RSF-07 dual exact match success: both slots normalized, same staff', async () => {
  resetState();
  const st1 = guid();
  const f2svc = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2svc, exposureDuration: 10,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2svc, clientHidden: true }));
  wixDataMock._seed(MAPA_COL, [{ _id: st1, resourceId: st1, displayName: 'Ana' }]);
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  slotsState.responses.set(f2svc, [availSlot('2026-10-20T10:15:00', '2026-10-20T10:45:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId,
    f1Start: '2026-10-20T09:00:00', f1End: '2026-10-20T10:00:00',
    f2Start: '2026-10-20T10:15:00', f2End: '2026-10-20T10:45:00',
  });
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.slotF2.serviceId, f2svc);
  assert.strictEqual(res.data.resourceId, st1);
});

test('RES-RSF-08 dual F2 on different day -> F2_DIFFERENT_DAY', async () => {
  resetState();
  const st1 = guid();
  const f2svc = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2svc, exposureDuration: 10,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2svc, clientHidden: true }));
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId, f1Start: '2026-10-20T09:00:00', f2Start: '2026-10-21T10:15:00',
  });
  assert.strictEqual(res.error.code, 'F2_DIFFERENT_DAY');
});

test('RES-RSF-09 dual without f2Start -> F2_SLOT_REQUIRED', async () => {
  resetState();
  const st1 = guid();
  const f2svc = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2svc, exposureDuration: 10,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2svc, clientHidden: true }));
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId, f1Start: '2026-10-20T09:00:00',
  });
  assert.strictEqual(res.error.code, 'F2_SLOT_REQUIRED');
});

test('RES-RSF-10 dual gap outside range -> INVALID_GAP', async () => {
  resetState();
  const st1 = guid();
  const f2svc = guid();
  const row = baseServiceRow({
    availableStaff: [st1], allowCombine: true, linkedPhases: f2svc, exposureDuration: 30,
  });
  seedService(row);
  seedService(baseServiceRow({ serviceId: f2svc, clientHidden: true }));
  slotsState.responses.set(row.serviceId, [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [st1])]);
  slotsState.responses.set(f2svc, [availSlot('2026-10-20T10:05:00', '2026-10-20T10:35:00', [st1])]);
  const res = await RW._resolveStaffForSlotInternal({
    serviceId: row.serviceId,
    f1Start: '2026-10-20T09:00:00', f1End: '2026-10-20T10:00:00',
    f2Start: '2026-10-20T10:05:00',
  });
  assert.strictEqual(res.error.code, 'INVALID_GAP');
});

// ---------------------------------------------------------------------------
// LOAD BALANCING (RES-16/17) via certified dual ranking
// ---------------------------------------------------------------------------

test('RES-BAL-01 least-loaded staff chosen (PENDING counts, Date slotStart/slotEnd)', async () => {
  resetState();
  const stBusy = guid();
  const stFree = guid();
  const row = baseServiceRow({ availableStaff: [stBusy, stFree] });
  seedService(row);
  // stBusy already has a PENDING booking of 60 min that day (Date objects)
  wixDataMock._seed(CITAS_COL, [{
    _id: 'c1', bookingId: 'bk1', dateYmd: '2026-10-22',
    bookingStatus: 'PENDING', resourceId: stBusy,
    slotStart: new Date('2026-10-22T08:00:00Z'), slotEnd: new Date('2026-10-22T09:00:00Z'),
  }]);
  wixDataMock._seed(MAPA_COL, [
    { _id: stBusy, resourceId: stBusy, displayName: 'Zoe Busy' },
    { _id: stFree, resourceId: stFree, displayName: 'Aaron Free' },
  ]);
  slotsState.responses.set(row.serviceId, [
    availSlot('2026-10-22T10:00:00', '2026-10-22T11:00:00', [stBusy, stFree]),
  ]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-22');
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data[0].resourceId, stFree, 'free staff ranked first');
});

test('RES-BAL-02 CANCELED bookings ignored in load computation', async () => {
  resetState();
  const stA = guid();
  const stB = guid();
  const row = baseServiceRow({ availableStaff: [stA, stB] });
  seedService(row);
  wixDataMock._seed(CITAS_COL, [{
    _id: 'c1', bookingId: 'bk1', dateYmd: '2026-10-23',
    bookingStatus: 'CANCELED', resourceId: stA,
    slotStart: new Date('2026-10-23T08:00:00Z'), slotEnd: new Date('2026-10-23T18:00:00Z'),
  }]);
  wixDataMock._seed(MAPA_COL, [
    { _id: stA, resourceId: stA, displayName: 'AAA' },
    { _id: stB, resourceId: stB, displayName: 'BBB' },
  ]);
  slotsState.responses.set(row.serviceId, [
    availSlot('2026-10-23T10:00:00', '2026-10-23T11:00:00', [stA, stB]),
  ]);
  const res = await RW._getCertifiedDualSlotsInternal(row.serviceId, '', '2026-10-23');
  // equal load (0 vs 0) -> alphabetical tiebreak AAA
  assert.strictEqual(res.data[0].resourceId, stA);
});

// ---------------------------------------------------------------------------
// AVAILABLE DAYS (writer payload + DAYS_CACHE write) — uses real clock window
// ---------------------------------------------------------------------------

test('RES-DAYS-01 payload contract + day extraction + DAYS_CACHE persisted', async () => {
  resetState();
  const st1 = guid();
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  const nowMadrid = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const today = nowMadrid.slice(0, 10);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000)
    .toLocaleDateString('sv-SE', { timeZone: 'UTC' });
  slotsState.responses.set(row.serviceId, [availSlot(tomorrow + 'T09:00:00', tomorrow + 'T10:00:00', [st1])]);
  const y = Number(tomorrow.slice(0, 4));
  const m = Number(tomorrow.slice(5, 7));
  const res = await RW.getAvailableDays(row.serviceId, '', y, m);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.ok(Array.isArray(res.data));
  assert.ok(res.data.includes(tomorrow), 'tomorrow slot surfaces as available day');
  const call = slotsState.calls.find((c) => c.serviceId === row.serviceId);
  assert.ok(call, 'Writer V2 called');
  assert.strictEqual(call.timeZone, 'Europe/Madrid');
  assert.strictEqual(call.bookable, true);
  assert.strictEqual(call.timeSlotsPerDay, 1);
  const daysRec = (wixDataMock._store.get(CONTROL_COL) || []).find((r) => r.controlType === 'DAYS_CACHE');
  assert.ok(daysRec, 'DAYS_CACHE record written (PEND-09)');
  const payload = JSON.parse(daysRec.payloadJson);
  assert.ok(Array.isArray(payload.emptyDaysYmds));
});

test('RES-DAYS-02 invalid month -> INVALID_PARAMS', async () => {
  resetState();
  const row = baseServiceRow();
  seedService(row);
  const res = await RW.getAvailableDays(row.serviceId, '', 2026, 13);
  assert.strictEqual(res.error.code, 'INVALID_PARAMS');
});

// ---------------------------------------------------------------------------
// CACHE INVALIDATION (C2) + expired dual purge
// ---------------------------------------------------------------------------

test('RES-INV-01 invalidate removes DUAL_CACHE rows for the day', async () => {
  resetState();
  const row = baseServiceRow();
  seedService(row);
  const ymd = '2026-10-24';
  wixDataMock._seed(CONTROL_COL, [
    { _id: 'd1', controlType: 'DUAL_CACHE', serviceId: row.serviceId, dateYmd: ymd, resourceId: '', expiresAt: new Date(Date.now() + 60000) },
    { _id: 'd2', controlType: 'DUAL_CACHE', serviceId: row.serviceId, dateYmd: ymd, resourceId: '', expiresAt: new Date(Date.now() + 60000) },
    { _id: 'd3', controlType: 'DUAL_CACHE', serviceId: row.serviceId, dateYmd: '2026-10-25', resourceId: '', expiresAt: new Date(Date.now() + 60000) },
  ]);
  const out = await RW._invalidateCachesInternal(row.serviceId, ymd, '');
  assert.strictEqual(out.ok, true);
  const left = (wixDataMock._store.get(CONTROL_COL) || []).filter((r) => r.controlType === 'DUAL_CACHE');
  assert.deepStrictEqual(left.map((r) => r._id).sort(), ['d3'], 'only target-day rows removed');
});

test('RES-INV-02 cleanExpiredDualSlots removes expired, keeps alive', async () => {
  resetState();
  wixDataMock._seed(CONTROL_COL, [
    { _id: 'x1', controlType: 'DUAL_CACHE', expiresAt: new Date(Date.now() - 1000) },
    { _id: 'x2', controlType: 'DUAL_CACHE', expiresAt: new Date(Date.now() + 600000) },
  ]);
  const res = await RW._cleanExpiredDualSlotsInternal({ limit: 10 });
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.data.removed, 1);
  const left = (wixDataMock._store.get(CONTROL_COL) || []).map((r) => r._id);
  assert.deepStrictEqual(left, ['x2']);
});

test('RES-INV-03 invalidate with invalid params is a safe no-op', async () => {
  resetState();
  const out = await RW._invalidateCachesInternal('', 'bad-date', '');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.skipped, true);
});

// ---------------------------------------------------------------------------
// DTO-WHITELIST SURFACE (getConfirmedBookingForDisplay)
// ---------------------------------------------------------------------------

test('RES-DISPLAY-01 missing bookingId -> INVALID_PAYLOAD without CMS read', async () => {
  resetState();
  const before = wixDataMock._calls.length;
  const res = await RW.getConfirmedBookingForDisplay({});
  assert.deepStrictEqual(res, { ok: false, data: null, error: 'INVALID_PAYLOAD' });
  assert.strictEqual(wixDataMock._calls.length, before, 'no DB access');
});

test('RES-DISPLAY-02 whitelist projection: forbidden fiscal fields never leak', async () => {
  resetState();
  const bid = 'bk-' + seq;
  wixDataMock._seed(CITAS_COL, [{
    _id: 'r1', bookingId: bid, bookingStatus: 'CONFIRMED', paymentStatus: 'PAID',
    pairToken: 'pt', serviceId: 'svc', dateYmd: '2026-10-25',
    slotStart: new Date('2026-10-25T09:00:00Z'), slotEnd: new Date('2026-10-25T10:00:00Z'),
    resourceId: 'res', totalPrice: 60,
    margin: 0.4, internalNotes: 'secreto', tipoImpositivo: 'IVARIA', codigoImpuesto: 'X',
    payloadFiscal: {}, nifEmisor: 'B123', previousRecordHash: 'h', cuentaContable4300: '4300',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: bid });
  assert.strictEqual(res.ok, true);
  const allowed = new Set(['bookingId', 'bookingStatus', 'paymentStatus', 'pairToken',
    'serviceId', 'dateYmd', 'slotStart', 'slotEnd', 'resourceId', 'totalPrice']);
  for (const k of Object.keys(res.data)) {
    assert.ok(allowed.has(k), `field ${k} not whitelisted`);
  }
});

test('RES-DISPLAY-03 CANCELED hidden (NOT_CONFIRMED), legacy CANCELED normalized', async () => {
  resetState();
  const b1 = 'bk-cancel-' + seq;
  wixDataMock._seed(CITAS_COL, [{ _id: 'r1', bookingId: b1, bookingStatus: 'CANCELLED' }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: b1 });
  assert.deepStrictEqual(res, { ok: false, data: null, error: 'NOT_CONFIRMED' });
  const b2 = 'bk-legacy-' + seq;
  wixDataMock._store.get(CITAS_COL).push({ _id: 'r2', bookingId: b2, status: 'canceled' });
  const res2 = await RW.getConfirmedBookingForDisplay({ bookingId: b2 });
  assert.strictEqual(res2.error, 'NOT_CONFIRMED');
});

test('RES-DISPLAY-04 unknown booking -> NOT_FOUND', async () => {
  resetState();
  wixDataMock._seed(CITAS_COL, []);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'ghost-' + seq });
  assert.deepStrictEqual(res, { ok: false, data: null, error: 'NOT_FOUND' });
});

// ---------------------------------------------------------------------------
// CONTRACT FREEZE (guard de regresion)
// ---------------------------------------------------------------------------

test('RES-CONTRACT-01 exports surface frozen (v10)', () => {
  const expected = [
    '_getServiceBySlugOrIdInternal', '_resolveServiceIdInternal', '_mapServiceImport2ToUX',
    'getServiceForBookingInternal', 'getServiceBySlugOrId', 'resolveServiceId',
    '_toPublicService', '_resolveAddonContextPublic', '_getStaffDisplayNamePublic',
    'revalidateExactAvailabilitySlot', '_resolveStaffForSlotInternal',
    '_cleanExpiredDualSlotsInternal', '_getCertifiedDualSlotsInternal',
    '_invalidateCachesInternal', 'invalidateCachesInternal', 'getAvailableDays',
    'getCertifiedDualSlots', 'getAvailableSlots', 'resolveStaffForSlot',
    'getConfirmedBookingForDisplay',
  ];
  for (const name of expected) {
    assert.ok(name in RW, `missing export: ${name}`);
  }
});
