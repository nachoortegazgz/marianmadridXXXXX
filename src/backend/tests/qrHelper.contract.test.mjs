import test from "node:test";
import assert from "node:assert/strict";
import {
  AEAT_VERIFACTU_ENDPOINTS,
  generateVerifactuQrUrl,
  extractVerifactuData,
  buildVerifactuReceiptHtml,
} from "public/qrHelper";

test("QR-LEDGER-01 reads cash ledger hash from canonical hash field", () => {
  const data = extractVerifactuData({
    nifEmisor: "B12345678",
    numSerieFactura: "F-2026-001",
    fechaExpedicionFactura: "26/10/2026",
    totalAmount: 121,
    hash: "sha256-ledger-hash",
    recordHash: "obsolete-field-must-not-win",
    digitalSignature: "signature",
  });
  assert.equal(data.recordHash, "sha256-ledger-hash");
  assert.ok(data.qrUrl);
  assert.ok(data.qrUrl.startsWith(AEAT_VERIFACTU_ENDPOINTS.VERIFICATION_BASE_URL));
  assert.match(data.qrUrl, /[?&]importe=121(?:&|$)/);
  assert.doesNotMatch(data.qrUrl, /[?&]hash=/);
});

test("QR-LEDGER-02 missing or invalid total suppresses QR instead of fabricating zero", () => {
  for (const totalAmount of [undefined, null, "", "not-a-number"]) {
    const data = extractVerifactuData({
      nifEmisor: "B12345678",
      numSerieFactura: "F-2026-002",
      fechaExpedicionFactura: "26/10/2026",
      totalAmount,
      hash: "hash",
    });
    assert.equal(data.totalAmount, null);
    assert.equal(data.qrUrl, null);
    assert.equal(buildVerifactuReceiptHtml({
      nifEmisor: "B12345678",
      numSerieFactura: "F-2026-002",
      fechaExpedicionFactura: "26/10/2026",
      totalAmount,
      hash: "hash",
    }), "");
  }
});

test("QR-LEDGER-03 explicit zero is not confused with a missing amount", () => {
  const data = extractVerifactuData({
    nifEmisor: "B12345678",
    numSerieFactura: "F-2026-003",
    fechaExpedicionFactura: "26/10/2026",
    totalAmount: 0,
    hash: "hash",
  });
  assert.equal(data.totalAmount, "0");
  assert.ok(data.qrUrl);
  assert.match(data.qrUrl, /[?&]importe=0(?:&|$)/);
});
