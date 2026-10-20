/*
=============================================================================
MODULE: backend/data.js
VERSION: v5016-ZERO-LEGACY
REPO: https://github.com/nachoortegazgz/marianmadridXXXXX.git
RESPONSIBILITY: Hooks de inmutabilidad, protecciones append-only y
                validacion estricta de esquemas CMS.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero alias. Cero legacy.
=============================================================================
*/

import { query as dalQuery } from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    FISCAL_ROLE,
    normalizeMovementKeys,
} from "backend/internalConfig";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// HELPERS SSOT-KEYFIELD (CERO ALIAS, LECTURA CANONICA DIRECTA)
// =============================================================================

export function _readCanonical(item, canonicalKey) {
    if (!item || typeof item !== "object") return undefined;
    const v = item[canonicalKey];
    return (v !== undefined && v !== null && v !== "") ? v : undefined;
}

export function readMovementField(item, canonicalKey) {
    return _readCanonical(item, canonicalKey) ?? null;
}

export function readInvoiceNumber(item) {
    return readMovementField(item, "numSerieFactura");
}

export function readInvoiceIssueDate(item) {
    return readMovementField(item, "fechaExpedicionFactura");
}

export function readAmount(item) {
    return Number(readMovementField(item, "amount")) || 0;
}

export function readTotalAmount(item) {
    return Number(readMovementField(item, "totalAmount")) || 0;
}

export function readTaxBase(item) {
    return Number(readMovementField(item, "taxBase")) || 0;
}

export function readTaxAmount(item) {
    return Number(readMovementField(item, "taxAmount")) || 0;
}

export function readInvoiceType(item) {
    return _safeTrim(readMovementField(item, "tipoFactura")).toUpperCase();
}

export function readIssuerTaxId(item) {
    return _safeTrim(readMovementField(item, "nifEmisor"));
}

export function readRecipientTaxId(item) {
    return _safeTrim(readMovementField(item, "nifDestinatario"));
}

export function readRecordHash(item) {
    return _safeTrim(readMovementField(item, "recordHash") ?? readMovementField(item, "hash") ?? "");
}

export function readRecipientLegalName(item) {
    return _safeTrim(readMovementField(item, "recipientLegalName"));
}

export function readOperationDate(item) {
    return readMovementField(item, "fechaOperacion");
}

export function readRecordTimestamp(item) {
    return readMovementField(item, "recordTimestamp");
}

export function readSurchargeAmount(item) {
    return Number(readMovementField(item, "surchargeAmount")) || 0;
}

export function readFiscalPayload(item) {
    return readMovementField(item, "payloadFiscal");
}

export function readBreakdown(item) {
    return readMovementField(item, "desgloseDetallado");
}

// =============================================================================
// CONSTANTES
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "csvAEAT",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";
const LEDGER_SCHEMA_VERSION_AEAT = "LEDGER_V5_FISCAL";

