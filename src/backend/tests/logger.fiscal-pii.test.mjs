import test from "node:test";
import assert from "node:assert/strict";
import { logger } from "backend/logger";

test("LOG-PII-01 fiscal identifiers, invoice numbers, signatures and AEAT payloads are redacted", () => {
  const originalInfo = console.info;
  const lines = [];
  console.info = (line) => lines.push(String(line));
  try {
    logger.info("fiscal movement", {
      nifEmisor: "B12345678",
      nifDestinatario: "12345678Z",
      numSerieFactura: "F-2026-123",
      digitalSignature: "PRIVATE-SIGNATURE",
      aeatPayload: "SENSITIVE-AEAT-PAYLOAD",
      payloadAEAT: "SENSITIVE-CANONICAL-AEAT-PAYLOAD",
      totalAmount: 121.5,
    });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(lines.length, 1);
  const line = lines[0];
  for (const secret of [
    "B12345678",
    "12345678Z",
    "F-2026-123",
    "PRIVATE-SIGNATURE",
    "SENSITIVE-AEAT-PAYLOAD",
    "SENSITIVE-CANONICAL-AEAT-PAYLOAD",
  ]) {
    assert.equal(line.includes(secret), false, "log leaked " + secret);
  }
  assert.equal((line.match(/\[REDACTED_SECRET\]/g) || []).length, 6);
  assert.ok(line.includes('"totalAmount":121.5'), "non-sensitive operational value should remain");
});
