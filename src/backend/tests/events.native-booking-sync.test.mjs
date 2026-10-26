import test from "node:test";
import assert from "node:assert/strict";
import { wixDataMock } from "./loader.mjs";

const events = await import("backend/events.js");

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const CATALOG_ID = "99999999-9999-4999-8999-999999999999";
const RESOURCE_ID = "33333333-3333-4333-8333-333333333333";
const SCHEDULE_ID = "44444444-4444-4444-8444-444444444444";
const PAIR_TOKEN = "55555555-5555-4555-8555-555555555555";

function nativeBooking(overrides = {}) {
  return {
    _id: BOOKING_ID,
    revision: 3,
    status: "CONFIRMED",
    paymentStatus: "UNDEFINED",
    selectedPaymentOption: "OFFLINE",
    internalBusinessNote: "NOTA INTERNA QA EN AGENDA",
    formSubmissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    startDate: "2026-10-22T09:00:00.000Z",
    endDate: "2026-10-22T09:30:00.000Z",
    bookedEntity: {
      title: "QA Corte Clásico",
      slot: {
        serviceId: SERVICE_ID,
        scheduleId: SCHEDULE_ID,
        startDate: "2026-10-22T09:00:00.000Z",
        endDate: "2026-10-22T09:30:00.000Z",
        resource: { id: RESOURCE_ID, name: "QA Staff" },
        location: { id: "66666666-6666-4666-8666-666666666666", locationType: "BUSINESS" },
      },
    },
    contactDetails: {
      firstName: "QA",
      lastName: "Native Booking",
      email: "qa.native.booking@example.com",
      phone: "+34600000000",
      contactId: "77777777-7777-4777-8777-777777777777",
    },
    additionalFields: [
      { id: "88888888-8888-4888-8888-888888888888", label: "Observaciones", value: "NOTA QA: conservar en el registro" },
    ],
    ...overrides,
  };
}

function bookingConfirmedEvent(eventId, booking) {
  return { metadata: { id: eventId }, data: { booking } };
}

function seedCita(overrides = {}) {
  return {
    _id: "cita-row-1",
    bookingId: BOOKING_ID,
    serviceId: SERVICE_ID,
    scheduleId: SCHEDULE_ID,
    resourceId: RESOURCE_ID,
    slotStart: new Date("2026-10-22T09:00:00.000Z"),
    slotEnd: new Date("2026-10-22T09:30:00.000Z"),
    bookingType: "DUAL_F1",
    pairToken: PAIR_TOKEN,
    bookingStatus: "PENDING",
    paymentStatus: "NOT_PAID",
    totalAmount: 42,
    contactDetails: { firstName: "QA", email: "qa.native.booking@example.com" },
    meta: { pairToken: PAIR_TOKEN, customSaga: true },
    traceId: "trace-custom-saga",
    revision: 2,
    ...overrides,
  };
}

