import test from "node:test";
import assert from "node:assert/strict";
import { wixDataMock } from "./loader.mjs";

const security = await import("backend/security.js");
const { hashSHA256 } = await import("backend/securityEngine");

test("SEC-RL-CMS-01 persistent rate-limit blocks use canonical ControlOperativo records", async () => {
  wixDataMock._reset();
  security._resetRateLimitCacheForTests();

  const registered = await security.registerPersistentBlock(
    "availability",
    "member-qa-001",
    60_000,
    "trace-rate-limit-001"
  );

  assert.equal(registered.status, "SUCCESS");
  const rows = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].controlType, "RATE_LIMIT");
  assert.equal(
    rows[0].dedupeKey,
    `RATE_LIMIT:availability:${await hashSHA256("availability:member-qa-001")}`
  );
  assert.doesNotMatch(rows[0].dedupeKey, /member-qa-001/, "CMS keys must not expose raw visitor identifiers");
  assert.equal(rows[0].traceId, "trace-rate-limit-001");
  assert.ok(rows[0].expiresAt instanceof Date);
  assert.equal(typeof rows[0].payload, "object");

  security._resetRateLimitCacheForTests();
  const lookup = await security.checkPersistentRateLimitBlock(
    "availability",
    "member-qa-001",
    "trace-rate-limit-002"
  );
  assert.equal(lookup.blocked, true);
  assert.ok(lookup.retryAfter > 0);
});

test("SEC-RL-CMS-02 expired persistent block is renewed in place, not duplicated", async () => {
  wixDataMock._reset();
  security._resetRateLimitCacheForTests();
  wixDataMock._store.set("ControlOperativo", [{
    _id: "RL_existing_test_record",
    controlType: "RATE_LIMIT",
    dedupeKey: `RATE_LIMIT:availability:${await hashSHA256("availability:member-qa-002")}`,
    status: "ACTIVE",
    expiresAt: new Date(Date.now() - 60_000),
    traceId: "trace-rate-limit-old",
    payload: { surface: "availability", key: "member-qa-002" },
  }]);

  const result = await security.registerPersistentBlock(
    "availability",
    "member-qa-002",
    60_000,
    "trace-rate-limit-renew"
  );

  assert.equal(result.status, "SUCCESS");
  const rows = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(rows.length, 1, "expired record should be reused instead of creating duplicates");
  assert.equal(rows[0]._id, "RL_existing_test_record");
  assert.equal(rows[0].traceId, "trace-rate-limit-renew");
  assert.ok(new Date(rows[0].expiresAt).getTime() > Date.now());
});


test("SEC-RL-CMS-03 repeated block registration renews the same canonical row", async () => {
  wixDataMock._reset();
  security._resetRateLimitCacheForTests();

  const first = await security.registerPersistentBlock(
    "availability",
    "member-qa-003",
    60_000,
    "trace-rate-limit-first"
  );
  assert.equal(first.status, "SUCCESS");

  const second = await security.registerPersistentBlock(
    "availability",
    "member-qa-003",
    120_000,
    "trace-rate-limit-second"
  );
  assert.equal(second.status, "SUCCESS");
  assert.equal(second.alreadyBlocked, true);

  const rows = wixDataMock._store.get("ControlOperativo") || [];
  assert.equal(rows.length, 1, "same surface/key must not create duplicate rows");
});
