import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'booking', 'bookingSaga.js'), 'utf8');

test('BOOKING-DOUBLE-01 aborts saga when Wix flags a double-booked slot', () => {
  const guardStart = source.indexOf('function _checkDoubleBookingFlag(');
  const guardEnd = source.indexOf('// BLOCK 8 - GAP VALIDACION', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'double-booking guard must exist');

  const guard = source.slice(guardStart, guardEnd);
  assert.match(guard, /booking\.doubleBooked\s*===\s*true/);
  assert.match(guard, /throw createBookingError\(/, 'double-booking must abort the saga');
  assert.match(guard, /ERROR_CODES\.BOOKING_CREATION_FAILED/);

  const f1Start = source.indexOf('const bookingF1 = (resF1 && resF1.booking) || resF1;');
  const f1End = source.indexOf('let bookingF2 = null;', f1Start);
  assert.ok(f1Start >= 0 && f1End > f1Start, 'F1 creation block must exist');
  const f1 = source.slice(f1Start, f1End);
  assert.ok(f1.indexOf('createdBookings.push({') < f1.indexOf('_checkDoubleBookingFlag(bookingF1'),
    'F1 must be tracked before the guard can throw so compensation can cancel it');

  const f2Start = source.indexOf('bookingF2 = (resF2 && resF2.booking) || resF2;');
  const f2End = source.indexOf('return {', f2Start);

  const f2End = source.indexOf('\n                }\n\n                return {', f2Start);
  assert.ok(f2Start >= 0 && f2End > f2Start, 'F2 creation block must exist');
  const f2 = source.slice(f2Start, f2End);
  assert.ok(f2.indexOf('createdBookings.push({') < f2.indexOf('_checkDoubleBookingFlag(bookingF2'),
    'F2 must be tracked before the guard can throw so compensation can cancel both phases');

  const confirmIndex = source.indexOf('_checkDoubleBookingFlag(confirmResult, "CONFIRM_" + booking.phase, traceId);');
  assert.ok(confirmIndex >= 0, 'confirmation result must also be checked for double booking');
  assert.match(source, /async function _compensateCreatedBookings\(/,
    'saga compensation must exist for created bookings');
});