const EU_VAT_PREFIXES_LOCAL = Object.freeze([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
    "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);

const VALID_THIRD_PARTY_TYPES = new Set([
    "CLIENTE", "PROVEEDOR", "STAFF", "AAPP", "MIXTO", "EMISOR",
]);

const VALID_ITEM_NATURES = new Set([
    "SERVICIO_PROPIO", "PRODUCTO_VENTA", "PRODUCTO_USO", "GASTO_FIJO",
    "SERVICIO", "PRODUCTO",
]);

const VALID_TAX_CODES = new Set([
    "IVA_21", "IVA_10", "IVA_4", "IVA_0",
    "IRPF_15", "IRPF_19", "EXENTO",
    "IVA",
]);

const VALID_EVENT_TYPES = new Set([
    "VENTA_LINEA", "COMPRA_LINEA", "CIERRE_Z",
    "AJUSTE", "RECTIFICATIVA", "MOV_STOCK",
]);

const VALID_FISCAL_ROLES = new Set(["EMISOR", "RECEPTOR"]);

// =============================================================================
// HELPERS INTERNOS
// =============================================================================

function _safeTrim(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function _isGuid(value) {
    return GUID_PATTERN.test(_safeTrim(value));
}

function _isFiniteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0;
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _roundItem(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function _isV5Fiscal(item) {
    return _safeTrim(item?.schemaVersion) === LEDGER_SCHEMA_VERSION_AEAT;
}

function _isValidNifEspanol(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean || clean.length < 8) return false;

    if (/^\d{8}[A-Z]$/.test(clean)) {
        const numero = Number(clean.slice(0, 8));
        return clean.charAt(8) === NIF_LETRAS_DNI[numero % 23];
    }
    if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
        const prefijo = { X: "0", Y: "1", Z: "2" }[clean.charAt(0)];
        const numero = Number(prefijo + clean.slice(1, 8));
        return clean.charAt(8) === NIF_LETRAS_DNI[numero % 23];
    }
    if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
        return true;
    }
    return false;
}

function _isValidNifOrEuVat(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean) return false;
    if (_isValidNifEspanol(clean)) return true;
    if (clean.length >= 8 && clean.length <= 14) {
        const prefix = clean.slice(0, 2);
        if (EU_VAT_PREFIXES_LOCAL.includes(prefix)) {
            const body = clean.slice(2);
            if (/^[A-Z0-9]{5,12}$/.test(body)) return true;
        }
    }
    return false;
}

const _readTaxableBase = readTaxBase;
const _readTaxAmount = readTaxAmount;
const _readTotalAmount = readTotalAmount;
const _readSurchargeAmount = readSurchargeAmount;
const _readRecipientTaxId = readRecipientTaxId;
const _readRecipientLegalName = readRecipientLegalName;
const _readInvoiceType = readInvoiceType;

function _readBreakdownBaseAndTax(item) {
    let base = 0;
    let tax = 0;
    const breakdown = readBreakdown(item);
    if (breakdown) {
        try {
            const arr = typeof breakdown === "string" ? JSON.parse(breakdown) : breakdown;
            if (Array.isArray(arr) && arr.length > 0) {
                base = arr.reduce((sum, d) => sum + Number(d.baseImponibleOImporteNoSujeto ?? d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0), 0);
                tax = arr.reduce((sum, d) => sum + Number(d.cuotaTotal ?? d.chargedTaxAmount ?? d.cuota ?? 0), 0);
            }
        } catch (e) {
            _schemaError("desgloseDetallado no es JSON valido");
        }
    }
    return { base, tax };
}

function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;
    const pf = item.payloadFiscal || {};
    const taxId = _readRecipientTaxId(item) || _safeTrim(pf.nifDestinatario);
    const legalName = _readRecipientLegalName(item) || _safeTrim(pf.nombreRazonDestinatario || pf.recipientLegalName);
    const address = item.recipientAddress || pf.domicilioDestinatario || pf.recipientAddress || {};

    if (!taxId) _schemaError("Factura F1 exige recipientTaxId / nifDestinatario");
    if (!legalName) _schemaError("Factura F1 exige recipientLegalName / nombreRazonDestinatario");
    if (!address || !_safeTrim(address.cp || address.postalCode)) _schemaError("Factura F1 exige recipientAddress con codigo postal (cp)");
}

function _validateReverseCharge(item) {
    if (item.reverseCharge !== true) return;
    if (_readTaxAmount(item) > 0) _schemaError("reverseCharge implica taxAmount = 0");
}

function _validateAjuste(item) {
    if (_safeTrim(item.eventType).toUpperCase() !== "AJUSTE") return;
    if (!_safeTrim(item.previousInvoiceId)) _schemaError("eventType=AJUSTE exige previousInvoiceId");
}

