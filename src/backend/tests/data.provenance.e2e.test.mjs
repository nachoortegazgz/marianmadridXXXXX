import test from "node:test";
import assert from "node:assert/strict";
import { wixDataMock } from "./loader.mjs";

const inventory = await import("backend/inventario.web.js");

const STOCK_COLLECTION = "InventarioStockVenta";
const MOVEMENT_COLLECTION = "MovimientosInventario";

function seedStock(overrides = {}) {
  wixDataMock._reset();
  wixDataMock._seed(STOCK_COLLECTION, [{
    _id: "stock-row-001",
    stockId: "stock-001",
    sku: "SKU-CHAMPU-001",
    productId: "catalog-product-001",
    variantId: "catalog-variant-001",
    name: "Champu QA",
    wixProductId: "wix-product-001",
    wixVariantId: "wix-variant-001",
    stockOnHand: 12,
    stockReserved: 2,
    stockAvailable: 10,
    ...overrides,
  }]);
}

function stockRow() {
  return (wixDataMock._store.get(STOCK_COLLECTION) || [])[0];
}

function movementRows() {
  return wixDataMock._store.get(MOVEMENT_COLLECTION) || [];
}

test("INV-VAL-01 invalid movement type is rejected before any CMS write", async () => {
  seedStock();
  const beforeCalls = wixDataMock._calls.length;
  const result = await inventory.recordInventoryMovementSafe(
    "SKU-CHAMPU-001",
    "FOO",
    1,
    { movementToken: "invalid-type-token" }
  );
  assert.equal(result.status, "ERROR");
  assert.equal(result.error.code, "INVALID_MOVEMENT_TYPE");
  assert.equal(movementRows().length, 0);
  assert.equal(wixDataMock._calls.length, beforeCalls);
});

test("INV-E2E-01 eCommerce order writes canonical sale with source IDs and complete trace", async () => {
  seedStock();
  const result = await inventory.recordOnlineInventoryOrderInternal({
    _id: "order-e2e-001",
    lineItems: [{ sku: "SKU-CHAMPU-001", quantity: 2 }],
  }, "trace-order-e2e-001", {
    sourceEventId: "event-order-e2e-001",
    thirdPartyId: "B12345678",
  });

  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.data, [{ sku: "SKU-CHAMPU-001", status: "SUCCESS" }]);
  const rows = movementRows();
  assert.equal(rows.length, 1);
  const row = rows[0];

  assert.equal(row.movementType, "VENTA");
  assert.match(row.movementId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(row.movementId, row.movementToken);
  assert.equal(row.sku, "SKU-CHAMPU-001");
  assert.equal(row.productName, "Champu QA");
  assert.equal(row.wixProductId, "wix-product-001");
  assert.equal(row.wixVariantId, "wix-variant-001");
  assert.equal(row.catalogId, "catalog-product-001");
  assert.equal(row.referenceId, null);
  assert.equal(row.orderId, "order-e2e-001");
  assert.equal(row.refundId, null);
  assert.equal(row.actorEmail, null);
  assert.equal(row.actorMemberId, null);
  assert.equal(row.sourceEventId, "event-order-e2e-001");
  assert.equal(row.thirdPartyId, "B12345678");
  assert.equal(row.quantity, 2);
  assert.equal(row.quantityDelta, -2);
  assert.equal(row.stockBefore, 12);
  assert.equal(row.stockAfter, 10);
  assert.equal(row.magnitude, -1);
  assert.equal(row.nativeCommercialMovement, true);
  assert.equal(row.requiresWixReconciliation, true);
  assert.equal(row.traceId, "trace-order-e2e-001");
  assert.ok(row.recordTimestamp instanceof Date, "recordTimestamp must be a persisted Date");
  assert.ok(row.movementToken, "idempotency token must be persisted");
  assert.equal(stockRow().stockOnHand, 10);
  assert.equal(stockRow().stockAvailable, 8);
  assert.ok(stockRow().lastInventoryMovementAt instanceof Date);
  assert.equal(stockRow().lastInventoryMovementId, row._id);
  assert.equal(stockRow().stockAvailable, stockRow().stockOnHand - stockRow().stockReserved);

  // Replaying the same native order must not decrement stock twice.
  const replay = await inventory.recordOnlineInventoryOrderInternal({
    _id: "order-e2e-001",
    lineItems: [{ sku: "SKU-CHAMPU-001", quantity: 2 }],
  }, "trace-order-e2e-001", {
    sourceEventId: "event-order-e2e-001",
    thirdPartyId: "B12345678",
  });
  assert.equal(replay.status, "SUCCESS");
  assert.equal(movementRows().length, 1);
  assert.equal(stockRow().stockOnHand, 10);
});

