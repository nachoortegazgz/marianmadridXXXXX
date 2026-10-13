import test from 'node:test';
const { wixDataMock, mocks } = await import('./loader.mjs');
mocks.webMethods.register('@wix/bookings', 'availabilityTimeSlots::listAvailabilityTimeSlots', async (payload) => {
  console.log('MOCK CALLED payload=', JSON.stringify(payload));
  return { timeSlots: [] };
});
const RW = await import('backend/reservas.web.js');

let seq = 0;
function guid() {
  seq += 1;
  const h = String(seq).padStart(8, '0');
  return `${h}-${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(0, 3)}-${h}${h}${h}abcdef`.slice(0, 36);
}
function availSlot(startLocal, endLocal, staffIds) {
  return { localStartDate: startLocal, localEndDate: endLocal, bookable: true,
    availableResources: [{ resourceTypeId: '1cd44cf8-756f-41c3-bd90-3e2ffcaf1155', resources: staffIds.map((id) => ({ id })) }] };
}
function baseServiceRow(over = {}) {
  return { serviceId: guid(), slug: null, title: 'Peluqueria', tagLine: null, description: null, price: 60, currency: 'EUR',
    location: 'Zaragoza', locationId: [guid()], mainMedia: null, totalDuration: 90, phase1Duration: 60, phase2Duration: 0,
    exposureDuration: 0, allowCombine: false, linkedPhases: null, clientHidden: false, availableStaff: [], addOnOptions: [], ...over };
}
function seedService(row) {
  const rows = wixDataMock._store.get('ServiciosCatalogo') || [];
  rows.push({ _id: row.serviceId, ...row });
  wixDataMock._store.set('ServiciosCatalogo', rows);
  return row;
}

test('dbg3', async () => {
  wixDataMock._reset();
  const st1 = guid();
  const other = guid();
  console.log('st1=', st1, 'other=', other);
  const row = baseServiceRow({ availableStaff: [st1] });
  seedService(row);
  mocks.webMethods.register('@wix/bookings', 'availabilityTimeSlots::listAvailabilityTimeSlots', async (payload) => {
    console.log('MOCK2 CALLED=', JSON.stringify(payload));
    return { timeSlots: [availSlot('2026-10-20T09:00:00', '2026-10-20T10:00:00', [])] };
  });
  const res = await RW._resolveStaffForSlotInternal({ serviceId: row.serviceId, f1Start: '2026-10-20T09:00:00', requestedResourceId: other });
  console.log('RES=', JSON.stringify(res));
});