test("EVENT-BOOKING-01 native confirmation creates a canonical CitasF2 projection", async () => {
  wixDataMock._reset();
  wixDataMock._seed("ServiciosCatalogo", [{
    _id: CATALOG_ID,
    serviceId: SERVICE_ID,
    title: "QA Corte Clásico",
  }]);
  const result = await events.wixBookingsV2_onBookingConfirmed(
    bookingConfirmedEvent("evt-native-confirm-001", nativeBooking())
  );

  assert.equal(result.status, "OK");
  assert.equal(result.ledgerCreated, true);

  const rows = wixDataMock._store.get("CitasF2") || [];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.bookingId, BOOKING_ID);
  assert.equal(row.serviceId, SERVICE_ID);
  assert.equal(row.catalogId, CATALOG_ID, "catalogId must reference the internal ServiciosCatalogo CMS item, not the native serviceId");
  assert.equal(row.scheduleId, SCHEDULE_ID);
  assert.equal(row.resourceId, RESOURCE_ID);
  assert.ok(row.slotStart instanceof Date);
  assert.ok(row.slotEnd instanceof Date);
  assert.equal(row.dateYmd, "2026-10-22");
  assert.ok(row.traceId, "native projection must be traceable");
  assert.equal(row.bookingType, "SIMPLE");
  assert.equal(row.sourceEventId, "evt-native-confirm-001");
  assert.equal(row.meta.projectionRole, "AUXILIARY_BOOKING_LEDGER");
  assert.equal(row.meta.projectionKind, "NATIVE_BOOKING_CONFIRMED");
  assert.equal(row.bookingStatus, "CONFIRMED");
  assert.equal(row.paymentStatus, "NOT_PAID");
  assert.equal(row.totalAmount, 0);
  assert.equal(row.meta.source, "WIX_BOOKINGS_NATIVE");
  assert.equal(row.meta.selectedPaymentOption, "OFFLINE");
  assert.equal(row.meta.channelType, "PRESENCIAL");
  assert.equal(row.meta.contactId, "77777777-7777-4777-8777-777777777777");
  assert.equal(row.meta.amountReconciliationRequired, true);
  assert.equal(row.meta.amountSource, "NOT_EXPOSED_BY_BOOKINGS");
  const reconciliationTasks = wixDataMock._store.get("ControlOperativo") || [];
  const amountTask = reconciliationTasks.find(task =>
    task.controlType === "RECONCILIATION" && task.kind === "BOOKING_AMOUNT" &&
    task.bookingId === BOOKING_ID
  );
  assert.ok(amountTask, "missing native amount must create a reconciliation task");
  assert.equal(amountTask.reason, "NATIVE_BOOKING_AMOUNT_NOT_EXPOSED");
  assert.equal(amountTask.amountSource, "NOT_EXPOSED_BY_BOOKINGS");
  assert.equal(amountTask.sourceEventId, "evt-native-confirm-001");
  assert.equal(row.meta.appointmentNote, "NOTA INTERNA QA EN AGENDA");
  assert.equal(row.meta.formSubmissionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(row.meta.appointmentNotes, [
    { label: "Observaciones", value: "NOTA QA: conservar en el registro" },
  ]);

  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(markers.filter(row => row.dedupeKey === "WEBHOOK_evt-native-confirm-001").length, 1);
  assert.equal(markers.filter(row => row.kind === "BOOKING_AMOUNT" && row.bookingId === BOOKING_ID).length, 1,
    "replaying the same native booking must not duplicate the reconciliation task");
});

test("EVENT-BOOKING-02 confirmation preserves custom dual metadata and pair token", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [seedCita()]);

  const result = await events.wixBookingsV2_onBookingConfirmed(
    bookingConfirmedEvent("evt-native-confirm-002", nativeBooking({ _id: BOOKING_ID, status: "CONFIRMED" }))
  );

  assert.equal(result.status, "OK");
  assert.equal(result.ledgerCreated, false);
  const rows = wixDataMock._store.get("CitasF2") || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bookingType, "DUAL_F1");
  assert.equal(rows[0].pairToken, PAIR_TOKEN);
  assert.equal(rows[0].sourceEventId, undefined, "la proyeccion nativa no debe reemplazar el registro rico de la saga dual");
  assert.equal(rows[0].meta.customSaga, true);
  assert.equal(rows[0].bookingStatus, "CONFIRMED");
});

