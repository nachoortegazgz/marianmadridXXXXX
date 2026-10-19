/*
=============================================================================
MODULE: backend/contabilidad.js
VERSION: v5015-ALIGNED
BASE: v5009-FISCAL-V20.1 + alineacion con internalConfig v12.0-SSOT-FINAL
RESPONSIBILITY: Proyeccion contable de movimientos de caja (SOLO calculo,
                sin persistencia; MovimientosCaja es SSOT fiscal unico).
STANDARDS: G10 ASCII Strict. Cero suppressAuth.

AVISO: modulo declarado DEAD CODE por la BIBLIA v5010.1. No tiene escritor
activo; su funcion proyecta y devuelve el asiento sin persistirlo. Se
mantiene por compatibilidad y para inspeccion futura.

CAMBIOS DE ALINEACION v5015-ALIGNED:
  ALN-01: AEAT_INVOICE_TYPE -> TIPO_FACTURA.
  ALN-02: SDK_CONFIG.ACCOUNTING eliminado. Se elimina el flag check y el
          modulo proyecta siempre (sin persistir, persisted: false).
  ALN-03: ACCOUNTING_ACCOUNT in v12.0 solo tiene 9 cuentas. Las 7 cuentas
          adicionales se declaran como LOCAL_PGC_ACCOUNTS locales.
  ALN-04: wixData.get/insert reemplazados por dalGet/dalInsert.
  ALN-05: _insertLineIfMissing eliminado (dead code; no consumidores).
=============================================================================
*/

import { getSecret } from "wix-secrets-backend";

import {
    getItem as dalGet,
} from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    MOVEMENT_TYPE,
    TIPO_FACTURA,
    FISCAL_ROLE,
    ACCOUNTING_ACCOUNT,
} from "backend/internalConfig";