test("INV-E2E-02 confirmed eCommerce refund writes canonical return and restores stock", async () => {
  seedStock({ stockOnHand: 10, stockReserved: 1, stockAvailable: 9 });
  const result = await inventory.recordOnlineInventoryRefundInternal({
    _id: "order-e2e-002",
    lineItems: [{ sku: "SKU-CHAMPU-001", quantity: 3 }],
  }, {
    _id: "refund-e2e-002",
  }, {
    confirmed: true,
    source: "ecom-restock-confirmation",
  }, "trace-refund-e2e-002", {
    sourceEventId: "event-refund-e2e-002",
    thirdPartyId: "B87654321",
  });

  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.data, [{ sku: "SKU-CHAMPU-001", status: "SUCCESS" }]);
  const rows = movementRows();
  assert.equal(rows.length, 1);
  const row = rows[0];

  assert.equal(row.movementType, "DEVOLUCION");
  assert.equal(row.orderId, "order-e2e-002");
  assert.equal(row.refundId, "refund-e2e-002");
  assert.equal(row.sourceEventId, "event-refund-e2e-002");
  assert.equal(row.thirdPartyId, "B87654321");
  assert.equal(row.catalogId, "catalog-product-001");
  assert.equal(row.wixProductId, "wix-product-001");
  assert.equal(row.wixVariantId, "wix-variant-001");
  assert.equal(row.quantity, 3);
  assert.equal(row.quantityDelta, 3);
  assert.equal(row.stockBefore, 10);
  assert.equal(row.stockAfter, 13);
  assert.equal(row.magnitude, 1);
  assert.equal(row.traceId, "trace-refund-e2e-002");
  assert.ok(row.recordTimestamp instanceof Date);
  assert.equal(stockRow().stockOnHand, 13);
  assert.equal(stockRow().stockAvailable, 12);
  assert.equal(stockRow().stockAvailable, stockRow().stockOnHand - stockRow().stockReserved);
});

test("INV-E2E-05 manual entry, exit and adjustment retain actor and source provenance", async () => {
  seedStock();
  const entry = await inventory.recordInventoryMovementSafe(
    "SKU-CHAMPU-001",
    "ENTRADA",
    5,
    {
      traceId: "trace-inv-entry-001",
      movementToken: "movement-inv-entry-001",
      reason: "Recepción de compra QA",
      operationDescription: "Entrada de stock de prueba",
      referenceId: "purchase-receipt-001",
      sourceEventId: "event-inv-entry-001",
      actorEmail: "qa.staff@example.invalid",
      actorMemberId: "member-inv-001",
      thirdPartyId: "supplier-inv-001",
      catalogId: "catalog-product-001",
    },
  );
  assert.equal(entry.status, "SUCCESS");
  assert.equal(entry.data.movementType, "ENTRADA");
  assert.equal(entry.data.quantityDelta, 5);
  assert.equal(entry.data.stockBefore, 12);
  assert.equal(entry.data.stockAfter, 17);
  assert.equal(entry.data.magnitude, 1);
  assert.equal(entry.data.actorEmail, "qa.staff@example.invalid");
  assert.equal(entry.data.actorMemberId, "member-inv-001");
  assert.equal(entry.data.referenceId, "purchase-receipt-001");
  assert.equal(entry.data.sourceEventId, "event-inv-entry-001");
  assert.equal(entry.data.thirdPartyId, "supplier-inv-001");
  assert.equal(entry.data.catalogId, "catalog-product-001");
  assert.equal(entry.data.traceId, "trace-inv-entry-001");

  const exit = await inventory.recordInventoryMovementSafe(
    "SKU-CHAMPU-001",
    "SALIDA",
    -2,
    {
      traceId: "trace-inv-exit-001",
      movementToken: "movement-inv-exit-001",
      reason: "Consumo interno QA",
      referenceId: "internal-use-001",
    },
  );
  assert.equal(exit.status, "SUCCESS");
  assert.equal(exit.data.quantityDelta, -2);
  assert.equal(exit.data.stockBefore, 17);
  assert.equal(exit.data.stockAfter, 15);
  assert.equal(exit.data.magnitude, -1);

  const adjustment = await inventory.recordInventoryMovementSafe(
    "SKU-CHAMPU-001",
    "AJUSTE",
    1,
    {
      traceId: "trace-inv-adjustment-001",
      movementToken: "movement-inv-adjustment-001",
      reason: "Regularización de inventario QA",
      referenceId: "inventory-count-001",
    },
  );
  assert.equal(adjustment.status, "SUCCESS");
  assert.equal(adjustment.data.quantityDelta, 1);
  assert.equal(adjustment.data.stockBefore, 15);
  assert.equal(adjustment.data.stockAfter, 16);
  assert.equal(adjustment.data.magnitude, 1);

  const rows = movementRows();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.recordTimestamp instanceof Date && row.traceId && row.movementToken && row.movementId));
  assert.equal(stockRow().stockOnHand, 16);
  assert.equal(stockRow().stockAvailable, 14);
  assert.equal(stockRow().lastInventoryMovementId, adjustment.data._id);
});

test("INV-E2E-03 invalid canonical stock master fails closed without a ledger row", async () => {
  seedStock({ stockOnHand: undefined, stockReserved: 0, stockAvailable: 0 });
  const invalid = await inventory.recordInventoryMovementSafe(
    "SKU-CHAMPU-001",
    "VENTA",
    -1,
    { traceId: "trace-invalid-stock", movementToken: "movement-invalid-stock" },
  );
  assert.equal(invalid.status, "ERROR");
  assert.equal(invalid.error.code, "STOCK_MASTER_INVALID");
  assert.equal(movementRows().length, 0);
});

test("INV-E2E-04 missing stock master fails closed without a ledger row", async () => {
  wixDataMock._reset();
  const result = await inventory.recordInventoryMovementSafe(
    "SKU-MISSING",
    "VENTA",
    -1,
    { traceId: "trace-missing-stock", movementToken: "movement-missing-stock" },
  );
  assert.equal(result.status, "ERROR");
  assert.equal(result.error.code, "SKU_NOT_FOUND");
  assert.equal(movementRows().length, 0);
});