test("EVENT-BOOKING-03 repairs a processed webhook whose CitasF2 row is missing", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("ControlOperativo", [{
    _id: "webhook-marker-existing",
    controlType: "WEBHOOK_EVENT",
    dedupeKey: "WEBHOOK_evt-native-confirm-003",
    eventId: "evt-native-confirm-003",
    status: "COMPLETED",
    traceId: "trace-old",
    payload: { eventType: "BOOKING_CONFIRMED" },
  }]);

  const result = await events.wixBookingsV2_onBookingConfirmed(
    bookingConfirmedEvent("evt-native-confirm-003", nativeBooking({ _id: "99999999-9999-4999-8999-999999999999" }))
  );

  assert.equal(result.status, "OK");
  assert.equal(result.ledgerCreated, true);
  const rows = wixDataMock._store.get("CitasF2") || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bookingId, "99999999-9999-4999-8999-999999999999");
  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(markers.filter(row => row.dedupeKey === "WEBHOOK_evt-native-confirm-003").length, 1);
});

test("EVENT-BOOKING-04 normalizes the documented Wix confirmed-webhook envelope", async () => {
  wixDataMock._reset();
  const booking = nativeBooking();
  booking.id = booking._id;
  delete booking._id;
  delete booking.status;

  const result = await events.wixBookingsV2_onBookingConfirmed({
    id: "evt-wix-platform-confirm-004",
    entityFqdn: "wix.bookings.v2.booking",
    slug: "confirmed",
    entityId: booking.id,
    actionEvent: { body: { booking } },
  });

  assert.equal(result.status, "OK");
  assert.equal(result.ledgerCreated, true);
  const rows = wixDataMock._store.get("CitasF2") || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bookingId, BOOKING_ID);
  assert.equal(rows[0].bookingType, "SIMPLE");
  assert.equal(rows[0].sourceEventId, "evt-wix-platform-confirm-004");
  assert.equal(rows[0].bookingStatus, "CONFIRMED");
});

test("EVENT-BOOKING-05 does not acknowledge a projection write-path failure as success", async () => {
  wixDataMock._reset();
  wixDataMock._findErrors.set("CitasF2", new Error("QA_FORCED_CITASF2_READ_FAILURE"));

  await assert.rejects(
    events.wixBookingsV2_onBookingConfirmed(
      bookingConfirmedEvent("evt-native-confirm-failure-005", nativeBooking())
    ),
    /QA_FORCED_CITASF2_READ_FAILURE/
  );

  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(
    markers.some(row => row.dedupeKey === "WEBHOOK_evt-native-confirm-failure-005"),
    false,
    "failed projection must not be marked processed"
  );
});


test("EVENT-BOOKING-06 fails closed when webhook idempotency read fails", async () => {
  wixDataMock._reset();
  wixDataMock._findErrors.set(
    "ControlOperativo",
    new Error("QA_FORCED_WEBHOOK_IDEMPOTENCY_READ_FAILURE")
  );

  await assert.rejects(
    events.wixBookingsV2_onBookingConfirmed(
      bookingConfirmedEvent("evt-native-confirm-failure-006", nativeBooking())
    ),
    /QA_FORCED_WEBHOOK_IDEMPOTENCY_READ_FAILURE/
  );

  assert.equal(
    (wixDataMock._store.get("CitasF2") || []).length,
    0,
    "a failed idempotency read must not proceed to mutate the booking ledger"
  );
});

test("EVENT-BOOKING-07 does not acknowledge a webhook when its processed marker cannot be persisted", async () => {
  wixDataMock._reset();
  wixDataMock._insertErrors.set(
    "ControlOperativo",
    new Error("QA_FORCED_WEBHOOK_MARKER_WRITE_FAILURE")
  );

  await assert.rejects(
    events.wixBookingsV2_onBookingConfirmed(
      bookingConfirmedEvent("evt-native-confirm-failure-007", nativeBooking())
    ),
    /QA_FORCED_WEBHOOK_MARKER_WRITE_FAILURE/
  );

  assert.equal(
    (wixDataMock._store.get("CitasF2") || []).length,
    1,
    "the durable booking projection can exist even when the processed marker fails"
  );
  assert.equal(
    (wixDataMock._store.get("ControlOperativo") || []).length,
    0,
    "a failed marker write must not create a false processed record"
  );

  wixDataMock._insertErrors.delete("ControlOperativo");
  const replay = await events.wixBookingsV2_onBookingConfirmed(
    bookingConfirmedEvent("evt-native-confirm-failure-007", nativeBooking())
  );
  assert.equal(replay.status, "OK");
  assert.equal(replay.ledgerCreated, false, "replay should reuse the existing CitasF2 row");
  assert.equal(
    (wixDataMock._store.get("ControlOperativo") || [])
      .filter(row => row.dedupeKey === "WEBHOOK_evt-native-confirm-failure-007").length,
    1,
    "successful replay must persist exactly one processed marker"
  );
});