function _validateFiscalRole(item) {
    const role = _safeTrim(item.fiscalRole).toUpperCase();
    if (!role) return;
    if (!VALID_FISCAL_ROLES.has(role)) _schemaError("fiscalRole invalido (EMISOR|RECEPTOR)");
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;
    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) _schemaError("eventType obligatorio y valido");

    if (eventType !== "CIERRE_Z") {
        if (item.thirdPartyId != null && item.thirdPartyId !== "" && !_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId debe ser un GUID valido (FK DatosFiscales)");
        }
        const sealedLedgerEntry = /^[0-9a-f]{64}$/i.test(readRecordHash(item));
        if (["VENTA_LINEA", "COMPRA_LINEA"].includes(eventType)) {
            if (!sealedLedgerEntry && !_isGuid(item.catalogId) && !_isGuid(item.thirdPartyId)) {
                _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
            }
        } else if (eventType === "RECTIFICATIVA") {
            if (!_safeTrim(item.previousInvoiceId) && !_isGuid(item.catalogId) && !_isGuid(item.thirdPartyId)) {
                _schemaError("RECTIFICATIVA exige previousInvoiceId o contraparte fiscal");
            }
        }
        const hasAeatBreakdown = Array.isArray(item.desgloseDetallado) && item.desgloseDetallado.length > 0;
        const hasSnapshot = item.payloadFiscal && typeof item.payloadFiscal === "object";
        const hasFiscalCounterparty = _isGuid(item.thirdPartyId) || _isGuid(item.catalogId);
        const hasIntegrityHash = /^[0-9a-f]{64}$/i.test(readRecordHash(item));
        if (!hasAeatBreakdown && !hasSnapshot && !hasFiscalCounterparty && !hasIntegrityHash) {
            _schemaError("payloadFiscal obligatorio (snapshot AEAT)");
        }
    }

    if (item.sequenceNumber !== undefined && item.sequenceNumber !== null && item.sequenceNumber !== "") {
        if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
            _schemaError("sequenceNumber invalido (debe ser > 0)");
        }
    }

    const isInternalAdjustment = eventType === "AJUSTE" || eventType === "MOV_STOCK";
    if (!isInternalAdjustment && !readRecordHash(item)) {
        _schemaError("recordHash obligatorio (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA (APPEND-ONLY)
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en el ledger fiscal (Ley 11/2021)");
    if (!_safeTrim(item.schemaVersion)) _schemaError("schemaVersion obligatorio (LEDGER_V5_FISCAL)");
    if (!readRecordHash(item)) _schemaError("recordHash obligatorio (cadena SHA-256 de integridad)");

    normalizeMovementKeys(item);

    const taxId = _readRecipientTaxId(item);
    if (taxId && !_isValidNifOrEuVat(taxId)) {
        _schemaError("nifDestinatario no tiene formato valido (espanol o VAT UE)");
    }

    const { base, tax } = _readBreakdownBaseAndTax(item);
    const finalBase = base > 0 ? base : _readTaxableBase(item);
    const finalTax = tax > 0 ? tax : _readTaxAmount(item);

    const withholding = Number(item.irpfWithholdingAmount) || 0;
    const surcharge = _readSurchargeAmount(item);
    const total = _readTotalAmount(item);

    if (finalBase > 0 || finalTax > 0 || withholding > 0 || surcharge > 0) {
        const role = _safeTrim(item.fiscalRole).toUpperCase() || FISCAL_ROLE.EMISOR;
        const withholdingFactor = role === FISCAL_ROLE.RECEPTOR ? 1 : -1;
        const expected = _roundItem(finalBase + finalTax + surcharge + withholdingFactor * withholding);
        if (Math.abs(expected - total) > 0.02) {
            _schemaError(`Cuadre fiscal invalido: base ${finalBase} + cuota ${finalTax} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`);
        }
    }

    _validateF1Requirements(item);
    _validateReverseCharge(item);
    _validateAjuste(item);
    _validateFiscalRole(item);
    _validateFiscalPayload(item);

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError("Modificacion de MovimientosCaja prohibida (append-only). Use eventType=AJUSTE.");
}

export function MovimientosCaja_beforeRemove() {
    _fiscalError("Borrado de MovimientosCaja prohibido por normativa fiscal");
}

// =============================================================================
// BLOQUE 2 - CIERRES Z (APPEND-ONLY)
// =============================================================================

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en HistoricoCierresZ");
    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const previous = context?.previous || context?.original || {};
    const hasSnapshot = Boolean(context && (context.previous || context.original));
    const changes = Object.keys(item || {})
        .filter((key) => key !== "_id")
        .filter((key) => !hasSnapshot || String(previous[key]) !== String(item[key]));

    const onlySignatureFields = changes.every((key) => ALLOWED_Z_UPDATE_FIELDS.has(key));
    if (!onlySignatureFields) {
        _fiscalError("HistoricoCierresZ es append-only: solo se permite signature/verification desde recovery.");
    }
    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _fiscalError("Borrado de HistoricoCierresZ prohibido: registro fiscal append-only");
}