import { SECRETS } from "backend/mmSecrets";
import { hmacSha256Hex, hashChain } from "backend/securityEngine";
import { _roundMoney, _cleanText, _safeTrim, makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const MONEY_EPSILON = 0.005;
const TIME_ZONE = "Europe/Madrid";
const SCHEMA_VERSION = "ASIENTO_V3_FISCAL";
const INTEGRITY_ALGORITHM_VERSION = "HMAC_SHA256_V1";

// ALN-03: cuentas PGC no declaradas en v12.0 ACCOUNTING_ACCOUNT
const LOCAL_PGC_ACCOUNTS = Object.freeze({
    CUSTOMER_ADVANCES: "438000",
    SALES_RETURNS: "708000",
    PURCHASES_EXPENSES: "600000",
    SUSPENSE: "555000",
    TAX_IRPF_WITHHOLDING_RECEIVABLE: "473000",
    TAX_IRPF_WITHHOLDING_PAYABLE: "475100",
    TAX_EQUIVALENCE_SURCHARGE: "477100",
});

// =============================================================================
// HELPERS DE LECTURA
// =============================================================================

function _readMovementType(movement) {
    return String(movement?.movementType || "AJUSTE").toUpperCase();
}

function _readRecordSource(movement) {
    return _cleanText(movement?.recordSource || "MOVIMIENTO_CAJA", 80);
}

function _readOperationDescription(movement, fallback) {
    return _cleanText(movement?.operationDescription || fallback, 500);
}

function _readInvoiceNumber(movement) {
    return _cleanText(movement?.invoiceNumber, 120) || null;
}

function _readTotalAmount(movement) {
    return _safeAmount(movement?.totalAmount ?? movement?.accountingAmount);
}

function _readTaxAmount(movement) {
    return Math.abs(_safeAmount(movement?.taxAmount));
}

function _readTaxableBase(movement) {
    return Math.abs(_safeAmount(movement?.taxableBaseOrNonSubjectAmount));
}

function _readTaxRate(movement) {
    const value = Number(movement?.taxRate);
    return Number.isFinite(value) ? value : null;
}

function _readRecordHash(movement) {
    return _safeTrim(movement?.recordHash) || "";
}

function _readPreviousRecordHash(movement) {
    return _safeTrim(movement?.previousRecordHash) || null;
}

function _readRecipientTaxId(movement) {
    return _cleanText(movement?.recipientTaxId, 20) || null;
}

function _readRecipientLegalName(movement) {
    return _cleanText(movement?.recipientLegalName, 200) || null;
}

function _readIssuerInvoiceNumber(movement) {
    return _cleanText(movement?.issuerInvoiceNumber, 60) || null;
}

function _readInvoiceType(movement) {
    return _cleanText(movement?.invoiceType || TIPO_FACTURA.F1, 4);
}

function _readWithholdingBase(movement) {
    return Number(movement?.withholdingBase) || 0;
}

function _readIrpfAmount(movement) {
    return Number(movement?.irpfWithholdingAmount) || 0;
}

function _readSurchargeAmount(movement) {
    return Number(movement?.surchargeAmount) || 0;
}

function _readFiscalRole(movement) {
    return _cleanText(movement?.fiscalRole || FISCAL_ROLE.EMISOR, 10);
}

function _readCorrectionReason(movement) {
    return _cleanText(movement?.correctionReason, 4) || null;
}

function _readPreviousInvoiceId(movement) {
    return _cleanText(movement?.previousInvoiceId, 120) || null;
}

function _readLinkedBookingIds(movement) {
    return _cleanText(movement?.linkedBookingIds, 500) || null;
}

function _readOrderId(movement) {
    return _cleanText(movement?.orderId, 120) || null;
}

function _readRefundId(movement) {
    return _cleanText(movement?.refundId, 120) || null;
}

function _readTraceId(movement) {
    return _cleanText(movement?.traceId || makeTraceId("contabilidad"), 120);
}

function _readTransactionId(movement) {
    return _cleanText(movement?.transactionId, 120);
}

function _readSequenceNumber(movement) {
    return Number(movement?.sequenceNumber) || 0;
}

function _readPaymentMethod(movement) {
    return _cleanText(movement?.paymentMethod, 40) || null;
}

// =============================================================================
// HELPERS DE FECHA / NUMERO
// =============================================================================

function _normalizeDate(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function _toFiscalKeys(date) {
    const localDate = date.toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
    return {
        fiscalYear: Number(localDate.slice(0, 4)),
        fiscalPeriod: localDate.slice(0, 7),
    };
}

function _safeAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

// =============================================================================
// CONSTRUCCION DE LINEAS
// =============================================================================

function _linePayload(line) {
    return [
        line.journalEntryId, line.lineNumber, line.accountCode,
        line.debitAmount, line.creditAmount,
        line.taxableBaseOrNonSubjectAmount, line.taxRate, line.chargedTaxAmount,
        line.traceId,
        line.recipientTaxId || "",
        line.irpfWithholdingAmount || 0,
        line.surchargeAmount || 0,
        line.correctionReason || "",
    ].join("|");
}

async function _asAccountingLine(base, number, accountCode, accountName, debit, credit, tax = null) {
    const line = {
        _id: `${base.journalEntryId}_L${String(number).padStart(3, "0")}`,
        journalEntryId: base.journalEntryId,
        transactionId: base.transactionId || null,
        lineNumber: number,
        operationDate: base.operationDate,
        accountCode: _cleanText(accountCode, 40),
        accountName: _cleanText(accountName, 120),
        accountGroup: "",
        debitAmount: _roundMoney(debit),
        creditAmount: _roundMoney(credit),
        netAmount: _roundMoney(_safeAmount(debit) - _safeAmount(credit)),
        operationCategory: base.operationCategory,
        lineDescription: base.description,
        taxableBaseOrNonSubjectAmount: tax?.taxableBaseOrNonSubjectAmount ?? null,
        taxRate: tax?.taxRate ?? null,
        chargedTaxAmount: tax?.chargedTaxAmount ?? null,
        externalReference: base.externalReference || null,
        traceId: base.traceId,
        registeredAt: base.registeredAt,
        _createdDate: new Date(),

        recipientTaxId: base.recipientTaxId || null,
        recipientLegalName: base.recipientLegalName || null,
        issuerInvoiceNumber: base.issuerInvoiceNumber || null,
        invoiceType: base.invoiceType || null,
        irpfWithholdingAmount: Number(base.irpfWithholdingAmount) || 0,
        withholdingBase: Number(base.withholdingBase) || 0,
        surchargeAmount: Number(base.surchargeAmount) || 0,
        correctionReason: base.correctionReason || null,
        previousInvoiceId: base.previousInvoiceId || null,
        fiscalRole: base.fiscalRole || FISCAL_ROLE.EMISOR,
    };

    if (!line.accountCode || !line.accountName) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_ACCOUNT");
    }

    line.lineHash = await hashChain(base.recordHash || "", _linePayload(line));
    return line;
}

function _getDefaultAccountMap(movementType) {
    const type = String(movementType || "").toUpperCase();

    const maps = {
        VENTA_EFECTIVO: [ACCOUNTING_ACCOUNT.CASH, "Caja", ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA: [ACCOUNTING_ACCOUNT.BANKS, "Bancos", ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        VENTA_BIZUM: [ACCOUNTING_ACCOUNT.BANKS, "Bancos", ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        VENTA_ONLINE: [ACCOUNTING_ACCOUNT.BANKS, "Bancos", ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA_REGALO: [ACCOUNTING_ACCOUNT.CASH, "Caja", LOCAL_PGC_ACCOUNTS.CUSTOMER_ADVANCES, "Anticipos de clientes", "", ""],
        CANJE_TARJETA_REGALO: [LOCAL_PGC_ACCOUNTS.CUSTOMER_ADVANCES, "Anticipos de clientes", ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        REEMBOLSO: [LOCAL_PGC_ACCOUNTS.SALES_RETURNS, "Devoluciones de ventas", ACCOUNTING_ACCOUNT.CASH, "Caja", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
        PAGO_PROVEEDOR: [ACCOUNTING_ACCOUNT.SUPPLIERS, "Proveedores", ACCOUNTING_ACCOUNT.CASH, "Caja", "", ""],
        GASTO: [LOCAL_PGC_ACCOUNTS.PURCHASES_EXPENSES, "Compras y gastos", ACCOUNTING_ACCOUNT.SUPPLIERS, "Proveedores", ACCOUNTING_ACCOUNT.VAT_INPUT, "Hacienda Publica IVA soportado"],
        AJUSTE: [ACCOUNTING_ACCOUNT.CASH, "Caja", LOCAL_PGC_ACCOUNTS.SUSPENSE, "Partidas pendientes de aplicacion", "", ""],
        SERVICIO_PROFESIONAL: [ACCOUNTING_ACCOUNT.SERVICE_REVENUE, "Prestaciones de servicios", ACCOUNTING_ACCOUNT.CASH, "Caja", ACCOUNTING_ACCOUNT.VAT_OUTPUT, "Hacienda Publica IVA repercutido"],
    };

    const values = maps[type];
    if (!values) return null;

    return {
        activa: true, validadaPorGestoria: true,
        codigoCuentaDebePredeterminada: values[0],
        nombreCuentaDebePredeterminada: values[1],
        codigoCuentaHaberPredeterminada: values[2],
        nombreCuentaHaberPredeterminada: values[3],
        codigoCuentaIvaRepercutido: values[4],
        nombreCuentaIvaRepercutido: values[5],
    };
}

function _isApprovedMap(map) {
    return Boolean(
        map?.activa && map?.validadaPorGestoria &&
        map?.codigoCuentaDebePredeterminada && map?.nombreCuentaDebePredeterminada &&
        map?.codigoCuentaHaberPredeterminada && map?.nombreCuentaHaberPredeterminada
    );
}

function _findAccountMap(movementType) {
    return _getDefaultAccountMap(movementType);
}

async function _getExisting(journalEntryId) {
    return dalGet(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, journalEntryId, "strong").catch(() => null);
}

function _buildBase(movement) {
    const operationDate = _normalizeDate(movement?.registeredAt || movement?.operationDate);
    const fiscalKeys = _toFiscalKeys(operationDate);
    const sourceId = _cleanText(movement?._id, 120);
    const movementType = _readMovementType(movement);
    const recordHash = _readRecordHash(movement);
    const recordSource = _readRecordSource(movement);
    const previousRecordHash = _readPreviousRecordHash(movement);

    return {
        journalEntryId: `ASIENTO_${sourceId}`,
        sequenceNumber: _readSequenceNumber(movement),
        fiscalYear: fiscalKeys.fiscalYear,
        fiscalPeriod: fiscalKeys.fiscalPeriod,
        operationDate,
        registeredAt: new Date(),
        operationTimeZone: TIME_ZONE,
        entryType: movementType,
        operationCategory: movementType,
        description: _readOperationDescription(movement, movementType),
        recordSource,
        sourceId,
        transactionId: _readTransactionId(movement),
        externalReference: _readInvoiceNumber(movement),
        invoiceNumber: _readInvoiceNumber(movement),
        invoiceIssueDate: operationDate,
        fiscalOperationDate: operationDate,
        currency: "EUR",
        totalDocumentAmount: _roundMoney(Math.abs(_readTotalAmount(movement))),
        paymentMethod: _readPaymentMethod(movement),
        entryStatus: "CONFIRMADO",
        previousHash: previousRecordHash,
        recordHash,
        schemaVersion: SCHEMA_VERSION,
        integrityAlgorithmVersion: INTEGRITY_ALGORITHM_VERSION,
        traceId: _readTraceId(movement),

        recipientTaxId: _readRecipientTaxId(movement),
        recipientLegalName: _readRecipientLegalName(movement),
        issuerInvoiceNumber: _readIssuerInvoiceNumber(movement),
        invoiceType: _readInvoiceType(movement),
        withholdingBase: _readWithholdingBase(movement),
        irpfWithholdingAmount: _readIrpfAmount(movement),
        surchargeAmount: _readSurchargeAmount(movement),
        fiscalRole: _readFiscalRole(movement),
        correctionReason: _readCorrectionReason(movement),
        previousInvoiceId: _readPreviousInvoiceId(movement),

        sourceData: {
            fuente: recordSource,
            idExterno: _cleanText(movement?.orderId || movement?.transactionId || movement?.refundId || sourceId, 120),
            orderId: _readOrderId(movement),
            refundId: _readRefundId(movement),
            bookingIds: _readLinkedBookingIds(movement),
        },
    };
}

async function _buildLines(base, movement, map) {
    const signedTotal = _readTotalAmount(movement);
    const total = Math.abs(signedTotal);
    const vat = _readTaxAmount(movement);
    const sourceTaxable = _readTaxableBase(movement);
    const net = _roundMoney(sourceTaxable > MONEY_EPSILON ? sourceTaxable : total - vat);
    const tipoImpositivo = _readTaxRate(movement);

    const irpfAmount = Math.abs(_readIrpfAmount(movement));
    const surchargeAmount = Math.abs(_readSurchargeAmount(movement));

    const fiscalRole = base.fiscalRole || FISCAL_ROLE.EMISOR;
    const withholdingAccountCode = fiscalRole === FISCAL_ROLE.RECEPTOR
        ? LOCAL_PGC_ACCOUNTS.TAX_IRPF_WITHHOLDING_RECEIVABLE
        : LOCAL_PGC_ACCOUNTS.TAX_IRPF_WITHHOLDING_PAYABLE;
    const withholdingAccountName = fiscalRole === FISCAL_ROLE.RECEPTOR
        ? "H.P. Retenciones IRPF a favor"
        : "H.P. Retenciones IRPF a ingresar";

    if (total <= MONEY_EPSILON || net < -MONEY_EPSILON || vat > total + MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_AMOUNT");
    }

    const tax = { taxableBaseOrNonSubjectAmount: net, taxRate: tipoImpositivo, chargedTaxAmount: vat || null };
    const vatCode = _cleanText(map.codigoCuentaIvaRepercutido, 40);
    const vatName = _cleanText(map.nombreCuentaIvaRepercutido, 120);
    const lines = [];
    const isRefund = signedTotal < 0;

    if (!isRefund) {
        lines.push(await _asAccountingLine(base, 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, total, 0, null));
        lines.push(await _asAccountingLine(base, 2, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, 0, net, tax));

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
            lines.push(await _asAccountingLine(base, 3, vatCode, vatName, 0, vat, tax));
        }

        if (surchargeAmount > MONEY_EPSILON) {
            lines.push(await _asAccountingLine(base, lines.length + 1, LOCAL_PGC_ACCOUNTS.TAX_EQUIVALENCE_SURCHARGE, "H.P. Recargo de equivalencia", 0, surchargeAmount, tax));
        }

        if (irpfAmount > MONEY_EPSILON) {
            if (fiscalRole === FISCAL_ROLE.RECEPTOR) {
                lines.push(await _asAccountingLine(base, lines.length + 1, withholdingAccountCode, withholdingAccountName, irpfAmount, 0, tax));
            } else {
                lines.push(await _asAccountingLine(base, lines.length + 1, withholdingAccountCode, withholdingAccountName, 0, irpfAmount, tax));
            }
        }
    } else {
        lines.push(await _asAccountingLine(base, 1, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, net, 0, tax));

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
            lines.push(await _asAccountingLine(base, 2, vatCode, vatName, vat, 0, tax));
        }

        if (surchargeAmount > MONEY_EPSILON) {
            lines.push(await _asAccountingLine(base, lines.length + 1, LOCAL_PGC_ACCOUNTS.TAX_EQUIVALENCE_SURCHARGE, "H.P. Recargo de equivalencia", surchargeAmount, 0, tax));
        }

        if (irpfAmount > MONEY_EPSILON) {
            if (fiscalRole === FISCAL_ROLE.RECEPTOR) {
                lines.push(await _asAccountingLine(base, lines.length + 1, withholdingAccountCode, withholdingAccountName, 0, irpfAmount, tax));
            } else {
                lines.push(await _asAccountingLine(base, lines.length + 1, withholdingAccountCode, withholdingAccountName, irpfAmount, 0, tax));
            }
        }

        lines.push(await _asAccountingLine(base, lines.length + 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, 0, total, null));
    }

    const totalDebit = _roundMoney(lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
    const totalCredit = _roundMoney(lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0));

    if (Math.abs(totalDebit - totalCredit) > MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_UNBALANCED");
    }

    return { lines, totalDebit, totalCredit };
}

// =============================================================================
// PROYECCION PRINCIPAL (SOLO CALCULO, SIN PERSISTENCIA)
// =============================================================================

export async function projectLedgerMovementToAccounting(movimiento) {
    const traceId = makeTraceId("contabilidad");

    try {
        const sourceId = _cleanText(movimiento?._id, 120);
        const recordHash = _readRecordHash(movimiento);
        const transactionId = _readTransactionId(movimiento);

        if (!sourceId || !recordHash || !transactionId) {
            return { status: "SKIPPED", reason: "INVALID_SOURCE_LEDGER" };
        }

        const movementType = _readMovementType(movimiento);

        if (
            movementType === MOVEMENT_TYPE.PROPINA ||
            movimiento?.taxTreatment === "PROPINA_PENDIENTE_GESTORIA"
        ) {
            return { status: "SKIPPED", reason: "TIP_TREATMENT_PENDING_PROFESSIONAL_REVIEW" };
        }

        // ALN-02: SDK_CONFIG.ACCOUNTING eliminado. Sin flag: computar siempre.
        // persisted:false garantiza que NO se toca CMS (append-only intacto).

        const base = _buildBase(movimiento);
        const existing = await _getExisting(base.journalEntryId);
        if (existing) {
            return { status: "SUCCESS", idempotent: true, idAsiento: base.journalEntryId };
        }

        const map = _findAccountMap(base.operationCategory);
        if (!_isApprovedMap(map)) {
            return { status: "SKIPPED", reason: "NO_APPROVED_ACCOUNT_MAP" };
        }

        const projected = await _buildLines(base, movimiento, map);

        const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
        if (!fiscalKey) throw new Error("ACCOUNTING_PROJECTION_SIGNING_KEY_MISSING");

        const headerPayload = [
            base.journalEntryId, base.sequenceNumber, base.sourceId, base.transactionId,
            projected.totalDebit, projected.totalCredit,
            ...projected.lines.map((line) => line.lineHash),
        ].join("|");

        const entryHash = await hashChain(base.recordHash, headerPayload);
        const entrySignature = [
            await hmacSha256Hex(fiscalKey, headerPayload),
            entryHash,
        ].join("|");

        const header = {
            ...base,
            totalDebit: projected.totalDebit,
            totalCredit: projected.totalCredit,
            entryHash,
            entrySignature,
        };

        // Persistencia NO realizada por diseno: MovimientosCaja es SSOT fiscal
        // unico. Este modulo devuelve la proyeccion firmada para inspeccion.
        return {
            status: "PROJECTED",
            persisted: false,
            reason: "LEDGER_V5_FISCAL_SSOT_REQUIRED",
            projection: header,
            lines: projected.lines,
            lineCount: projected.lines.length,
        };
    } catch (error) {
        log.error("projectLedgerMovementToAccounting failed", {
            traceId,
            message: error?.message || String(error),
        });
        throw error;
    }
}

export function isAccountingProjectionError(error) {
    return String(error?.message || error || "").startsWith("ACCOUNTING_PROJECTION_");
}