test("EVENT-CANCEL-RETRY-01 cancellation idempotency read failure is not acknowledged", async () => {
  wixDataMock._reset();
  wixDataMock._findErrors.set("ControlOperativo", new Error("idempotency store unavailable"));

  await assert.rejects(
    events.wixBookingsV2_onBookingCanceled({
      eventId: "evt-cancel-idempotency-read-failure",
      booking: { id: BOOKING_ID },
    }),
    /idempotency store unavailable/
  );
});

test("EVENT-CANCEL-RETRY-02 paid cancellation movement lookup failure is not acknowledged", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [
    seedCita({
      bookingStatus: "CONFIRMED",
      paymentStatus: "PAID",
    }),
  ]);
  wixDataMock._findErrors.set("MovimientosCaja", new Error("cash ledger unavailable"));

  await assert.rejects(
    events.wixBookingsV2_onBookingCanceled({
      eventId: "evt-cancel-paid-movement-read-failure",
      booking: { id: BOOKING_ID },
    }),
    /cash ledger unavailable/
  );

  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(
    markers.some((row) => row.eventId === "evt-cancel-paid-movement-read-failure"),
    false,
    "a failed cancellation must not persist the processed marker"
  );
});


test("EVENT-CANCEL-RETRY-03 missing cancellation event ID is rejected without synthetic identity", async () => {
  wixDataMock._reset();

  await assert.rejects(
    events.wixBookingsV2_onBookingCanceled({
      booking: { id: BOOKING_ID },
    }),
    /BOOKING_CANCELED_EVENT_ID_REQUIRED/
  );

  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(markers.length, 0, "missing event ID must not create an idempotency marker");
});

test("EVENT-CANCEL-RETRY-04 paid cancellation without cash movement remains retryable", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [
    seedCita({
      bookingStatus: "CONFIRMED",
      paymentStatus: "PAID",
    }),
  ]);

  await assert.rejects(
    events.wixBookingsV2_onBookingCanceled({
      eventId: "evt-cancel-paid-movement-missing",
      booking: { id: BOOKING_ID },
    }),
    /CANCELED_PAID_BOOKING_MOVEMENT_NOT_FOUND/
  );

  const markers = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(
    markers.some((row) => row.eventId === "evt-cancel-paid-movement-missing"),
    false,
    "a paid cancellation without its fiscal source must not be marked complete"
  );
});


test("EVENT-IDEMPOTENCY-01 long event IDs use the same normalized key for lookup and persistence", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [
    seedCita({
      bookingStatus: "CANCELED",
      paymentStatus: "NOT_PAID",
    }),
  ]);
  const eventId = "evt-" + "x".repeat(110);
  const event = {
    eventId,
    booking: { id: BOOKING_ID },
  };

  const first = await events.wixBookingsV2_onBookingCanceled(event);
  assert.equal(first.status, "OK");

  const second = await events.wixBookingsV2_onBookingCanceled(event);
  assert.equal(second.status, "OK");
  assert.equal(second.duplicate, true, "same long event ID must be detected as already processed");
});