// =============================================================================
// BLOQUE 3 - REGISTROS HORARIOS (APPEND-ONLY)
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en RegistrosHorariosStaff (RD 8/2019)");
    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    _fiscalError("Modificacion de RegistrosHorariosStaff prohibida: registro append-only (RD 8/2019)");
}

export function RegistrosHorariosStaff_beforeRemove() {
    _fiscalError("Borrado de RegistrosHorariosStaff prohibido: registro append-only (RD 8/2019)");
}

// =============================================================================
// BLOQUE 4 - CAJA ACTUAL (SINGLETON)
// =============================================================================

export function CajaActual_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    const key = _safeTrim(item.singletonKey || item._id);
    if (key !== "CAJA_PRINCIPAL" && key !== "CAJA_SEQ") {
        _schemaError("singletonKey en CajaActual debe ser 'CAJA_PRINCIPAL' o 'CAJA_SEQ'");
    }
    return item;
}

export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};
    const prevSeq = previous?.sequenceCounters;
    const nextSeq = item?.sequenceCounters;
    if (JSON.stringify(prevSeq || {}) !== JSON.stringify(nextSeq || {}) && item?._id !== "CAJA_SEQ") {
        log.warn("CajaActual_beforeUpdate: sequenceCounters modified on non-CAJA_SEQ document", { _id: item?._id });
    }
    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error("SINGLETON_PROTECTED: No se puede eliminar el estado de caja");
}

// =============================================================================
// BLOQUE 5 - SERVICIOS CATALOGO
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item) { return _validateServiciosCatalogoSchema(item); }
export function ServiciosCatalogo_beforeUpdate(item) { return _validateServiciosCatalogoSchema(item); }

function _validateServiciosCatalogoSchema(item = {}) {
    const serviceId = _safeTrim(item.serviceId || item._id);
    const linkedPhases = _safeTrim(item.linkedPhases);
    const allowCombine = item.allowCombine === true;

    if (item.serviceId && !_isGuid(item.serviceId)) _schemaError("serviceId debe ser un GUID valido");
    if (allowCombine && !linkedPhases) _schemaError("Servicio dual requiere linkedPhases");
    if (linkedPhases && !_isGuid(linkedPhases)) _schemaError("linkedPhases debe ser un GUID valido");
    if (linkedPhases && linkedPhases === serviceId) _schemaError("linkedPhases no puede referenciar al propio servicio");

    const itemNature = _safeTrim(item.itemNature).toUpperCase();
    if (itemNature && !VALID_ITEM_NATURES.has(itemNature)) _schemaError("itemNature invalido");

    const taxCode = _safeTrim(item.taxCode).toUpperCase();
    if (taxCode && !VALID_TAX_CODES.has(taxCode)) _schemaError("taxCode invalido");

    const p1 = Number(item.phase1Duration) || 0;
    const exp = Number(item.exposureDuration) || 0;
    const p2 = Number(item.phase2Duration) || 0;
    let total = Number(item.totalDuration) || 0;

    if (!_isFiniteNonNegative(p1) || !_isFiniteNonNegative(exp) || !_isFiniteNonNegative(p2) || !_isFiniteNonNegative(total)) {
        _schemaError("Las duraciones deben ser numeros no negativos");
    }

    if (allowCombine && total === 0) {
        total = p1 + exp + p2;
        if (total > 0) item.totalDuration = total;
    }
    if (allowCombine && total > 0 && Math.abs(total - (p1 + exp + p2)) > 1) {
        _schemaError(`totalDuration (${total}) no coincide con la suma de fases (${p1 + exp + p2})`);
    }
    return item;
}

