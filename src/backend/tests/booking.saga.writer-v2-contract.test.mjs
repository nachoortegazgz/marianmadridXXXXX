import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..");
const read = (path) => readFileSync(join(backend, path), "utf8");
const saga = read("booking/bookingSaga.js");
const core = read("booking/bookingCore.js");
const reservations = read("reservas.web.js");
const crons = read("crons.js");
const events = read("events.js");

test("BOOKINGS-CONTRACT-01 Writer V2 slot uses SDK _id and resource scheduleId", () => {
  assert.match(core, /resource:\s*\{\s*_id:\s*resourceIdClean,\s*scheduleId\s*\}/);
  assert.match(core, /Object\.freeze\(\{ _id: incoming, locationType: "OWNER_BUSINESS" \}\)/);
  assert.match(saga, /pristineSlot\.resource\._id/);
  assert.match(saga, /pristineSlot\.resource\.scheduleId/);
  assert.match(saga, /pristineSlot\.location\._id/);
});

test("BOOKINGS-CONTRACT-02 Availability SDK uses _id for business location and cache identity", () => {
  assert.match(reservations, /Object\.freeze\(\{ _id: locationId, locationType: "BUSINESS" \}\)/);
  assert.match(reservations, /const locationKey = location._id;/);
});

test("BOOKINGS-CONTRACT-03 load balancing reads SDK extended booking _id and resource _id", () => {
  assert.match(reservations, /const bookingId = _safeTrim\(booking._id\);/);
  assert.match(reservations, /bookedEntity\?\.slot\?\.resource\?._id/);
});

test("BOOKINGS-CONTRACT-04 dual reconciliation reads SDK getBooking response _id", () => {
  assert.match(crons, /f1Exists = !!f1Booking\?\.booking\?._id;/);
  assert.match(crons, /f2Exists = !!f2Booking\?\.booking\?._id;/);
});

test("BOOKINGS-CONTRACT-05 webhook adapter keeps webhook-specific id shape", () => {
  assert.match(events, /const resourceId = _safeTrim\(resource\.id \|\| booking\?\.resource\?\.id\);/);
});

test("BOOKINGS-CONTRACT-06 simple projection does not persist its internal transaction token", () => {
  assert.match(saga, /bookingType: isDual \? BOOKING_TYPE\.DUAL_F1 : BOOKING_TYPE\.SIMPLE,[\s\S]{0,180}pairToken: isDual \? pairToken : null/);
  assert.match(saga, /pairToken: isDual \? pairToken : null,[\s\S]{0,80}pairTokenSource: isDual \? tokenResolution\.source : null/);
});

test("BOOKINGS-CONTRACT-07 F2 preserves Wix native availability validation", () => {
  assert.match(saga, /const f2Options = Object\.freeze\(\{\s*flowControlSettings: Object\.freeze\(\{\s*\/\/ Keep Wix's native final availability guard enabled\.[\s\S]{0,220}skipAvailabilityValidation: false,/);
  assert.doesNotMatch(saga, /skipSelectedPaymentOptionValidation:\s*true/);
});