test("EVENT-BOOKING-LIFECYCLE-01 native booking-created event creates a pending projection without forcing confirmation", async () => {
  wixDataMock._reset();
  const result = await events.wixBookingsV2_onBookingCreated({
    id: "evt-native-created-001",
    entityFqdn: "wix.bookings.v2.booking",
    slug: "created",
    entityId: BOOKING_ID,
    createdEvent: {
      entity: nativeBooking({ status: "PENDING" }),
    },
  });

  assert.equal(result.status, "OK");
  assert.equal(result.ledgerCreated, true);
  const row = (wixDataMock._store.get("CitasF2") || [])[0];
  assert.equal(row.bookingStatus, "PENDING");
  assert.equal(row.meta.projectionKind, "NATIVE_BOOKING_CREATED");
});

test("EVENT-BOOKING-LIFECYCLE-02 native booking-updated event refreshes a simple booking slot", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [
    seedCita({
      bookingType: "SIMPLE",
      pairToken: null,
      bookingStatus: "CONFIRMED",
      slotStart: new Date("2026-10-22T09:00:00.000Z"),
      slotEnd: new Date("2026-10-22T09:30:00.000Z"),
    }),
  ]);
  const updatedBooking = nativeBooking({
    status: "CONFIRMED",
    startDate: "2026-10-23T10:00:00.000Z",
    endDate: "2026-10-23T10:30:00.000Z",
    bookedEntity: {
      title: "QA Corte Clásico",
      slot: {
        serviceId: SERVICE_ID,
        scheduleId: SCHEDULE_ID,
        startDate: "2026-10-23T10:00:00.000Z",
        endDate: "2026-10-23T10:30:00.000Z",
        resource: { id: RESOURCE_ID, name: "QA Staff" },
      },
    },
  });

  const result = await events.wixBookingsV2_onBookingUpdated({
    id: "evt-native-updated-001",
    entityFqdn: "wix.bookings.v2.booking",
    slug: "updated",
    entityId: BOOKING_ID,
    updatedEvent: { currentEntityAsJson: updatedBooking },
  });

  assert.equal(result.status, "OK");
  const row = (wixDataMock._store.get("CitasF2") || [])[0];
  assert.equal(row.slotStart.toISOString(), "2026-10-23T10:00:00.000Z");
  assert.equal(row.slotEnd.toISOString(), "2026-10-23T10:30:00.000Z");
  assert.equal(row.dateYmd, "2026-10-23");
});

test("EVENT-BOOKING-LIFECYCLE-03 native reschedule of a dual phase creates reconciliation without breaking the pair", async () => {
  wixDataMock._reset();
  wixDataMock._store.set("CitasF2", [seedCita()]);
  const rescheduledBooking = nativeBooking({
    status: "CONFIRMED",
    startDate: "2026-10-23T11:00:00.000Z",
    endDate: "2026-10-23T11:30:00.000Z",
    bookedEntity: {
      title: "QA Corte Clásico",
      slot: {
        serviceId: SERVICE_ID,
        scheduleId: SCHEDULE_ID,
        startDate: "2026-10-23T11:00:00.000Z",
        endDate: "2026-10-23T11:30:00.000Z",
        resource: { id: RESOURCE_ID, name: "QA Staff" },
      },
    },
  });

  const result = await events.wixBookingsV2_onBookingRescheduled({
    id: "evt-native-rescheduled-001",
    entityFqdn: "wix.bookings.v2.booking",
    slug: "rescheduled",
    entityId: BOOKING_ID,
    actionEvent: { body: { booking: rescheduledBooking } },
  });

  assert.equal(result.status, "OK");
  assert.equal(result.reconciliationRequired, true);
  const row = (wixDataMock._store.get("CitasF2") || [])[0];
  assert.equal(row.slotStart.toISOString(), "2026-10-22T09:00:00.000Z");
  assert.equal(row.pairToken, PAIR_TOKEN);
  const tasks = wixDataMock._store.get("ControlOperativo") || [];
  assert.ok(tasks.some((item) => item.kind === "NATIVE_DUAL_BOOKING_CHANGE"));
});