// =============================================================================
// BLOQUE 6 - DATOS FISCALES (SINGLETON & MASTER)
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    if (_safeTrim(item.recordType).toUpperCase() === "CONFIG_SISTEMA") return _applyConfigSistemaRules(item);

    const taxId = _safeTrim(item.taxId);
    if (!taxId || !_isValidNifOrEuVat(taxId)) _schemaError("taxId obligatorio y valido (espanol o VAT UE)");

    const legalName = _safeTrim(item.legalName);
    if (!legalName) _schemaError("legalName obligatoria");

    const type = _safeTrim(item.thirdPartyType).toUpperCase();
    if (!type || !VALID_THIRD_PARTY_TYPES.has(type)) _schemaError("thirdPartyType invalido");

    if (type === "STAFF") {
        if (!_isGuid(_safeTrim(item.bookingsResourceId))) _schemaError("thirdPartyType=STAFF exige bookingsResourceId GUID");
        if (!_safeTrim(item.memberId)) _schemaError("thirdPartyType=STAFF exige memberId");
    }
    return item;
}

export function DatosFiscales_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    if (_safeTrim(item.recordType).toUpperCase() === "CONFIG_SISTEMA") return _applyConfigSistemaRules(item);
    const taxId = _safeTrim(item.taxId);
    if (taxId && !_isValidNifOrEuVat(taxId)) _schemaError("taxId invalido en update");
    return item;
}

export function DatosFiscales_beforeRemove(item) {
    const id = _safeTrim(item?._id);
    const recType = _safeTrim(item?.recordType).toUpperCase();
    if (id === "CONFIG_SISTEMA_FISCAL" || recType === "CONFIG_SISTEMA") {
        _fiscalError("SINGLETON_PROTECTED: No se puede eliminar CONFIG_SISTEMA");
    }
    return item;
}

function _applyConfigSistemaRules(item) {
    for (const required of ["nifProductor", "nombreRazonProductor", "idSistemaInformatico"]) {
        if (!_isValidNifOrEuVat(item[required]) && _safeTrim(item[required]) === "") {
            _schemaError(`${required} obligatorio en CONFIG_SISTEMA`);
        }
    }
    return item;
}

// =============================================================================
// BLOQUE 7 - LIBRO ASIENTOS CONTABLES DETALLE (APPEND-ONLY)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en LibroAsientosContablesDetalle");

    const debit = Number(item.debit);
    const credit = Number(item.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) _schemaError("debit y credit numericos obligatorios");
    if (Math.abs(debit - credit) > 0.005) _schemaError(`Partida descuadrada: debit (${debit}) != credit (${credit})`);

    return item;
}

export function LibroAsientosContablesDetalle_beforeUpdate() {
    _fiscalError("Modificacion de LibroAsientosContablesDetalle prohibida (append-only)");
}

export function LibroAsientosContablesDetalle_beforeRemove() {
    _fiscalError("Borrado de LibroAsientosContablesDetalle prohibido (append-only)");
}

// =============================================================================
// BLOQUE 8 - CONTROL OPERATIVO
// =============================================================================

const APPEND_ONLY_CONTROL_TYPES = new Set(["WEBHOOK_EVENT", "DISPLAY_TOKEN"]);

