/*
=============================================================================
MODULE: backend/cajas.web.js
VERSION: v5016-ZERO-LEGACY
REPO: https://github.com/nachoortegazgz/marianmadridXXXXX.git
RESPONSIBILITY: TPV cashier ledger, daily closures, Veri*factu SHA-256
                chain integrity, fiscal persistence and PGC projection.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero alias. Cero legacy.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import { getSecret } from "wix-secrets-backend";

import {
    query as dalQuery,
    getItem as dalGet,
    insertItem as dalInsert,
    updateItem as dalUpdate,
    saveItem as dalSave,
} from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    SINGLETONS,
    SDK_CONFIG,
    MOVEMENT_TYPE,
    PAYMENT_METHOD,
    IVA_RATES,
    CASH_REGISTER_STATUS,
    TIPO_FACTURA,
    FISCAL_ROLE,
    CONTROL_TYPE,
} from "backend/internalConfig";

import {
    readInvoiceNumber,
    readInvoiceIssueDate,
    readMovementField,
    readTotalAmount,
    readInvoiceType,
    readOperationDate,
    readTaxBase,
    readTaxAmount,
} from "backend/data";

import { normalizeMovementKeys } from "backend/internalConfig";

export { readInvoiceNumber, readInvoiceIssueDate };

import { SECRETS } from "backend/mmSecrets";
import { requireCajero, rateLimiter } from "backend/security";
import { hashSHA256, hashChain } from "backend/securityEngine";

import {
    makeTraceId,
    _roundMoney,
    _safeTrim,
    _cleanText,
    _stableSerialize,
    _readDate,
    _readPositiveAmount,
    withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { normalizeError } from "backend/booking/bookingCore";
import { _toPublicError } from "backend/responseUtils";
import { logAuditEvent } from "backend/audit";

const log = logger;

// ============================================================================
// CONSTANTES CANÓNICAS
// ============================================================================

const CASH_REGISTER_ID = SINGLETONS.CAJA_PRINCIPAL;
const CASH_SEQ_ID = SINGLETONS.CAJA_SEQ;

const VAT_ACCRUAL_DEVENGADO = "DEVENGADO";
const VAT_ACCRUAL_ANTICIPADO = "ANTICIPADO";
const VAT_ACCRUAL_APLICACION_ANTICIPO = "APLICACION_ANTICIPO";

const MOVIMIENTOS_CAJA_COL = BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA;
const CAJA_ACTUAL_COL = BUSINESS_COLLECTIONS.CAJA_ACTUAL;
const HISTORICO_CIERRES_Z_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;
const SERVICIOS_CATALOGO_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const CONTROL_OPERATIVO_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const LIBRO_ASIENTOS_CONTABLES_DETALLE_COL = BUSINESS_COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE;

const LEDGER_SCHEMA_VERSION = "LEDGER_V5_FISCAL";
const GENESIS_HASH = "0".repeat(64);
const MAX_LEDGER_BATCH_PAGES = 50;
const LEDGER_PAGE_SIZE = 200;

const FISCAL_SIGNER_TIMEOUT_MS = 10000;
const SECRET_CACHE_TTL_MS = 300000;
const _secretCache = new Map();

const SIGNER_FAILURE_THRESHOLD = 3;
const SIGNER_OPEN_MS = 60000;
let _signerState = { failures: 0, openUntil: 0 };

const MONTO_OBLIGA_NIF_TERCERO = 300;
const MONTO_OBLIGA_APROBADOR_Z = 500;
const MONEY_EPSILON_FISCAL = 0.02;

export function normalizePaymentMethod(raw) {
    const v = _safeTrim(raw).toUpperCase();
    if (v === "ONLINE") return PAYMENT_METHOD.WIX_PAYMENTS;
    return v;
}
export const normalizeLegacyPaymentMethod = normalizePaymentMethod;

const STRONG_READ = Object.freeze({ consistencyMode: "strong" });

// ============================================================================
// HELPERS
// ============================================================================

function _normalizeLinkedBookingIds(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

function _linkedBookingValue(value) {
    return _normalizeLinkedBookingIds(value).join(",") || null;
}

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

async function _getCachedSecret(name) {
    const now = Date.now();
    const entry = _secretCache.get(name);
    if (entry && (now - entry.at) < SECRET_CACHE_TTL_MS) {
        return entry.value;
    }
    const value = await getSecret(name).catch(() => "");
    _secretCache.set(name, { value, at: now });
    return value;
}

export function _invalidateSecretCache() {
    _secretCache.clear();
}

async function _queueCompensation(params) {
    const p = params || {};
    const dedupeKey = `COMP_${p.kind || "FISCAL"}_${p.transactionId || Date.now()}_${Date.now()}`;
    const record = {
        _id: `REC_${p.kind || "FISCAL"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        controlType: CONTROL_TYPE.COMPENSATION,
        dedupeKey,
        kind: p.kind || "FISCAL_LEDGER",
        transactionId: p.transactionId || null,
        bookingIds: p.bookingIds || null,
        orderId: p.orderId || null,
        refundId: p.refundId || null,
        totalAmount: Number(p.totalAmount) || 0,
        paymentMethod: p.paymentMethod || null,
        operationDescription: p.operationDescription || null,
        movementType: p.movementType || null,
        status: "PENDING_RECOVERY",
        phase: p.phase || null,
        origin: p.origin || "FISCAL_RECOVERY",
        alertRequired: Boolean(p.alertRequired),
        attempts: Number(p.attempts) || 0,
        lastError: p.lastError || null,
        traceId: _safeTrim(p.traceId) || makeTraceId("comp"),
        _createdDate: new Date(),
        _updatedDate: new Date(),
    };
    await dalInsert(CONTROL_OPERATIVO_COL, record);
}

export async function validateFiscalConfig(traceId = "init") {
    const key = await _getCachedSecret(SECRETS.FISCAL_KEY);
    const nif = await _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR);
    if (!key || key.length < 32 || !nif || nif.length < 9) {
        log.error("CONFIGURACION_FISCAL_INVALIDA", { traceId });
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    return true;
}

async function _getFiscalKeys() {
    const [key, nif] = await Promise.all([
        _getCachedSecret(SECRETS.FISCAL_KEY),
        _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR),
    ]);
    if (!key || !nif) throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    return { fiscalKey: key, nifEmisor: _safeTrim(nif).toUpperCase() };
}

function _formatAEATDate(ymd) {
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : clean;
}

function _formatAEATDateTimeMadrid(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridStr = dt.toLocaleString("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" });
    const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(madridStr);
    const offset = m ? `${m[1]}${m[2]}:${m[3]}` : "+01:00";
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function _buildAEATPayload(movement, generatedAt) {
    const fields = [
        ["IDEmisorFactura", movement.nifEmisor || ""],
        ["NumSerieFactura", movement.numSerieFactura || ""],
        ["FechaExpedicionFactura", _formatAEATDate(movement.fechaExpedicionFactura)],
        ["TipoFactura", movement.tipoFactura || TIPO_FACTURA.F1],
        ["BaseImponibleOImporteNoSujeto", String(Number(movement.taxBase || 0).toFixed(2))],
        ["CuotaRepercutida", String(Number(movement.taxAmount || 0).toFixed(2))],
        ["ImporteTotal", String(Number(movement.totalAmount || 0).toFixed(2))],
        ["Huella", movement.previousRecordHash || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];

    if (movement.nifDestinatario) fields.push(["NIFDestinatario", String(movement.nifDestinatario).slice(0, 20)]);
    if (movement.recipientLegalName) fields.push(["NombreRazonDestinatario", String(movement.recipientLegalName).slice(0, 200)]);
    if (movement.bankReconciliationReference) fields.push(["ReferenciaBancaria", String(movement.bankReconciliationReference).slice(0, 60)]);
    if (movement.vatAccrualStatus === VAT_ACCRUAL_APLICACION_ANTICIPO) fields.push(["TipoRectificativa", "I"]);
    if (movement.correctionReason) fields.push(["MotivoRectificacion", String(movement.correctionReason).slice(0, 4)]);
    if (movement.previousInvoiceId) fields.push(["IdFacturaRectificada", String(movement.previousInvoiceId).slice(0, 120)]);

    return fields.map(([key, value]) => `${key}=${value}`).join("&");
}

async function _computeSignature(currentHash, traceId) {
    if (Date.now() < _signerState.openUntil) throw new Error("FISCAL_SIGN_FAIL: circuit breaker open");
    try {
        const endpoint = await _getCachedSecret(SECRETS.FISCAL_SIGNER_ENDPOINT);
        const bearer = await _getCachedSecret(SECRETS.FISCAL_SIGNER_BEARER);
        if (!endpoint || !bearer) throw new Error("FISCAL_SIGN_FAIL: signer endpoint not configured");

        const response = await withTimeout(
            fetch(endpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
                body: JSON.stringify({ hash: currentHash, hashAlgorithm: "SHA-256", signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256" }),
            }),
            FISCAL_SIGNER_TIMEOUT_MS,
            "fiscal_signer"
        );
        if (!response.ok) throw new Error(`FISCAL_SIGNER_HTTP_${response.status}`);
        const data = await response.json();
        if (!data?.signature) throw new Error("FISCAL_SIGNER_INVALID_RESPONSE");

        _signerState.failures = 0;
        return data.signature;
    } catch (err) {
        _signerState.failures++;
        if (_signerState.failures >= SIGNER_FAILURE_THRESHOLD) _signerState.openUntil = Date.now() + SIGNER_OPEN_MS;
        throw new Error(`FISCAL_SIGN_FAIL: ${err?.message}`);
    }
}

function _generateVerificationQR(numSerieFactura, nifEmisor, fechaExpedicionFactura, totalAmount) {
    const baseUrl = "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR";
    const params = [
        `nif=${encodeURIComponent(nifEmisor)}`,
        `numserie=${encodeURIComponent(numSerieFactura)}`,
        `fecha=${encodeURIComponent(fechaExpedicionFactura)}`,
        `importe=${encodeURIComponent(String(totalAmount))}`,
    ];
    return `${baseUrl}?${params.join("&")}`;
}

async function _getNextSequence(traceId) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            let seqDoc = await dalGet(CAJA_ACTUAL_COL, CASH_SEQ_ID, "strong").catch(() => null);
            if (!seqDoc) {
                seqDoc = { _id: CASH_SEQ_ID, sequenceCounters: { seqGlobal: 0 }, _createdDate: new Date(), _updatedDate: new Date() };
                await dalInsert(CAJA_ACTUAL_COL, seqDoc);
            }
            const counters = { ...(seqDoc.sequenceCounters || {}) };
            const nextGlobal = Number(counters.seqGlobal || 0) + 1;
            const yearKey = String(new Date().getFullYear());
            const nextYear = Number(counters[yearKey] || 0) + 1;
            counters.seqGlobal = nextGlobal;
            counters[yearKey] = nextYear;

            await dalUpdate(CAJA_ACTUAL_COL, { ...seqDoc, sequenceCounters: counters, _updatedDate: new Date() });
            return {
                sequenceNumber: nextGlobal,
                yearSequence: nextYear,
                numSerieFactura: `FAC-${yearKey}-${String(nextYear).padStart(5, "0")}`,
            };
        } catch (err) {
            if (attempt === 4) throw new Error(`SEQUENCE_ERROR: ${err?.message}`);
            await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
    }
}

async function _getLastMovement() {
    const res = await dalQuery(MOVIMIENTOS_CAJA_COL).descending("sequenceNumber").limit(1).find(STRONG_READ);
    return res?.items?.[0] || null;
}

async function _assertPeriodNotClosed(operationDate, traceId) {
    const existingZ = await dalGet(HISTORICO_CIERRES_Z_COL, `Z_${operationDate}`, "strong").catch(() => null);
    if (existingZ) throw new Error("PERIOD_CLOSED: No se pueden insertar movimientos en un periodo con cierre Z");
}

function _resolveFiscalBase({ amount, taxRate, withholdingBase, irpfWithholdingAmount, surchargeAmount }) {
    if (withholdingBase > 0) {
        const base = _roundMoney(withholdingBase);
        const taxAmount = _roundMoney(base * taxRate);
        const expectedTotal = _roundMoney(base + taxAmount + (surchargeAmount || 0) - (irpfWithholdingAmount || 0));
        if (Math.abs(expectedTotal - amount) > MONEY_EPSILON_FISCAL) {
            return { ok: false, code: "CUADRE_FISCAL_INVALIDO", message: `Base ${base} + IVA ${taxAmount} = ${expectedTotal}, amount ${amount}` };
        }
        return { ok: true, base, taxAmount };
    }
    const base = _roundMoney(amount / (1 + taxRate));
    const taxAmount = _roundMoney(amount - base);
    return { ok: true, base, taxAmount };
}

// ============================================================================
// PROYECCION CONTABLE PGC
// ============================================================================

async function _projectToAccountingLedger(movement, traceId) {
    if (!LIBRO_ASIENTOS_CONTABLES_DETALLE_COL) return;
    try {
        const totalAmount = Math.abs(Number(movement.accountingAmount || movement.totalAmount) || 0);
        if (totalAmount <= 0) return;

        const method = _safeTrim(movement.paymentMethod).toUpperCase();
        const accountCode = (method === PAYMENT_METHOD.EFECTIVO) ? "570000" : "572000";

        const entry = {
            entryId: `ASIENTO_${movement.sequenceNumber || movement.transactionId || Date.now()}`,
            lineNumber: 1,
            entryDate: movement.fechaOperacion || new Date().toISOString().slice(0, 10),
            fiscalPeriod: movement.fiscalPeriod || new Date().toISOString().slice(0, 7),
            accountCode,
            concept: movement.operationDescription || "Cobro TPV",
            debit: totalAmount,
            credit: totalAmount,
            debitAmount: totalAmount,
            creditAmount: totalAmount,
            accountingAmount: totalAmount,
            cashMovementId: movement.transactionId || null,
            bookingId: (movement.linkedBookingIds && !movement.linkedBookingIds.includes(",")) ? movement.linkedBookingIds : null,
            orderId: movement.orderId || null,
            resourceId: movement.staffResourceId || movement.resourceId || null,
            origenTipo: "MOVIMIENTOCAJA",
            origenRegistro: MOVIMIENTOS_CAJA_COL,
            recordHash: movement.recordHash || GENESIS_HASH,
            recordTimestamp: movement.recordTimestamp || new Date(),
            traceId: movement.traceId || traceId,
            _createdDate: new Date(),
        };

        await dalInsert(LIBRO_ASIENTOS_CONTABLES_DETALLE_COL, entry);
    } catch (err) {
        log.warn("Accounting projection to LibroAsientosContablesDetalle failed", { traceId, error: err?.message });
    }
}

// ============================================================================
// REGISTRO DE TRANSACCIÓN MANUAL (TPV)
// ============================================================================

export const registerManualTransaction = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("manual-tx");
    try {
        _rateLimitOrThrow("cajas.registerManualTransaction", _safeTrim(payload?.resourceId) || "CAJA_LOCAL", traceId);
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { nifEmisor } = await _getFiscalKeys();

        const amount = _readPositiveAmount(payload?.totalAmount);
        if (!amount) return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };

        const paymentMethod = normalizePaymentMethod(payload?.paymentMethod);
        if (!Object.values(PAYMENT_METHOD).includes(paymentMethod)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
        }

        const movementType = _safeTrim(payload?.movementType || "VENTA").toUpperCase();
        const operationDescription = _cleanText(payload?.operationDescription || "Venta mostrador", 500);
        const resourceId = _safeTrim(payload?.resourceId || "CAJA_LOCAL");
        const transactionId = payload?.transactionId || null;

        const inDto = normalizeMovementKeys({ ...(payload || {}) });
        const nifDestinatario = _safeTrim(inDto.nifDestinatario) || null;
        const recipientLegalName = _cleanText(inDto.recipientLegalName || "", 200) || null;
        const isB2B = inDto.isB2B === true;

        if ((isB2B || amount >= MONTO_OBLIGA_NIF_TERCERO) && (!nifDestinatario || !recipientLegalName)) {
            return { status: "ERROR", data: null, error: { code: "RECIPIENT_DATA_REQUIRED", message: "NIF y razon social obligatorios" } };
        }

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        const taxRate = Number(inDto.tipoImpositivo) || IVA_RATES.GENERAL;
        const fiscalCalc = _resolveFiscalBase({ amount, taxRate, withholdingBase: 0, irpfWithholdingAmount: 0, surchargeAmount: 0 });
        if (!fiscalCalc.ok) return { status: "ERROR", data: null, error: { code: fiscalCalc.code, message: fiscalCalc.message } };

        const seq = await _getNextSequence(traceId);
        const lastMovement = await _getLastMovement();
        const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;
        const generatedAt = new Date();

        const baseMovement = {
            sequenceNumber: seq.sequenceNumber,
            numSerieFactura: seq.numSerieFactura,
            fechaExpedicionFactura: operationDate,
            amount: fiscalCalc.base,
            fechaOperacion: operationDate,
            fiscalPeriod: operationDate.slice(0, 7),
            movementType,
            paymentMethod,
            totalAmount: amount,
            taxBase: fiscalCalc.base,
            taxAmount: fiscalCalc.taxAmount,
            tipoImpositivo: taxRate,
            accountingSign: movementType === MOVEMENT_TYPE.REEMBOLSO ? -1 : 1,
            accountingAmount: movementType === MOVEMENT_TYPE.REEMBOLSO ? -amount : amount,
            operationDescription,
            lineItems: inDto.lineItems || [],
            nifEmisor,
            schemaVersion: LEDGER_SCHEMA_VERSION,
            projectionStatus: "PROYECTADO",
            recordSource: "INTERNAL",
            staffResourceId: resourceId,
            resourceId,
            linkedBookingIds: _linkedBookingValue(inDto.linkedBookingIds),
            transactionId: transactionId || `TX_${seq.sequenceNumber}`,
            orderId: inDto.orderId || null,
            refundId: inDto.refundId || null,
            nifDestinatario,
            recipientLegalName,
            isB2B,
            tipoFactura: TIPO_FACTURA.F1,
        };

        const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, generatedAt);
        const recordHash = await hashChain(previousRecordHash, aeatPayload);

        let digitalSignature = "";
        try {
            digitalSignature = await _computeSignature(recordHash, traceId);
        } catch (signErr) {
            log.warn("Fiscal signer unavailable; queuing movement", { traceId, error: signErr?.message });
            await queueFiscalRecovery({
                transactionId: baseMovement.transactionId,
                totalAmount: amount,
                paymentMethod,
                operationDescription,
                resourceId,
                movementType,
                phase: "WAIT_FOR_SIGNER",
                origin: "FISCAL_SIGNER_DOWN",
                traceId,
            });
            return {
                status: "SUCCESS",
                data: { ...baseMovement, previousRecordHash, hash: recordHash, recordHash, pendingSignature: true, queued: true },
                error: null,
            };
        }

        const verificationQR = _generateVerificationQR(baseMovement.numSerieFactura, nifEmisor, operationDate, amount);
        const movement = {
            ...baseMovement,
            previousRecordHash,
            hash: recordHash,
            recordHash,
            digitalSignature,
            aeatPayload,
            verificationQR,
            hashAlgorithm: "SHA-256",
            signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
            recordTimestamp: generatedAt,
            traceId,
            _createdDate: new Date(),
        };

        const saved = await dalInsert(MOVIMIENTOS_CAJA_COL, movement);
        await _updateCajaActual(movement, traceId);
        await _projectToAccountingLedger(movement, traceId);

        return { status: "SUCCESS", data: saved, error: null };
    } catch (err) {
        const norm = normalizeError(err);
        return { status: "ERROR", data: null, error: { code: norm.code || "LEDGER_FAIL", message: norm.message } };
    }
});

// ============================================================================
// UPDATE CAJA ACTUAL
// ============================================================================

const CAJA_KEYS = Object.freeze({
    OPERATION_DATE: "operationDate",
    STATUS: "cashRegisterStatus",
    TOTAL: "netAmount",
    CASH: "cashAmount",
    CARD: "cardAmount",
    BIZUM: "voucherAmount",
    ONLINE: "otherAmount",
    OPERATIONS: "salesCount",
    OPENED_AT: "openedAt",
    CLOSED_AT: "closedAt",
    LAST_MOVEMENT_AT: "lastMovementAt",
});

async function _updateCajaActual(movement, traceId) {
    try {
        let cashRegister = await dalGet(CAJA_ACTUAL_COL, CASH_REGISTER_ID, "strong").catch(() => null);
        if (!cashRegister) {
            cashRegister = {
                _id: CASH_REGISTER_ID,
                [CAJA_KEYS.OPERATION_DATE]: readOperationDate(movement) || new Date().toISOString().slice(0, 10),
                [CAJA_KEYS.STATUS]: CASH_REGISTER_STATUS.ABIERTA,
                [CAJA_KEYS.TOTAL]: 0, [CAJA_KEYS.CASH]: 0, [CAJA_KEYS.CARD]: 0,
                [CAJA_KEYS.BIZUM]: 0, [CAJA_KEYS.ONLINE]: 0, [CAJA_KEYS.OPERATIONS]: 0,
                [CAJA_KEYS.OPENED_AT]: new Date(), [CAJA_KEYS.CLOSED_AT]: null, [CAJA_KEYS.LAST_MOVEMENT_AT]: new Date(),
                _createdDate: new Date(), _updatedDate: new Date(),
            };
        }
        const amount = Number(movement.accountingAmount) || 0;
        const method = _safeTrim(movement.paymentMethod).toUpperCase();
        if (method === PAYMENT_METHOD.EFECTIVO) cashRegister[CAJA_KEYS.CASH] = _roundMoney((cashRegister[CAJA_KEYS.CASH] || 0) + amount);
        else if (method === PAYMENT_METHOD.TARJETA) cashRegister[CAJA_KEYS.CARD] = _roundMoney((cashRegister[CAJA_KEYS.CARD] || 0) + amount);
        else if (method === PAYMENT_METHOD.BIZUM) cashRegister[CAJA_KEYS.BIZUM] = _roundMoney((cashRegister[CAJA_KEYS.BIZUM] || 0) + amount);
        else if (method === PAYMENT_METHOD.WIX_PAYMENTS) cashRegister[CAJA_KEYS.ONLINE] = _roundMoney((cashRegister[CAJA_KEYS.ONLINE] || 0) + amount);

        cashRegister[CAJA_KEYS.TOTAL] = _roundMoney(
            (cashRegister[CAJA_KEYS.CASH] || 0) + (cashRegister[CAJA_KEYS.CARD] || 0) +
            (cashRegister[CAJA_KEYS.BIZUM] || 0) + (cashRegister[CAJA_KEYS.ONLINE] || 0)
        );
        cashRegister[CAJA_KEYS.OPERATIONS] = Number(cashRegister[CAJA_KEYS.OPERATIONS] || 0) + 1;
        cashRegister[CAJA_KEYS.LAST_MOVEMENT_AT] = new Date();
        cashRegister._updatedDate = new Date();
        await dalSave(CAJA_ACTUAL_COL, cashRegister);
    } catch (err) {
        log.error("_updateCajaActual failed", { traceId, error: err?.message });
    }
}

// ============================================================================
// REGISTER BOOKING PAYMENT
// ============================================================================

export async function registerBookingPayment(bookingIds, totalAmount, method, meta = {}) {
    const m = normalizeMovementKeys({ ...(meta || {}) });
    return await registerManualTransaction({
        totalAmount,
        paymentMethod: method,
        movementType: m.movementType || "VENTA_ONLINE",
        operationDescription: m.operationDescription || `Cobro reserva ${bookingIds}`,
        resourceId: m.resourceId || "ONLINE",
        linkedBookingIds: _linkedBookingValue(bookingIds),
        transactionId: m.transactionId || null,
        traceId: m.traceId || makeTraceId("bkg-pay"),
    });
}

export async function queueFiscalRecovery(recoveryData) {
    const traceId = recoveryData.traceId || makeTraceId("fiscal-rec");
    await _queueCompensation({
        kind: recoveryData.kind || "FISCAL_LEDGER",
        transactionId: recoveryData.transactionId,
        totalAmount: Number(recoveryData.totalAmount) || 0,
        paymentMethod: recoveryData.paymentMethod,
        operationDescription: recoveryData.operationDescription || "Fiscal recovery",
        movementType: recoveryData.movementType || "AJUSTE",
        traceId,
    });
}

export const getCashierState = webMethod(Permissions.SiteMember, async (options = {}) => {
    const { traceId, diaKey } = options;
    try {
        await requireCajero(traceId);
        const cashRegister = await dalGet(CAJA_ACTUAL_COL, CASH_REGISTER_ID, "strong").catch(() => null);
        const day = diaKey || new Date().toISOString().slice(0, 10);
        return {
            status: "SUCCESS",
            data: {
                _id: CASH_REGISTER_ID,
                operationDate: cashRegister?.[CAJA_KEYS.OPERATION_DATE] || day,
                cashRegisterStatus: cashRegister?.[CAJA_KEYS.STATUS] || CASH_REGISTER_STATUS.CERRADA,
                netAmount: cashRegister?.[CAJA_KEYS.TOTAL] ?? 0,
                cashAmount: cashRegister?.[CAJA_KEYS.CASH] ?? 0,
                cardAmount: cashRegister?.[CAJA_KEYS.CARD] ?? 0,
                voucherAmount: cashRegister?.[CAJA_KEYS.BIZUM] ?? 0,
                otherAmount: cashRegister?.[CAJA_KEYS.ONLINE] ?? 0,
                salesCount: cashRegister?.[CAJA_KEYS.OPERATIONS] ?? 0,
                openedAt: cashRegister?.[CAJA_KEYS.OPENED_AT] ?? null,
                closedAt: cashRegister?.[CAJA_KEYS.CLOSED_AT] ?? null,
                lastMovementAt: cashRegister?.[CAJA_KEYS.LAST_MOVEMENT_AT] ?? null,
            },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "CASHIER_STATE_FAIL") };
    }
});

// ============================================================================
// CIERRE Z DIARIO
// ============================================================================

export const registerZClosing = webMethod(Permissions.SiteMember, async (diaKey, options = {}) => {
    const { traceId } = options;
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const cleanDiaKey = _readDate(diaKey);
        if (!cleanDiaKey) return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha invalida" } };

        const existingZ = await dalGet(HISTORICO_CIERRES_Z_COL, `Z_${cleanDiaKey}`, "strong").catch(() => null);
        if (existingZ) return { status: "ERROR", data: null, error: { code: "Z_ALREADY_CLOSED", message: "Ya existe un cierre Z" } };

        let allMovements = [];
        const query = dalQuery(MOVIMIENTOS_CAJA_COL).eq("fechaExpedicionFactura", cleanDiaKey).ascending("sequenceNumber").limit(LEDGER_PAGE_SIZE);
        let res = await query.find();
        for (const it of res.items || []) allMovements.push(it);
        let page = 2;
        while (res.hasNext() && page <= MAX_LEDGER_BATCH_PAGES) {
            res = await res.next();
            for (const it of res.items || []) allMovements.push(it);
            page++;
        }
        allMovements.sort((a, b) => (Number(a.sequenceNumber) || 0) - (Number(b.sequenceNumber) || 0));

        if (allMovements.length === 0) return { status: "ERROR", data: null, error: { code: "NO_MOVEMENTS", message: "Sin movimientos" } };

        const totalCash = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.EFECTIVO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalCard = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.TARJETA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalBizum = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.BIZUM).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalOnline = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.WIX_PAYMENTS).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const consolidatedTotalAmount = _roundMoney(totalCash + totalCard + totalBizum + totalOnline);

        let expectedPreviousHash = GENESIS_HASH;
        for (const mov of allMovements) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPreviousHash) {
                return { status: "ERROR", data: null, error: { code: "INTEGRITY_VIOLATION", message: "Cadena de hash rota" } };
            }
            expectedPreviousHash = mov.recordHash || expectedPreviousHash;
        }

        const firstMovement = allMovements[0];
        const lastMovement = allMovements[allMovements.length - 1];
        const closingPayload = _stableSerialize({
            operationDate: cleanDiaKey,
            consolidatedTotalAmount,
            totalOperations: allMovements.length,
            startSequence: Number(firstMovement?.sequenceNumber) || 0,
            endSequence: Number(lastMovement?.sequenceNumber) || 0,
        });
        const closingHash = await hashSHA256(closingPayload);

        const zRecord = {
            _id: `Z_${cleanDiaKey}`,
            operationDate: cleanDiaKey,
            closingStatus: "CERRADO",
            consolidatedTotalAmount,
            totalCash: _roundMoney(totalCash),
            totalCard: _roundMoney(totalCard),
            totalBizum: _roundMoney(totalBizum),
            totalOnline: _roundMoney(totalOnline),
            totalOperations: allMovements.length,
            startSequence: Number(firstMovement?.sequenceNumber) || 0,
            endSequence: Number(lastMovement?.sequenceNumber) || 0,
            startTicketNumber: readInvoiceNumber(firstMovement) || "",
            endTicketNumber: readInvoiceNumber(lastMovement) || "",
            startRecordHash: firstMovement?.previousRecordHash || GENESIS_HASH,
            endRecordHash: lastMovement?.recordHash || GENESIS_HASH,
            closingHash,
            closingSignature: "",
            closingSignatureStatus: "SIGNED",
            closingSource: "CRON",
            closedAt: new Date(),
            approverUser: _safeTrim(options?.approverUser) || null,
            traceId: traceId || makeTraceId("z-close"),
            _createdDate: new Date(),
        };

        const saved = await dalInsert(HISTORICO_CIERRES_Z_COL, zRecord);
        const cashRegister = await dalGet(CAJA_ACTUAL_COL, CASH_REGISTER_ID, "strong").catch(() => null);
        if (cashRegister) {
            cashRegister.cashRegisterStatus = CASH_REGISTER_STATUS.CERRADA;
            cashRegister.closedAt = new Date();
            await dalSave(CAJA_ACTUAL_COL, cashRegister);
        }

        return { status: "SUCCESS", data: saved, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "Z_CLOSING_FAIL") };
    }
});

export async function verifyFiscalHashChainIntegrity(options = {}) {
    const traceId = options.traceId || makeTraceId("hash-audit");
    const batchSize = Number(options.limit) || LEDGER_PAGE_SIZE;
    const breaks = [];
    try {
        const movements = await dalQuery(MOVIMIENTOS_CAJA_COL).ascending("sequenceNumber").limit(batchSize).find();
        let expectedPreviousHash = GENESIS_HASH;
        for (const mov of movements.items || []) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPreviousHash) {
                breaks.push({ movementId: mov._id, numSerieFactura: readInvoiceNumber(mov), expected: expectedPreviousHash, actual: mov.previousRecordHash });
            }
            expectedPreviousHash = mov.recordHash;
        }
        return {
            status: breaks.length === 0 ? "SUCCESS" : "INTEGRITY_COMPROMISED",
            data: { checked: movements.items.length, breaksCount: breaks.length, breaks },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: { code: "AUDIT_FAIL", message: err.message } };
    }
}

export const registerGiftCardSale = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-sale");
    const { nifEmisor } = await _getFiscalKeys();
    const giftCardId = _safeTrim(payload?.giftCardId);
    const totalAmount = _readPositiveAmount(payload?.totalAmount);
    const paymentMethod = normalizePaymentMethod(payload?.paymentMethod);
    const operationDate = new Date().toISOString().slice(0, 10);

    const seq = await _getNextSequence(traceId);
    const lastMovement = await _getLastMovement();
    const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;

    const baseMovement = {
        sequenceNumber: seq.sequenceNumber,
        numSerieFactura: seq.numSerieFactura,
        fechaExpedicionFactura: operationDate,
        amount: totalAmount,
        fechaOperacion: operationDate,
        fiscalPeriod: operationDate.slice(0, 7),
        movementType: MOVEMENT_TYPE.VENTA_TARJETA_REGALO,
        paymentMethod,
        totalAmount,
        taxBase: totalAmount,
        taxAmount: 0,
        tipoImpositivo: 0,
        accountingSign: 1,
        accountingAmount: totalAmount,
        operationDescription: `Venta tarjeta regalo ${giftCardId}`,
        nifEmisor,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        projectionStatus: "PROYECTADO",
        recordSource: "POS",
        staffResourceId: _safeTrim(payload?.staffResourceId || payload?.resourceId || "CAJA_LOCAL"),
        transactionId: `GC_SALE-${giftCardId}`,
        tipoFactura: TIPO_FACTURA.F2,
    };

    const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, new Date());
    const recordHash = await hashChain(previousRecordHash, aeatPayload);
    const movement = {
        ...baseMovement,
        previousRecordHash,
        hash: recordHash,
        recordHash,
        aeatPayload,
        recordTimestamp: new Date(),
        traceId,
        _createdDate: new Date(),
    };

    const saved = await dalInsert(MOVIMIENTOS_CAJA_COL, movement);
    await _updateCajaActual(movement, traceId);
    await _projectToAccountingLedger(movement, traceId);
    return { status: "SUCCESS", data: saved, error: null };
});

export const registerGiftCardRedemption = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-redeem");
    const { nifEmisor } = await _getFiscalKeys();
    const giftCardId = _safeTrim(payload?.giftCardId);
    const totalAmount = _readPositiveAmount(payload?.totalAmount);
    const operationDate = new Date().toISOString().slice(0, 10);

    const seq = await _getNextSequence(traceId);
    const lastMovement = await _getLastMovement();
    const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;

    const baseMovement = {
        sequenceNumber: seq.sequenceNumber,
        numSerieFactura: seq.numSerieFactura,
        fechaExpedicionFactura: operationDate,
        amount: totalAmount,
        fechaOperacion: operationDate,
        fiscalPeriod: operationDate.slice(0, 7),
        movementType: MOVEMENT_TYPE.CANJE_TARJETA_REGALO,
        paymentMethod: PAYMENT_METHOD.TARJETA_REGALO,
        totalAmount,
        taxBase: totalAmount,
        taxAmount: 0,
        tipoImpositivo: 0,
        accountingSign: 1,
        accountingAmount: totalAmount,
        operationDescription: `Canje tarjeta regalo ${giftCardId}`,
        nifEmisor,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        projectionStatus: "PROYECTADO",
        recordSource: "POS",
        staffResourceId: _safeTrim(payload?.staffResourceId || payload?.resourceId || "CAJA_LOCAL"),
        transactionId: `GC_REDEEM-${giftCardId}-${Date.now()}`,
        tipoFactura: TIPO_FACTURA.F2,
    };

    const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, new Date());
    const recordHash = await hashChain(previousRecordHash, aeatPayload);
    const movement = {
        ...baseMovement,
        previousRecordHash,
        hash: recordHash,
        recordHash,
        aeatPayload,
        recordTimestamp: new Date(),
        traceId,
        _createdDate: new Date(),
    };

    const saved = await dalInsert(MOVIMIENTOS_CAJA_COL, movement);
    await _updateCajaActual(movement, traceId);
    await _projectToAccountingLedger(movement, traceId);
    return { status: "SUCCESS", data: saved, error: null };
});

export const getMovimientoByBooking = webMethod(Permissions.MEMBER, async ({ bookingId } = {}) => {
    const traceId = makeTraceId("mov-by-bkg");
    const cleanId = _safeTrim(bookingId);
    if (!cleanId) return { status: "ERROR", meta: { traceId }, data: null, error: { code: "INVALID_PAYLOAD", message: "bookingId is required" } };

    const candidates = await dalQuery(MOVIMIENTOS_CAJA_COL).contains("linkedBookingIds", cleanId).limit(5).find();
    if (!candidates?.items?.length) return { status: "ERROR", meta: { traceId }, data: null, error: { code: "MOVEMENT_NOT_FOUND", message: "No movement linked" } };

    const mov = candidates.items[0];
    return {
        status: "SUCCESS",
        meta: { traceId },
        data: {
            _id: mov._id,
            numSerieFactura: readInvoiceNumber(mov),
            fechaExpedicionFactura: readInvoiceIssueDate(mov),
            totalAmount: readTotalAmount(mov),
            nifEmisor: readMovementField(mov, "nifEmisor"),
            recordHash: readMovementField(mov, "recordHash"),
            recordTimestamp: readMovementField(mov, "recordTimestamp"),
            operationDescription: readMovementField(mov, "operationDescription"),
            tipoFactura: readInvoiceType(mov),
        },
        error: null,
    };
});