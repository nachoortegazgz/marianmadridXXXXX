/*
MODULE: src/backend/inventario.web.js
RESPONSIBILITY: Inventory dashboard, Wix Stores V1 reconciliation queue, idempotent inventory movements and valued inventory closings.
STATIC DEPENDENCIES: @wix/web-methods, backend/dataAccess, backend/internalConfig, public/mmUtils, backend/logger, backend/security, backend/responseUtils, backend/booking/bookingCore, backend/audit, backend/securityEngine, backend/secretVault, backend/mmSecrets
NAMED EXPORT DECLARATIONS DETECTED: getInventoryDashboard, getInventoryReconciliationQueue, recordInventoryMovementSafe, recordOnlineInventoryOrderInternal, recordOnlineInventoryRefundInternal, generateInventoryClosing, listInventoryClosings
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are omitted.
*/
import { webMethod, Permissions } from "@wix/web-methods";
import { queryItems, wql, insertItem as insert, updateItem as update } from "backend/dataAccess";

import {
  BUSINESS_COLLECTIONS, OPERATIONAL_COLLECTIONS,
  INVENTORY_MOVEMENT_TYPE,
  SDK_CONFIG,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _generateUUID,
  _roundMoney,
  _readDate,
  _stableSerialize,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { requireAdmin, requireCajero } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { normalizeError } from "backend/booking/bookingCore";
import { logAuditEvent } from "backend/audit";

import { hashSHA256, hmacSha256Hex } from "backend/securityEngine";
import { getSecretValue } from "backend/secretVault";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const INVENTARIO_COL = BUSINESS_COLLECTIONS.INVENTARIO_STOCK_VENTA;
const MOVIMIENTOS_INV_COL = OPERATIONAL_COLLECTIONS.MOVIMIENTOS_INVENTARIO;
const CIERRE_INV_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;

// =============================================================================
// BLOQUE 1 - GET INVENTORY DASHBOARD
// =============================================================================

export const getInventoryDashboard = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-dashboard");
  try {
    await requireCajero(traceId);

    const limit = Math.min(Number(options?.limit) || 50, 200);
    let filter = wql.eq("active", true);
    if (options?.category) {
      filter = wql.and(filter, wql.eq("category", options.category));
    }
    if (options?.search) {
      // Wix Data SDK v2 has prefix matching, not a generic substring operator.
      filter = wql.and(filter, wql.startsWith("productName", _safeTrim(options.search)));
    }

    const res = await queryItems({
      dataCollectionId: INVENTARIO_COL,
      filter,
      sort: [{ fieldName: "productName", order: "ASC" }],
      limit,
    });

    const items = res?.items || [];

    // SSOT v20.1: campos canonicos de stock (stockOnHand / stockReserved /
    // stockAvailable). "stockExpected" queda solo como lectura historica de
    // respaldo; ninguna escritura nueva usa ese campo.
    const _stockValue = (item) => {
        const onHand = Number(item.stockOnHand);
        if (Number.isFinite(onHand)) return onHand;
        return Number(item.stockExpected || 0);
    };

    const totalStock = items.reduce((sum, item) => sum + _stockValue(item), 0);
    const lowStockItems = items.filter((item) => _stockValue(item) <= Number(item.lowStockAlert || 5));
    const needsReconciliation = items.filter((item) => item.needsWixReconciliation === true);

    // DTO publico proyectado: no se devuelven documentos CMS crudos.
    const publicItems = items.map((item) => ({
        sku: item.sku,
        productName: item.productName,
        stockOnHand: Number(item.stockOnHand) || 0,
        stockReserved: Number(item.stockReserved) || 0,
        stockAvailable: Number(item.stockAvailable) || 0,
        lowStock: _stockValue(item) <= Number(item.lowStockAlert || 5),
        needsWixReconciliation: item.needsWixReconciliation === true,
    }));

    return {
      status: "SUCCESS",
      data: {
        items: publicItems,
        totalItems: items.length,
        totalStock,
        lowStockCount: lowStockItems.length,
        needsReconciliationCount: needsReconciliation.length,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INV_DASHBOARD_FAIL") };
  }
});

// =============================================================================
// BLOQUE 2 - GET INVENTORY RECONCILIATION QUEUE
// =============================================================================

export const getInventoryReconciliationQueue = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-recon");
  try {
    await requireAdmin(traceId);

    const res = await queryItems({ dataCollectionId: INVENTARIO_COL, filter: wql.eq("needsWixReconciliation", true), limit: 100 });

    return {
      status: "SUCCESS",
      data: {
        items: res?.items || [],
        total: res?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INV_RECON_FAIL") };
  }
});

function _normalizeMovementType(value) {
  const normalized = _safeTrim(value).toUpperCase();
  return Object.values(INVENTORY_MOVEMENT_TYPE).includes(normalized) ? normalized : "";
}

// =============================================================================
// BLOQUE 3 - RECORD INVENTORY MOVEMENT SAFE
// Persists canonical sourceEventId, catalogId, magnitude and thirdPartyId only.
// =============================================================================

export async function recordInventoryMovementSafe(sku, movementType, quantity, meta = {}) {
  const traceId = meta.traceId || makeTraceId("inv-mov");
  const cleanSku = _safeTrim(sku);
  const normalizedType = _normalizeMovementType(movementType);

  if (!normalizedType) {
    return { status: "ERROR", data: null, error: { code: "INVALID_MOVEMENT_TYPE", message: "movementType inválido" } };
  }

  if (!cleanSku) {
    return { status: "ERROR", data: null, error: { code: "INVALID_SKU", message: "SKU requerido" } };
  }

  const qty = Number(quantity) || 0;
  if (qty === 0) {
    return { status: "ERROR", data: null, error: { code: "INVALID_QUANTITY", message: "Cantidad no puede ser 0" } };
  }

  const movementToken = meta.movementToken || _generateUUID();

  const existingRes = await queryItems({ dataCollectionId: MOVIMIENTOS_INV_COL, filter: wql.eq("movementToken", movementToken), limit: 1 });

  if (existingRes?.items?.length > 0) {
    return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
  }

  const stockRes = await queryItems({ dataCollectionId: INVENTARIO_COL, filter: wql.eq("sku", cleanSku), limit: 1 });

  const stockItem = stockRes?.items?.[0];
  if (!stockItem) {
    return { status: "ERROR", data: null, error: { code: "SKU_NOT_FOUND", message: `SKU ${cleanSku} no encontrado en inventario` } };
  }

  // Canonical stockOnHand/stockReserved/stockAvailable are mandatory.
  // No fallback to the retired stockExpected field.
  const rawStockOnHand = stockItem.stockOnHand;
  const rawStockReserved = stockItem.stockReserved;
  if (
    rawStockOnHand === undefined || rawStockOnHand === null || rawStockOnHand === "" ||
    !Number.isFinite(Number(rawStockOnHand)) || Number(rawStockOnHand) < 0 ||
    rawStockReserved === undefined || rawStockReserved === null || rawStockReserved === "" ||
    !Number.isFinite(Number(rawStockReserved)) || Number(rawStockReserved) < 0
  ) {
    return {
      status: "ERROR",
      data: null,
      error: { code: "STOCK_MASTER_INVALID", message: "El maestro de stock no contiene cantidades canónicas válidas." },
    };
  }
  const stockOnHand = Number(rawStockOnHand);
  const stockReserved = Number(rawStockReserved);
  const stockBefore = stockOnHand;
  const stockAfter = stockOnHand + qty;

  if (stockAfter < 0 && !meta.allowNegativeStock) {
    return { status: "ERROR", data: null, error: { code: "NEGATIVE_STOCK", message: `Stock resultante seria ${stockAfter}. Stock actual: ${stockBefore}` } };
  }

  const movement = {
    movementId: _safeTrim(meta.movementId) || _generateUUID(),
    movementToken,
    sku: cleanSku,
    productName: _safeTrim(stockItem.name) || null,
    quantity: Math.abs(qty),
    quantityDelta: qty,
    stockBefore,
    stockAfter,
    // Persist the canonical inventory movement type; beforeInsert validates it.
    movementType: normalizedType,
    operationDescription: meta.operationDescription || meta.reason || "",
    reason: meta.reason || "",
    referenceId: _safeTrim(meta.referenceId) || null,
    orderId: _safeTrim(meta.orderId) || null,
    refundId: _safeTrim(meta.refundId) || null,
    actorEmail: _safeTrim(meta.actorEmail) || null,
    actorMemberId: _safeTrim(meta.actorMemberId) || null,
    requiresWixReconciliation: meta.requiresWixReconciliation === true,
    nativeCommercialMovement: meta.nativeCommercialMovement === true,
    wixProductId: stockItem.wixProductId || null,
    wixVariantId: stockItem.wixVariantId || null,
    sourceEventId: _safeTrim(meta.sourceEventId) || null,
    catalogId: _safeTrim(meta.catalogId || stockItem.productId) || null,
    magnitude: Number(qty) > 0 ? 1 : (Number(qty) < 0 ? -1 : 0),
    thirdPartyId: _safeTrim(meta.thirdPartyId) || null,
    recordTimestamp: new Date(),
    traceId,
  };

  const savedMovement = await insert(MOVIMIENTOS_INV_COL, movement);

  stockItem.stockOnHand = stockAfter;
  stockItem.stockAvailable = stockAfter - stockReserved;
  stockItem.lastInventoryMovementAt = new Date();
  stockItem.lastInventoryMovementId = savedMovement._id;
  if (meta.requiresWixReconciliation) {
    stockItem.needsWixReconciliation = true;
  }
  stockItem._updatedDate = new Date();
  await update(INVENTARIO_COL, stockItem);

  log.info("Movimiento de inventario registrado", {
    sku: cleanSku,
    movementType,
    quantityDelta: qty,
    stockBefore,
    stockAfter,
    traceId,
  });

  return { status: "SUCCESS", data: savedMovement, error: null };
}

// =============================================================================
// BLOQUE 4 - RECORD ONLINE INVENTORY ORDER
// =============================================================================

export async function recordOnlineInventoryOrderInternal(order, traceId, provenance = {}) {
  const orderId = _safeTrim(order?._id || order?.id);
  if (!orderId) {
    return { status: "SKIPPED", reason: "NO_ORDER_ID" };
  }

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  if (lineItems.length === 0) {
    return { status: "SKIPPED", reason: "NO_LINE_ITEMS" };
  }

  const results = [];
  for (const item of lineItems) {
    const sku = _safeTrim(item?.sku || item?.productId);
    if (!sku) continue;

    const quantity = -(Number(item?.quantity) || 1);
    const movementToken = `ORDER-${orderId}-${sku}`;

    const result = await recordInventoryMovementSafe(sku, "VENTA", quantity, {
      traceId,
      movementToken,
      orderId,
      sourceEventId: provenance.sourceEventId,
      thirdPartyId: provenance.thirdPartyId,
      reason: `Venta online pedido ${orderId}`,
      requiresWixReconciliation: true,
      nativeCommercialMovement: true,
    });

    results.push({ sku, status: result.status });
  }

  return { status: "SUCCESS", data: results };
}

// =============================================================================
// BLOQUE 5 - RECORD ONLINE INVENTORY REFUND
// =============================================================================

export async function recordOnlineInventoryRefundInternal(order, refundObj, restockInfo, traceId, provenance = {}) {
  const orderId = _safeTrim(order?._id || order?.id);
  const refundId = _safeTrim(refundObj?._id || refundObj?.id);

  if (!orderId || !refundId) {
    return { status: "SKIPPED", reason: "MISSING_IDS" };
  }

  if (!restockInfo) {
    return { status: "SKIPPED", reason: "NO_CONFIRMED_RESTOCK" };
  }

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const results = [];

  for (const item of lineItems) {
    const sku = _safeTrim(item?.sku || item?.productId);
    if (!sku) continue;

    const quantity = Number(item?.quantity) || 1;
    const movementToken = `REFUND-${refundId}-${sku}`;

    const result = await recordInventoryMovementSafe(sku, "DEVOLUCION", quantity, {
      traceId,
      movementToken,
      orderId,
      refundId,
      sourceEventId: provenance.sourceEventId,
      thirdPartyId: provenance.thirdPartyId,
      reason: `Devolucion reembolso ${refundId}`,
      requiresWixReconciliation: true,
    });

    results.push({ sku, status: result.status });
  }

  return { status: "SUCCESS", data: results };
}

// =============================================================================
// BLOQUE 6 - GENERAR CIERRE DE INVENTARIO VALORADO
// =============================================================================

export const generateInventoryClosing = webMethod(Permissions.Admin, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-close");
  // SSOT v20.1 / ADR-02: el cierre de inventario NO debe escribirse en
  // HistoricoCierresZ (mezcla dominio de caja con dominio de inventario).
  // No existe aun decision aprobada sobre el destino (InventarioStockVentaCierre,
  // recordType dentro de HistoricoCierresZ, o coleccion nueva), por lo que el
  // flujo queda BLOQUEADO hasta verificar la coleccion destino. El codigo de
  // proyeccion/valoracion se conserva debajo para reactivarlo cuando exista
  // evidencia de esquema (no alcanzable mientras devuelva early-return).
  log.warn("generateInventoryClosing blocked: destination collection unverified", { traceId });
  return {
    status: "ERROR",
    data: null,
    error: {
      code: "INVENTORY_CLOSING_SCHEMA_UNVERIFIED",
      message: "El cierre de inventario esta bloqueado hasta verificar su coleccion destino.",
    },
  };
  // eslint-disable-next-line no-unreachable
  try {
    await requireAdmin(traceId);

    const fiscalYear = Number(options?.fiscalYear);
    if (!Number.isFinite(fiscalYear) || fiscalYear < 2020 || fiscalYear > 2100) {
      return { status: "ERROR", data: null, error: { code: "INVALID_FISCAL_YEAR", message: "fiscalYear invalido" } };
    }

    const closingType = _safeTrim(options?.closingType).toUpperCase() || "ANUAL";
    if (!["ANUAL", "MENSUAL", "EXTRAORDINARIO"].includes(closingType)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_CLOSING_TYPE", message: "closingType debe ser ANUAL, MENSUAL o EXTRAORDINARIO" } };
    }

    const closingDate = _readDate(options?.closingDate) || new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });

    const existingClosing = await queryItems({ dataCollectionId: CIERRE_INV_COL, filter: wql.and(wql.eq("fiscalYear", fiscalYear), wql.eq("closingType", closingType)), limit: 1 });

    if (existingClosing?.items?.length > 0) {
      return { status: "ERROR", data: null, error: { code: "CLOSING_ALREADY_EXISTS", message: "Ya existe un cierre para este ejercicio y tipo" } };
    }

    const stockRes = await queryItems({ dataCollectionId: INVENTARIO_COL, filter: wql.eq("active", true), limit: 1000 });

    const stockItems = stockRes?.items || [];
    if (stockItems.length === 0) {
      return { status: "ERROR", data: null, error: { code: "NO_STOCK_ITEMS", message: "No hay articulos activos en inventario" } };
    }

    // FIX-53: fallo explicito si no hay fiscal key activa.
    const fiscalKey = await getSecretValue(SECRETS.FISCAL_KEY).catch(() => "");
    if (!fiscalKey) {
      return {
        status: "ERROR",
        data: null,
        error: {
          code: "FISCAL_KEY_UNAVAILABLE",
          message: "No se puede generar un cierre valorado sin clave fiscal activa",
        },
      };
    }

    const closingRecords = [];
    let totalStockValue = 0;

    for (const item of stockItems) {
      const sku = _safeTrim(item.sku);
      const stockQuantity = Number(
        Number.isFinite(Number(item.stockOnHand))
          ? Number(item.stockOnHand)
          : Number(item.stockExpected || 0)
      );
      const unitCost = Number(item.costExTax) || 0;
      const stockValue = _roundMoney(stockQuantity * unitCost);
      totalStockValue += stockValue;

      const closingId = `CLOSING_${fiscalYear}_${closingType}_${sku}`;

      const recordPayload = _stableSerialize({
        closingId,
        fiscalYear,
        closingDate,
        closingType,
        sku,
        stockQuantity,
        unitCost,
        stockValue,
      });
      const closingHash = await hashSHA256(recordPayload);
      const closingSignature = await hmacSha256Hex(fiscalKey, closingHash);

      const closingRecord = {
        _id: closingId,
        inventoryClosingId: closingId,
        fiscalYear,
        closingDate: new Date(closingDate),
        closingType,
        sku,
        productId: item.wixProductId || null,
        productDescription: _safeTrim(item.productName) || _safeTrim(item.description) || "",
        stockQuantity,
        unitCost,
        stockValue,
        accountCode: "300000",
        debitBalance: stockValue > 0 ? stockValue : 0,
        creditBalance: stockValue < 0 ? Math.abs(stockValue) : 0,
        closingHash,
        closingSignature,
        traceId,
        _createdDate: new Date(),
      };

      closingRecords.push(closingRecord);
    }

    // FIX-52: try/catch por insert. Idempotencia sobre retry.
    let createdCount = 0;
    let idempotentCount = 0;
    const failedRecords = [];

    for (const record of closingRecords) {
      try {
        await insert(CIERRE_INV_COL, record);
        createdCount += 1;
      } catch (insertErr) {
        const message = String(insertErr?.message || "");
        const isDuplicate = /Duplicated|WDE0123|ALREADY_EXISTS/.test(message);
        if (isDuplicate) {
          idempotentCount += 1;
        } else {
          failedRecords.push({ sku: record.sku, error: message });
        }
      }
    }

    if (failedRecords.length > 0) {
      await logAuditEvent(
        "INVENTORY_CLOSING_PARTIAL",
        "ERROR",
        `Cierre de inventario incompleto: ${failedRecords.length} SKUs fallaron`,
        { fiscalYear, closingType, failedCount: failedRecords.length, failedRecords: failedRecords.slice(0, 10), traceId },
        traceId,
        `CLOSING_${fiscalYear}`,
        "backend/inventario.web.js"
      );

      return {
        status: "ERROR",
        data: null,
        error: {
          code: "INVENTORY_CLOSING_PARTIAL",
          message: `Cierre incompleto: ${failedRecords.length} SKUs fallaron. Reintenta la operacion.`,
        },
      };
    }

    await logAuditEvent(
      "INVENTORY_CLOSING_GENERATED",
      "INFO",
      `Cierre de inventario generado: ${fiscalYear} ${closingType}`,
      { fiscalYear, closingType, createdCount, idempotentCount, totalStockValue, traceId },
      traceId,
      `CLOSING_${fiscalYear}`,
      "backend/inventario.web.js"
    );

    return {
      status: "SUCCESS",
      data: {
        fiscalYear,
        closingType,
        closingDate,
        totalItems: closingRecords.length,
        createdCount,
        idempotentCount,
        totalStockValue: _roundMoney(totalStockValue),
        closingIds: closingRecords.map((r) => r._id),
      },
      error: null,
    };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("generateInventoryClosing failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "INV_CLOSE_FAIL", message: norm.message } };
  }
});

// =============================================================================
// BLOQUE 7 - LISTAR CIERRES DE INVENTARIO
// =============================================================================

export const listInventoryClosings = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("list-inv-close");
  try {
    await requireCajero(traceId);

    const fiscalYear = Number(options?.fiscalYear);
    const closingType = _safeTrim(options?.closingType);

    let filter;
    if (fiscalYear && closingType) {
      filter = wql.and(wql.eq("fiscalYear", fiscalYear), wql.eq("closingType", closingType));
    } else if (fiscalYear) {
      filter = wql.eq("fiscalYear", fiscalYear);
    } else if (closingType) {
      filter = wql.eq("closingType", closingType);
    }

    const res = await queryItems({
      dataCollectionId: CIERRE_INV_COL,
      filter,
      sort: [{ fieldName: "closingDate", order: "DESC" }],
      limit: Math.min(Number(options?.limit) || 50, 200),
    });

    return {
      status: "SUCCESS",
      data: {
        closings: res?.items || [],
        total: res?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "LIST_INV_CLOSE_FAIL") };
  }
});