export function ControlOperativo_beforeInsert(item) { return item; }

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item || {};
    if (APPEND_ONLY_CONTROL_TYPES.has(original.controlType)) {
        _fiscalError(`ControlOperativo/${original.controlType} es append-only: modificacion prohibida`);
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (APPEND_ONLY_CONTROL_TYPES.has(item?.controlType)) {
        _fiscalError(`ControlOperativo/${item.controlType} es append-only: borrado prohibido`);
    }
    return item;
}

// =============================================================================
// BLOQUE 9 - MOVIMIENTOS INVENTARIO (APPEND-ONLY)
// =============================================================================

const VALID_MOV_INVENTARIO_TYPES = new Set([
    "VENTA", "DEVOLUCION", "AJUSTE", "ENTRADA_STOCK", "SALIDA_STOCK", "TRANSFERENCIA",
]);

export function MovimientosInventario_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en MovimientosInventario");
    if (!_safeTrim(item.movementToken)) _schemaError("movementToken obligatorio");
    const mType = _safeTrim(item.movementType).toUpperCase();
    if (!mType || !VALID_MOV_INVENTARIO_TYPES.has(mType)) _schemaError("movementType invalido");
    if (mType === "AJUSTE" && !_safeTrim(item.reason)) _schemaError("reason obligatorio en AJUSTE");
    if (!Number.isFinite(Number(item.quantity))) _schemaError("quantity numerico obligatorio");
    return item;
}

export function MovimientosInventario_beforeUpdate() {
    _fiscalError("Modificacion de MovimientosInventario prohibida: ledger append-only");
}

export function MovimientosInventario_beforeRemove() {
    _fiscalError("Borrado de MovimientosInventario prohibido: ledger append-only");
}

// =============================================================================
// BLOQUE 10 - INVENTARIO STOCK VENTA (INVARIANTE)
// =============================================================================

export function InventarioStockVenta_beforeInsert(item) { return _validateInventarioStockVenta(item); }
export function InventarioStockVenta_beforeUpdate(item) { return _validateInventarioStockVenta(item); }

function _validateInventarioStockVenta(item) {
    if (!item || typeof item !== "object") return item;
    const onHand = Number(item.stockOnHand) || 0;
    const reserved = Number(item.stockReserved) || 0;
    if (onHand < 0 || reserved < 0) _schemaError("stockOnHand y stockReserved no pueden ser negativos");

    if (item.stockAvailable === undefined || item.stockAvailable === null) {
        item.stockAvailable = Math.max(0, onHand - reserved);
    } else {
        const available = Number(item.stockAvailable);
        if (available < 0 || Math.abs(available - (onHand - reserved)) > 0.001) {
            _schemaError("Invariante violada: stockAvailable debe ser igual a stockOnHand - stockReserved");
        }
    }
    return item;
}

// =============================================================================
// BLOQUE 11 - CITAS F2
// =============================================================================

const VALID_BOOKING_STATUS_CMS = new Set(["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
const VALID_PAYMENT_STATUS_CMS = new Set(["UNPAID", "PARTIAL", "PAID", "REFUNDED"]);
const VALID_BOOKING_TYPES = new Set(["SIMPLE", "DUAL_F1", "DUAL_F2"]);

export function CitasF2_beforeInsert(item) { return _validateCitasF2(item); }
export function CitasF2_beforeUpdate(item) { return _validateCitasF2(item); }

function _validateCitasF2(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.traceId)) _schemaError("traceId obligatorio en CitasF2");
    const bs = _safeTrim(item.bookingStatus).toUpperCase();
    if (bs && !VALID_BOOKING_STATUS_CMS.has(bs)) _schemaError(`bookingStatus invalido (${bs})`);
    const ps = _safeTrim(item.paymentStatus).toUpperCase();
    if (ps && !VALID_PAYMENT_STATUS_CMS.has(ps)) _schemaError(`paymentStatus invalido (${ps})`);
    const bt = _safeTrim(item.bookingType).toUpperCase();
    if (bt && !VALID_BOOKING_TYPES.has(bt)) _schemaError(`bookingType invalido (${bt})`);
    return item;
}

