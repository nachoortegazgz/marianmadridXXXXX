import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..");
const root = join(here, "..", "..", "..");
const read = (path) => readFileSync(path, "utf8");

const staffRuntime = read(join(backend, "staff.js"));
const bookingCore = read(join(backend, "booking", "bookingCore.js"));
const staffContract = read(join(root, "docs", "CMS_STAFF_MAP.md"));
const cmsDictionary = read(join(root, "docs", "CMS KEYFIELDS.md"));

test("CMS-ID-01 MapaStaff runtime consumes canonical identity keys only", () => {
  for (const key of [
    "resourceId",
    "staffMemberId",
    "memberId",
    "scheduleId",
    "staffName",
    "rolBookings",
    "rolWebsite",
    "thirdPartyId",
    "active",
  ]) {
    assert.ok(staffContract.includes("`" + key + "`"), "CMS staff contract must document " + key);
  }

  assert.match(staffRuntime, /mapping\.staffMemberId/);
  assert.match(staffRuntime, /mapping\.memberId/);
  assert.match(staffRuntime, /mapping\.resourceId/);
  assert.match(staffRuntime, /mapping\.scheduleId/);
  assert.doesNotMatch(staffRuntime, /mapping\.wixStaffMemberId/,
    "wixStaffMemberId is not a current CMS field and must never be read by runtime");
  assert.doesNotMatch(staffRuntime, /mapping\.displayName/,
    "CMS displayName is not an alias for canonical staffName");
});

test("CMS-ID-02 CMS documentation distinguishes resource, staff profile, and site member IDs", () => {
  assert.match(staffContract, /resourceId[^\n]*native Bookings resource ID/i);
  assert.match(staffContract, /staffMemberId[^\n]*Bookings staff profile ID/i);
  assert.match(staffContract, /memberId[^\n]*Wix Site Member ID/i);
  assert.match(staffContract, /distinct from `resourceId`/i);
});

test("CMS-ID-03 schedule resolver prefers the native slot schedule and uses event schedule only as fallback", () => {
  const start = bookingCore.indexOf("export async function _resolveScheduleIdForResource");
  const end = bookingCore.indexOf("// BLOCK", start + 1);
  assert.notEqual(start, -1, "canonical schedule resolver must exist");
  const resolver = bookingCore.slice(start, end === -1 ? start + 1800 : end);
  assert.match(resolver, /resource\.eventsSchedule\?\.id/);
  assert.match(resolver, /resource\.eventsSchedule\?\._id/);
  const slotScheduleIndex = resolver.indexOf("s.scheduleId || nestedSlot.scheduleId || schedule.id");
  const resourceScheduleIndex = resolver.indexOf("resource.eventsSchedule?.id");
  assert.ok(slotScheduleIndex >= 0, "native slot scheduleId must be considered");
  assert.ok(resourceScheduleIndex > slotScheduleIndex, "native slot scheduleId must take precedence over resource fallback");
  assert.doesNotMatch(resolver, /workingHoursSchedules/,
    "working-hours schedule is not the events schedule used for booking creation");
});

test("CMS-ID-04 service, catalog, and slot schedule identifiers remain distinct", () => {
  const citasStart = cmsDictionary.indexOf("## CitasF2");
  const servicesStart = cmsDictionary.indexOf("## ServiciosCatalogo", citasStart);
  const citasContract = cmsDictionary.slice(citasStart, servicesStart);
  assert.match(citasContract, /\| serviceId \| servicioId \| TEXT[^\n]*ID del servicio Wix Bookings, distinto del catálogo interno/i);
  assert.match(citasContract, /\| catalogId \| catalogoId \| TEXT[^\n]*ID del elemento de ServiciosCatalogo \(`_id`\), distinto de `serviceId`/i);
  assert.match(citasContract, /\| scheduleId \| calendarioId \| TEXT[^\n]*slot nativo de Wix Bookings/i);
  assert.match(staffContract, /Match a catalog item to Bookings only by `serviceId`/);
});

test("CMS-ID-05 catalog locationId is configuration; Writer V2 location payload uses its native id key", () => {
  assert.match(cmsDictionary, /\| locationId \| ubicacionId \| TEXT/);
  assert.match(bookingCore, /slotLocation && slotLocation\.id/);
  assert.match(bookingCore, /Object\.freeze\(\{ id: incoming, locationType: "OWNER_BUSINESS" \}\)/);
});