export function CitasF2_beforeRemove() {
    _fiscalError("Borrado directo de CitasF2 bloqueado: use cancelacion formal");
}

// =============================================================================
// BLOQUE 12 - COMPLEMENTOS CATALOGO
// =============================================================================

export function ComplementosCatalogo_beforeInsert(item) { return _validateComplementos(item); }
export function ComplementosCatalogo_beforeUpdate(item) { return _validateComplementos(item); }

function _validateComplementos(item) {
    if (!item || typeof item !== "object") return item;
    if (!_safeTrim(item.addonId)) _schemaError("addonId obligatorio en ComplementosCatalogo");
    if (!_safeTrim(item.sku)) _schemaError("sku obligatorio en ComplementosCatalogo");
    if (item.price !== undefined && Number(item.price) < 0) _schemaError("price no puede ser negativo");
    return item;
}

// =============================================================================
// BLOQUE 13 - INTERCEPCION DE LAS 8 COLECCIONES PROHIBIDAS (CERO LEGACY)
// =============================================================================

function _blockProhibited(name) {
    _fiscalError(`Acceso denegado a coleccion prohibida/legacy "${name}". Entidad extinguida segun SSOT.`);
}

export function ConfiguracionFiscal_beforeInsert() { _blockProhibited("ConfiguracionFiscal"); }
export function ConfiguracionFiscal_beforeUpdate() { _blockProhibited("ConfiguracionFiscal"); }
export function ConfiguracionFiscal_beforeRemove() { _blockProhibited("ConfiguracionFiscal"); }

export function AsientosContables_beforeInsert() { _blockProhibited("AsientosContables"); }
export function AsientosContables_beforeUpdate() { _blockProhibited("AsientosContables"); }
export function AsientosContables_beforeRemove() { _blockProhibited("AsientosContables"); }

export function EventosSistemaFacturacion_beforeInsert() { _blockProhibited("EventosSistemaFacturacion"); }
export function EventosSistemaFacturacion_beforeUpdate() { _blockProhibited("EventosSistemaFacturacion"); }
export function EventosSistemaFacturacion_beforeRemove() { _blockProhibited("EventosSistemaFacturacion"); }

export function FacturasRecibidas_beforeInsert() { _blockProhibited("FacturasRecibidas"); }
export function FacturasRecibidas_beforeUpdate() { _blockProhibited("FacturasRecibidas"); }
export function FacturasRecibidas_beforeRemove() { _blockProhibited("FacturasRecibidas"); }

export function LibroRegistroFacturasExpedidas_beforeInsert() { _blockProhibited("LibroRegistroFacturasExpedidas"); }
export function LibroRegistroFacturasExpedidas_beforeUpdate() { _blockProhibited("LibroRegistroFacturasExpedidas"); }
export function LibroRegistroFacturasExpedidas_beforeRemove() { _blockProhibited("LibroRegistroFacturasExpedidas"); }

export function LibroRegistroFacturasRecibidas_beforeInsert() { _blockProhibited("LibroRegistroFacturasRecibidas"); }
export function LibroRegistroFacturasRecibidas_beforeUpdate() { _blockProhibited("LibroRegistroFacturasRecibidas"); }
export function LibroRegistroFacturasRecibidas_beforeRemove() { _blockProhibited("LibroRegistroFacturasRecibidas"); }

export function PlanCuentasContables_beforeInsert() { _blockProhibited("PlanCuentasContables"); }
export function PlanCuentasContables_beforeUpdate() { _blockProhibited("PlanCuentasContables"); }
export function PlanCuentasContables_beforeRemove() { _blockProhibited("PlanCuentasContables"); }

export function CategoriasServicio_beforeInsert() { _blockProhibited("CategoriasServicio"); }
export function CategoriasServicio_beforeUpdate() { _blockProhibited("CategoriasServicio"); }
export function CategoriasServicio_beforeRemove() { _blockProhibited("CategoriasServicio"); }