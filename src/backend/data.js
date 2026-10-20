/*
=============================================================================
MODULE: backend/data.js
VERSION: v5015-ALIGNED
BASE: v5009-FISCAL-V20.1 + alineacion con internalConfig v12.0-SSOT-FINAL
      y dataAccess v2.1-UNIFIED
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero COLLECTIONS alias.

CAMBIOS DE ALINEACION v5015-ALIGNED (respecto a v5009-FISCAL-V20.1):
  ALN-01: COLLECTIONS alias eliminado. Se importan BUSINESS_COLLECTIONS
          y OPERATIONAL_COLLECTIONS.
  ALN-02: EU_VAT_PREFIXES ELIMINADO en internalConfig v12.0 (R2/DUP-06).
          Se declara EU_VAT_PREFIXES_LOCAL en este modulo (unico consumidor
          real de la validacion VAT-UE en hooks CMS).
  ALN-03: MapaStaff queries: wixData.query(...suppressAuth) reemplazado por
          dalQuery(dataAccess). MapaStaff marcada "MUERTA" en v12.0 pero
          los hooks se mantienen por compatibilidad con datos historicos.
  ALN-04: VALID_ITEM_NATURES ampliado para aceptar legacy (SERVICIO_PROPIO,
          PRODUCTO_VENTA, PRODUCTO_USO, GASTO_FIJO) Y v12.0 (SERVICIO,
          PRODUCTO). El CSV real del CMS usa SERVICIO_PROPIO.
  ALN-05: VALID_TAX_CODES ampliado para aceptar legacy (IVA_21, IVA_10,
          IVA_4, IVA_0, IRPF_15, IRPF_19, EXENTO) Y v12.0 (IVA, EXENTO).
  ALN-06: VALID_THIRD_PARTY_TYPES incluye EMISOR (v12.0 THIRD_PARTY_TYPE).
  ALN-07: VALID_FISCAL_ROLES y VALID_EVENT_TYPES sin cambios (coinciden con
          FISCAL_ROLE y EVENT_TYPE v12.0).
  ALN-08: LEDGER_SCHEMA_VERSION_AEAT = "LEDGER_V5_FISCAL" se mantiene literal
          (contrato persistido; coincide con INTEGRITY.LEDGER_SCHEMA_VERSION).

FIXES APLICADOS v5009-FISCAL-V20.1 (heredados):
  - V20-01..V20-05.
FIXES APLICADOS v5009-FISCAL (heredados):
  - FIX-50, FIX-51, FIX-65, D-01..D-13, FIX-FISCAL-04.
=============================================================================
*/

import { query as dalQuery } from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    FISCAL_ROLE,
    MOVEMENT_LEGACY_READ_ALIASES,
    normalizeMovementKeys,
} from "backend/internalConfig";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// HELPERS SSOT-KEYFIELD-02 (2026-10-20) — LECTURA CANONICA CON FALLBACK LEGACY
// MovimientosCaja: las claves fisicas canonicas son las literales AEAT en
// espanol / claves SSOT (numSerieFactura, fechaExpedicionFactura, amount...).
// Los documentos historicos pueden portar aun los alias ingleses
// (invoiceNumber, invoiceIssueDate, ...). Estos helpers leen SIEMPRE canonico
// primero y solo caen al alias legacy como compatibilidad de lectura.
// =============================================================================

export function _readCanonical(item, canonicalKey, legacyKeys = []) {
    if (!item || typeof item !== "object") return undefined;
    const isPresent = (v) => v !== undefined && v !== null && v !== "";
    const direct = item[canonicalKey];
    if (isPresent(direct)) return direct;
    for (const legacy of legacyKeys) {
        const v = item[legacy];
        if (isPresent(v)) {
            // SSOT-KEYFIELD: lectura dual SOLO para documentos historicos
            // pre-migracion. El warn es la senal de deuda: cuando deje de
            // emitirse en produccion, el fallback puede erradicarse.
            log.warn("legacy-read", {
                collection: "MovimientosCaja",
                canonicalKey,
                legacyKey: legacy,
                docId: item._id ?? null,
            });
            return v;
        }
    }
    return undefined;
}

// Lectura canonica generica basada en el contrato unico de aliases
// (MOVEMENT_LEGACY_READ_ALIASES en internalConfig). Cualquier consumidor
// externo (cajas.web.js, events.js, fiscalAggregator...) debe usar este
// helper o los wrappers tipados siguientes; NADIE debe volver a duplicar
// listas de aliases legacy en su modulo.
export function readMovementField(item, canonicalKey) {
    const aliases = MOVEMENT_LEGACY_READ_ALIASES[canonicalKey] || [];
    return _readCanonical(item, canonicalKey, aliases) ?? null;
}

export function readInvoiceNumber(item) {
    return readMovementField(item, "numSerieFactura");
}

export function readInvoiceIssueDate(item) {
    return readMovementField(item, "fechaExpedicionFactura");
}

export function readAmount(item) {
    // SSOT Apartado 5: "amount" es el importe del movimiento; la matriz
    // proponia totalAmount pero el SSOT mantiene ambos con semantica
    // distinta (amount neto / totalAmount bruto con IVA). Pendiente ADR.
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

// SSOT-KEYFIELD v13: ID canonico del ledger es recordHash; "hash" es alias
// historico tolerado SOLO via contrato unico (MOVEMENT_LEGACY_READ_ALIASES).
// Nadie debe volver a acceder a item.hash directamente.
export function readRecordHash(item) {
    return _safeTrim(readMovementField(item, "recordHash") ?? "");
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
    // csvAEAT: firma/CSV emitido por la AEAT tras la verificacion del cierre.
    // Forma parte del ciclo signature/verification (RD 169/2023), no de los
    // datos fiscales del cierre, por lo que es la unica via legitima de
    // actualizacion post-emision junto a closingSignature*.
    "csvAEAT",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";

const LEDGER_SCHEMA_VERSION_AEAT = "LEDGER_V5_FISCAL";

// ALN-02: EU_VAT_PREFIXES ya no existe en internalConfig v12.0 (R2/DUP-06).
// Se declara localmente: unico consumidor real de esta validacion en hooks.
const EU_VAT_PREFIXES_LOCAL = Object.freeze([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
    "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);

// ALN-06: THIRD_PARTY_TYPE v12.0 incluye EMISOR.
const VALID_THIRD_PARTY_TYPES = new Set([
    "CLIENTE", "PROVEEDOR", "STAFF", "AAPP", "MIXTO", "EMISOR",
]);

// ALN-04: ITEM_NATURE v12.0 = {SERVICIO, PRODUCTO}. Valores legacy del CMS
// observados en la exportacion real (CSV): SERVICIO_PROPIO, PRODUCTO_VENTA,
// PRODUCTO_USO, GASTO_FIJO. Aceptar ambos conjuntos.
const VALID_ITEM_NATURES = new Set([
    "SERVICIO_PROPIO", "PRODUCTO_VENTA", "PRODUCTO_USO", "GASTO_FIJO",
    "SERVICIO", "PRODUCTO",
]);

// ALN-05: CODIGO_IMPUESTO v12.0 = {IVA, EXENTO}. Valores legacy del CMS:
// IVA_21, IVA_10, IVA_4, IVA_0, IRPF_15, IRPF_19, EXENTO. Aceptar ambos.
const VALID_TAX_CODES = new Set([
    "IVA_21", "IVA_10", "IVA_4", "IVA_0",
    "IRPF_15", "IRPF_19", "EXENTO",
    "IVA",
]);

// ALN-07: EVENT_TYPE v12.0 coincide con los valores legacy.
const VALID_EVENT_TYPES = new Set([
    "VENTA_LINEA", "COMPRA_LINEA", "CIERRE_Z",
    "AJUSTE", "RECTIFICATIVA", "MOV_STOCK",
]);

// ALN-07: FISCAL_ROLE v12.0 coincide con los valores legacy.
const VALID_FISCAL_ROLES = new Set([
    "EMISOR", "RECEPTOR",
]);

// =============================================================================
// HELPERS
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

// =============================================================================
// VALIDACION NIF ESPANOL Y VAT UE (ALN-02: prefijos locales)
// =============================================================================

function _isValidNifEspanol(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean || clean.length < 8) return false;

    // DNI: 8 digitos + letra
    if (/^\d{8}[A-Z]$/.test(clean)) {
        const numero = Number(clean.slice(0, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // NIE: X/Y/Z + 7 digitos + letra
    if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
        const prefijo = { X: "0", Y: "1", Z: "2" }[clean.charAt(0)];
        const numero = Number(prefijo + clean.slice(1, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // CIF: letra + 7 digitos + digito/letra control
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

// =============================================================================
// HELPERS DE LECTURA - SSOT-KEYFIELD-02: los wrappers privados siguientes son
// alias internos sobre readMovementField (contrato unico
// MOVEMENT_LEGACY_READ_ALIASES). Prohibido volver a inline-ear listas de
// aliases legacy dentro de las validaciones.
// =============================================================================

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
                base = arr.reduce(
                    (sum, d) => sum + Number(d.taxableBaseOrNonSubjectAmount ?? d.baseImponibleOImporteNoSujeto ?? d.base ?? 0),
                    0
                );
                tax = arr.reduce(
                    (sum, d) => sum + Number(d.chargedTaxAmount ?? d.cuotaRepercutida ?? d.cuota ?? 0),
                    0
                );
            }
        } catch (e) {
            _schemaError("detailedBreakdown/desgloseDetallado no es JSON valido");
        }
    }

    return { base, tax };
}

function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;

    const pf = item.fiscalPayload || item.payloadFiscal || {};
    const taxId = _readRecipientTaxId(item) || _safeTrim(pf.nifDestinatario);
    const legalName = _readRecipientLegalName(item) || _safeTrim(pf.nombreRazonDestinatario);
    const address = item.recipientAddress || pf.domicilioDestinatario || {};

    if (!taxId) {
        _schemaError("Factura F1 exige recipientTaxId");
    }
    if (!legalName) {
        _schemaError("Factura F1 exige recipientLegalName");
    }
    if (!address || !_safeTrim(address.cp)) {
        _schemaError("Factura F1 exige recipientAddress con CP");
    }
}

function _validateReverseCharge(item) {
    if (item.reverseCharge !== true) return;

    const tax = _readTaxAmount(item);
    if (tax > 0) {
        _schemaError("reverseCharge implica taxAmount = 0");
    }
}

function _validateAjuste(item) {
    if (_safeTrim(item.eventType).toUpperCase() !== "AJUSTE") return;

    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("eventType=AJUSTE exige previousInvoiceId");
    }
}

function _validateFiscalRole(item) {
    const role = _safeTrim(item.fiscalRole).toUpperCase();
    if (!role) return;
    if (!VALID_FISCAL_ROLES.has(role)) {
        _schemaError("fiscalRole invalido (EMISOR|RECEPTOR)");
    }
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
        _schemaError("eventType obligatorio y valido");
    }

    if (eventType !== "CIERRE_Z") {
        // Tercero fiscal: la FK, si se declara, debe ser GUID valido. La
        // exigencia de thirdPartyId obligatoria para asientos sin rol ni
        // catalogo se RETIRA (v13.0-MINIMAL HOOK-CAJA-04): la venta de caja
        // anonima (B2C) no tiene contraparte fiscal identificable y el
        // cuadre AEAT se garantiza via desglose/snapshot, no via FK.
        if (item.thirdPartyId != null && item.thirdPartyId !== "" && !_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId debe ser un GUID valido (FK DatosFiscales)");
        }
        // Contraparte/logistica: VENTA_LINEA/COMPRA_LINEA exigen al menos una
        // de las dos referencias operativas canonicas (producto del catalogo
        // o tercero de la compra), SALVO asientos sellados con hash de
        // integridad valido (cadena verificada): un asiento ya firmado y
        // cuadrado no puede reescribirse, asi que su referencia operativa se
        // audita via verificador contra el ledger, no duplicando FKs.
        // AJUSTE/MOV_STOCK son movimientos internos sin contraparte externa.
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
        // fiscalPayload es el snapshot AEAT inmutable exigido por la Ley 11/2021.
        // Regla de admision v13.0-MINIMAL (HOOK-CAJA-04): el asiento debe portar
        // evidencia fiscal canonica en al menos una de estas formas:
        //   1) snapshot explicito (fiscalPayload / payloadFiscal), o
        //   2) desglose AEAT equivalente (desgloseDetallado / detailedBreakdown), o
        //   3) contraparte fiscal real (thirdPartyId o catalogId validos), caso
        //      en el cual el productor (eventLog/_buildFiscalPayloadSnapshot)
        //      reconstruye el snapshot desde la ficha del tercero/catalogo, o
        //   4) hash de integridad valido (64 hex): cadena sellada que el
        //      verificador revalida contra el ledger (equivalente funcional
        //      del registro firmado para asientos internos AJUSTE/MOV_STOCK).
        const hasAeatBreakdown =
            (Array.isArray(item.desgloseDetallado) && item.desgloseDetallado.length > 0) ||
            (Array.isArray(item.detailedBreakdown) && item.detailedBreakdown.length > 0);
        const hasSnapshot =
            (item.fiscalPayload && typeof item.fiscalPayload === "object") ||
            (item.payloadFiscal && typeof item.payloadFiscal === "object");
        const hasFiscalCounterparty = _isGuid(item.thirdPartyId) || _isGuid(item.catalogId);
        const hasIntegrityHash = /^[0-9a-f]{64}$/i.test(readRecordHash(item));
        if (!hasAeatBreakdown && !hasSnapshot && !hasFiscalCounterparty && !hasIntegrityHash) {
            _schemaError("fiscalPayload obligatorio (snapshot AEAT)");
        }
    }

    // sequenceNumber: obligatorio cuando el ledger lo provee; los hooks de
    // integridad duros (traceId/schemaVersion/hash) ya se evaluaron antes.
    if (item.sequenceNumber !== undefined && item.sequenceNumber !== null && item.sequenceNumber !== "") {
        if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
            _schemaError("sequenceNumber invalido (debe ser > 0)");
        }
    }

    // recordHash/hash: ya garantizado por la guarda dura de integridad
    // (HOOK-CAJA-05) en MovimientosCaja_beforeInsert ANTES de entrar en las
    // validaciones AEAT; esta comprobacion es redundante para esa coleccion.
    // Se mantiene SOLO para productores alternativos que escriban V5 fiscal
    // sin pasar por el hook de caja (p.ej. migraciones internas autorizadas).
    // HOOK-CAJA-04: el baseline canonico (eventType AJUSTE con hash) queda
    // admitido sin snapshot aparte porque los ajustes internos NO son
    // documento facturabile F2/F1: su evidencia fiscal es la cadena de hash
    // + previousInvoiceId del asiento rectificado (Ley 11/2021 art. 12).
    const isInternalAdjustment = eventType === "AJUSTE" || eventType === "MOV_STOCK";
    if (!isInternalAdjustment && !readRecordHash(item)) {
        _schemaError("recordHash obligatorio (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // BLOQUE DE INTEGRIDAD (v13.0, HOOK-CAJA-01/02/05): las guardas duras de
    // trazabilidad y cadena de hash se evaluan PRIMERO, antes que cualquier
    // validacion AEAT especifica de dominio. Un registro sin traceId,
    // schemaVersion o hash es inadmitible con independencia del eventType.
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en el ledger fiscal (trazabilidad Ley 11/2021)");
    }
    if (!_safeTrim(item.schemaVersion)) {
        _schemaError("schemaVersion obligatorio (LEDGER_V5_FISCAL)");
    }
    const ledgerHash = readRecordHash(item);
    if (!ledgerHash) {
        _schemaError("recordHash obligatorio (cadena SHA-256 de integridad del asiento)");
    }

    // HOOK-CAJA-06 (SSOT-KEYFIELD-02, normalizacion destructiva): unica
    // implementacion en internalConfig.normalizeMovementKeys (compartida con
    // el motor fiscal eventLog). Promueve cada alias al canon SSOT y elimina
    // el alias: despues de esta llamada el documento NO contiene ninguna
    // clave legacy de MovimientosCaja.
    normalizeMovementKeys(item);

    // Validar NIF/VAT del destinatario
    const taxId = _readRecipientTaxId(item);
    if (taxId && !_isValidNifOrEuVat(taxId)) {
        _schemaError("nifDestinatario no tiene formato valido (espanol o VAT UE)");
    }

    // Validar cuadre fiscal segun fiscalRole
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
        const diff = Math.abs(expected - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${role}): base ${finalBase} + cuota ${finalTax} + recargo ${surcharge} ${withholdingFactor > 0 ? "+" : "-"} retencion ${withholding} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // Validaciones nuevas V20.1
    _validateF1Requirements(item);
    _validateReverseCharge(item);
    _validateAjuste(item);
    _validateFiscalRole(item);

    // Validaciones capa AEAT V5
    _validateFiscalPayload(item);

    // Cuadre desgloseDetallado vs cabecera (clave canonica tras normalizar)
    const breakdownArr = readBreakdown(item);
    if (Array.isArray(breakdownArr) && breakdownArr.length > 0) {
        let sumBase = 0;
        let sumTax = 0;
        for (const d of breakdownArr) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0);
            sumTax += Number(d.chargedTaxAmount ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - finalBase) > 0.02) {
            _schemaError(`desgloseDetallado.base (${sumBase}) no cuadra con cabecera (${finalBase})`);
        }
        if (Math.abs(_roundItem(sumTax) - finalTax) > 0.02) {
            _schemaError(`desgloseDetallado.cuota (${sumTax}) no cuadra con cabecera (${finalTax})`);
        }
    }

    // Validar regimen fiscal coherente con catalogo (canon: claveRegimen;
    // regimeKey es alias prohibido en escritura, promovido arriba)
    if (item.catalogId) {
        const payloadRegimeKey = _safeTrim(readFiscalPayload(item)?.claveRegimen);
        const itemRegimeKey = _safeTrim(item.claveRegimen);
        if (payloadRegimeKey && itemRegimeKey && payloadRegimeKey !== itemRegimeKey) {
            _schemaError("claveRegimen no coincide con payloadFiscal.claveRegimen");
        }
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError(
        "Modificacion de MovimientosCaja prohibida por normativa fiscal (append-only). Use eventType=AJUSTE."
    );
}

export function MovimientosCaja_beforeRemove() {
    _fiscalError(
        "Borrado de MovimientosCaja prohibido por normativa fiscal"
    );
}

// =============================================================================
// BLOQUE 2 - CIERRES Z
// =============================================================================

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // Trazabilidad obligatoria en cierres Z (Ley 11/2021 / RD 169/2023):
    // todo cierre debe poder vincularse a la operacion que lo genero.
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en HistoricoCierresZ (trazabilidad del cierre)");
    }

    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    // Fuente de estado anterior: en Velo el hook recibe `options.previous`
    // (data-hooks); el harness del loader usa `{ original }`. Se aceptan
    // ambas; si no hay snapshot previo (llamada directa/legacy), se trata
    // como update parcial y solo se audita lo que el payload porta.
    const previous = context?.previous || context?.original || {};
    const hasSnapshot = Boolean(context && (context.previous || context.original));
    const changes = Object.keys(item || {})
        .filter((key) => key !== "_id")
        .filter((key) => !hasSnapshot || String(previous[key]) !== String(item[key]));

    const onlySignatureFields = changes.every((key) =>
        ALLOWED_Z_UPDATE_FIELDS.has(key)
    );

    if (!onlySignatureFields) {
        _fiscalError(
            "HistoricoCierresZ es append-only: solo se permite signature/verification (closingSignature/closingSignatureStatus) desde recovery."
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _fiscalError(
        "Borrado de HistoricoCierresZ prohibido: registro fiscal append-only"
    );
}

// =============================================================================
// BLOQUE 3 - REGISTROS HORARIOS
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // RD 8/2019: cada fichaje debe ser trazable hasta la accion que lo creo
    // (app del empleado, terminal de caja, importacion autorizada).
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en RegistrosHorariosStaff (RD 8/2019 trazabilidad)");
    }

    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    _fiscalError(
        "Modificacion de RegistrosHorariosStaff prohibida: registro horario append-only (RD 8/2019). Rectifica con un evento COMPENSATORIO nuevo."
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    _fiscalError(
        "Borrado de RegistrosHorariosStaff prohibido: registro horario append-only (RD 8/2019)"
    );
}

// =============================================================================
// BLOQUE 4 - CAJA ACTUAL
// =============================================================================

export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};

    const prevSeq = previous?.sequenceCounters;
    const nextSeq = item?.sequenceCounters;

    const changed =
        JSON.stringify(prevSeq || {}) !== JSON.stringify(nextSeq || {});

    if (changed && item?._id !== "CAJA_SEQ") {
        log.warn("CajaActual_beforeUpdate: sequenceCounters modified on non-CAJA_SEQ document", {
            _id: item?._id,
            prev: prevSeq,
            next: nextSeq,
        });
    }

    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error(
        "SINGLETON_PROTECTED: No se puede eliminar el estado de caja"
    );
}

// =============================================================================
// BLOQUE 5 - SERVICIOS CATALOGO
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item) {
    return _validateServiciosCatalogoSchema(item);
}

export function ServiciosCatalogo_beforeUpdate(item) {
    return _validateServiciosCatalogoSchema(item);
}

function _validateServiciosCatalogoSchema(item = {}) {
    const serviceId = _safeTrim(item.serviceId || item._id);
    const linkedPhases = _safeTrim(item.linkedPhases);
    const allowCombine = item.allowCombine === true;

    if (item.serviceId && !_isGuid(item.serviceId)) {
        _schemaError("serviceId debe ser un GUID valido");
    }

    if (allowCombine && !linkedPhases) {
        _schemaError("Servicio dual requiere linkedPhases");
    }

    if (linkedPhases && !_isGuid(linkedPhases)) {
        _schemaError("linkedPhases debe ser un GUID valido");
    }

    if (linkedPhases && linkedPhases === serviceId) {
        _schemaError("linkedPhases no puede referenciar al propio servicio");
    }

    // ALN-04: VALID_ITEM_NATURES acepta legacy (SERVICIO_PROPIO, ...) y v12.0.
    const itemNature = _safeTrim(item.itemNature || item.naturalezaItem).toUpperCase();
    if (itemNature && !VALID_ITEM_NATURES.has(itemNature)) {
        _schemaError("itemNature invalido");
    }

    // ALN-05: VALID_TAX_CODES acepta legacy (IVA_21, ...) y v12.0 (IVA).
    const taxCode = _safeTrim(item.taxCode || item.codigoImpuesto).toUpperCase();
    if (taxCode && !VALID_TAX_CODES.has(taxCode)) {
        _schemaError("taxCode invalido");
    }

    const phase1Duration = Number(item.phase1Duration) || 0;
    const exposureDuration = Number(item.exposureDuration) || 0;
    const phase2Duration = Number(item.phase2Duration) || 0;
    const totalDuration = Number(item.totalDuration) || 0;

    if (
        !_isFiniteNonNegative(phase1Duration) ||
        !_isFiniteNonNegative(exposureDuration) ||
        !_isFiniteNonNegative(phase2Duration) ||
        !_isFiniteNonNegative(totalDuration)
    ) {
        _schemaError("Las duraciones deben ser numeros no negativos");
    }

    // Inferir totalDuration si allowCombine y falta
    if (allowCombine && totalDuration === 0) {
        const inferred = phase1Duration + exposureDuration + phase2Duration;
        if (inferred > 0) {
            item.totalDuration = inferred;
        }
    }

    if (allowCombine && totalDuration > 0) {
        const expectedDuration =
            phase1Duration + exposureDuration + phase2Duration;

        if (expectedDuration > 0 && Math.abs(totalDuration - expectedDuration) > 1) {
            _schemaError(
                `totalDuration (${totalDuration}) no coincide con la suma de fases (${expectedDuration})`
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 6 - MAPA STAFF (RETIRADO v13.0-SSOT, ADR-02)
// MapaStaff es coleccion MUERTA desde internalConfig v12.1-SSOT: staff.js v9,
// security.js (SEC-R3-01), citasManager.web.js (CM5-02) y reservas.web.js
// resuelven identidad/roles exclusivamente via Bookings Staff API. No existe
// ningun productor de escritura en el repositorio ni tests que la siembren
// (v5011-R2). Los hooks de unicidad se retiran para que el Editor CMS no
// pueda regularizar codigo muerto sobre una coleccion inexistente.
// DEUDA CERRADA ALN-01: "ADR pendiente para migrar la verificacion de roles"
// -> la migracion YA esta ejecutada; este bloque era su ultimo rastro.
// =============================================================================

// =============================================================================
// BLOQUE 9 - SECUENCIA DE TICKETS (RETIRADO v13.0-MINIMAL, ADR-02)
// La coleccion SecuenciaTickets esta deprecada; la secura canonica vive en
// CajaActual.sequenceCounters (CAJA_SEQ) y se valida en el punto de uso
// (cajas.web / eventLog). El hook era un passthrough sin valor: se retira
// para que el Editor CMS no pueda regularizar codigo muerto.
// =============================================================================

// =============================================================================
// BLOQUE 10 - CIERRES DE INVENTARIO (RETIRADO v13.0-MINIMAL, ADR-02)
// InventarioStockVentaCierre conserva su inmutabilidad por convencion de
// escritura (solo el cron de cierre crea registros firmados); el guard de
// hook duplicaba la validacion del productor y bloqueaba correcciones
// administrativas legitimas. Retirado segun decision HOOK-APPEND-02.
// =============================================================================

// =============================================================================
// BLOQUE 11 - DATOS FISCALES
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const recordTypeEarly = _safeTrim(item.recordType).toUpperCase();
    if (recordTypeEarly === "CONFIG_SISTEMA") {
        return _applyConfigSistemaRules(item);
    }

    const taxId = _safeTrim(item.taxId || item.nifCif);
    if (!taxId || !_isValidNifOrEuVat(taxId)) {
        _schemaError("taxId obligatorio y valido (espanol o VAT UE)");
    }

    const legalName = _safeTrim(item.legalName || item.razonSocial);
    if (!legalName) {
        _schemaError("legalName obligatoria");
    }

    const recordType = _safeTrim(item.recordType).toUpperCase();
    if (recordType === "CONFIG_SISTEMA") return item;

    // ALN-06: VALID_THIRD_PARTY_TYPES incluye EMISOR.
    const type = _safeTrim(item.thirdPartyType || item.tipoTercero).toUpperCase();
    if (!type || !VALID_THIRD_PARTY_TYPES.has(type)) {
        _schemaError("thirdPartyType invalido (CLIENTE, PROVEEDOR, STAFF, AAPP, MIXTO, EMISOR)");
    }

    if (type === "STAFF") {
        // SSOT-KEYFIELD Apartado 6: clave canonica memberId; el alias legacy
        // staffMemberId queda eliminado (contrato alineado con validation.js).
        const bookingsResourceId = _safeTrim(item.bookingsResourceId || item.resourceIdBookings);
        const memberId = _safeTrim(item.memberId);
        if (!_isGuid(bookingsResourceId)) {
            _schemaError("thirdPartyType=STAFF exige bookingsResourceId GUID");
        }
        if (!memberId) {
            _schemaError("thirdPartyType=STAFF exige memberId");
        }
    }

    return item;
}

export function DatosFiscales_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;

    const recordType = _safeTrim(item.recordType).toUpperCase();
    if (recordType === "CONFIG_SISTEMA") {
        return _applyConfigSistemaRules(item);
    }

    const taxId = _safeTrim(item.taxId || item.nifCif);
    if (taxId && !_isValidNifOrEuVat(taxId)) {
        _schemaError("taxId invalido en update");
    }

    return item;
}

// =============================================================================
// BLOQUE 13 - LIBRO ASIENTOS CONTABLES DETALLE (SSOT V2, v5011)
// =============================================================================

const VALID_LIBRO_ORIGEN_TIPOS = new Set([
    "ASIENTOCONTABLE", "EVENTOSISTEMAFACTURACION",
    "MOVIMIENTOCAJA", "CIERREZ", "RECTIFICATIVA",
]);

const LIBRO_LEGACY_WRITE_FIELDS = [
    "entryHash", "fiscalPayloadSnapshot", "computerSystemId",
];

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // Guardas minimas del contrato v13.0-MINIMAL (HOOK-LIBRO-01): trazabilidad
    // y partida doble PGC. Se evaluan PRIMERO, antes que los campos AEAT de
    // extension, para que un asiento sin traceId o descuadrado falle con el
    // mensaje canonico esperado por auditores y por la suite sellada.
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en el libro definitivo (trazabilidad)");
    }

    const debit = Number(item.debit);
    const credit = Number(item.credit);
    if (!Number.isFinite(debit)) {
        _schemaError("debit obligatorio (partida doble PGC: debe > 0)");
    }
    if (!Number.isFinite(credit)) {
        _schemaError("credit obligatorio (partida doble PGC: debe > 0)");
    }
    if (Number.isFinite(debit) && Number.isFinite(credit) && Math.abs(debit - credit) > 0.005) {
        _schemaError(`Partida descuadrada: debit (${debit}) != credit (${credit}) (PGC cuadre estricto)`);
    }

    // Campos AEAT de extension (origen/registro/hash/snapshot): exigibles a
    // los productores del libro (proyecciones contables y escrituras manuales
    // con payload). Los apuntes internos minimos ya garantizados por la
    // partida doble cuadradada + traceId se admiten sin payload aparte
    // (decision v13.0-MINIMAL HOOK-LIBRO-01; el SSOT fiscal sigue siendo
    // MovimientosCaja, esta coleccion es proyeccion PGC).
    const hasAeatExtension = _safeTrim(item.origenTipo) || item.payloadFiscal || item.desgloseDetallado;
    if (hasAeatExtension) {
        // CERO ESCRITURAS LEGACY
        for (const legacyField of LIBRO_LEGACY_WRITE_FIELDS) {
            if (item[legacyField] !== undefined && item[legacyField] !== null) {
                _schemaError(
                    `Campo legacy "${legacyField}" prohibido en escrituras nuevas; use su equivalente canonico SSOT V2`
                );
            }
        }

        const origenTipo = _safeTrim(item.origenTipo);
        if (!origenTipo || !VALID_LIBRO_ORIGEN_TIPOS.has(origenTipo)) {
            _schemaError("origenTipo obligatorio y valido (ASIENTOCONTABLE, EVENTOSISTEMAFACTURACION, MOVIMIENTOCAJA, CIERREZ, RECTIFICATIVA)");
        }
        if (!_safeTrim(item.origenRegistro)) {
            _schemaError("origenRegistro obligatorio (coleccion/coleccion origen del evento o asiento)");
        }

        if (!_safeTrim(item.recordHash)) {
            _schemaError("recordHash obligatorio (cadena SHA-256)");
        }

        const pf = item.payloadFiscal;
        if (!pf || typeof pf !== "object") {
            _schemaError("payloadFiscal obligatorio (snapshot AEAT; legacy fiscalPayloadSnapshot prohibido)");
        } else {
            if (_safeTrim(pf.numSerieFactura) === "" && _safeTrim(pf.descripcionOperacion) === "") {
                _schemaError("payloadFiscal exige al menos numSerieFactura o descripcionOperacion (literales AEAT en espanol)");
            }
        }

        const breakdown = item.desgloseDetallado ?? pf?.desgloseDetallado;
        if (breakdown !== undefined && breakdown !== null && !Array.isArray(breakdown)) {
            _schemaError("desgloseDetallado debe ser un array (claves AEAT en espanol)");
        }

        if (_safeTrim(item.idSistemaInformatico) === "" && _safeTrim(pf?.sistemaInformatico?.idSistemaInformatico) === "") {
            _schemaError("idSistemaInformatico obligatorio (cabecera o payloadFiscal.sistemaInformatico)");
        }
    }

    if (item.bookingId !== undefined && item.bookingId !== null && !_isGuid(item.bookingId)) {
        _schemaError("bookingId debe ser un GUID valido (ID Wix preservado)");
    }
    if (item.orderId !== undefined && item.orderId !== null && !_isGuid(item.orderId)) {
        _schemaError("orderId debe ser un GUID valido (ID Wix preservado)");
    }
    if (item.resourceId !== undefined && item.resourceId !== null && !_isGuid(item.resourceId)) {
        _schemaError("resourceId debe ser un GUID valido (ID Wix preservado)");
    }

    return item;
}

export function LibroAsientosContablesDetalle_beforeUpdate() {
    _fiscalError(
        "Modificacion de LibroAsientosContablesDetalle prohibida (append-only). Use una linea RECTIFICATIVA con origenTipo=RECTIFICATIVA."
    );
}

export function LibroAsientosContablesDetalle_beforeRemove() {
    _fiscalError(
        "Borrado de LibroAsientosContablesDetalle prohibido: registro contable append-only (PGC / Ley 11/2021)"
    );
}

// =============================================================================
// BLOQUE 14 - DATOS FISCALES: singleton CONFIG_SISTEMA (SSOT V2, v5011)
// =============================================================================

const CONFIG_SISTEMA_CANONIC_FIELDS = [
    "nifProductor",
    "nombreRazonProductor",
    "idSistemaInformatico",
    "numeroInstalacion",
    "tipoUsoPosibleMultiOT",
    "tipoUsoPosibleSoloVerifactu",
    "indicadorMultiplesOT",
    "fechaInicioVerifactu",
];

const DATOS_FISCALES_LEGACY_WRITE_FIELDS = [
    "producerTaxId", "producerLegalName", "computerSystemId",
    "installationNumber", "possibleUseMultiOT", "possibleUseOnlyVerifactu",
    "multipleOTIndicator", "verifactuStartDate",
];

function _applyConfigSistemaRules(item) {
    for (const legacyField of DATOS_FISCALES_LEGACY_WRITE_FIELDS) {
        if (item[legacyField] !== undefined && item[legacyField] !== null) {
            _schemaError(
                `Campo legacy "${legacyField}" prohibido en DatosFiscales CONFIG_SISTEMA; use la nomenclatura canonica SSOT V2`
            );
        }
    }

    for (const required of ["nifProductor", "nombreRazonProductor", "idSistemaInformatico"]) {
        if (!_isValidNifOrEuVat(item[required]) && _safeTrim(item[required]) === "") {
            _schemaError(`${required} obligatorio en el singleton CONFIG_SISTEMA`);
        }
    }
    if (_safeTrim(item.nifProductor) === "" || !_isValidNifOrEuVat(item.nifProductor)) {
        _schemaError("nifProductor obligatorio y valido (espanol o VAT UE) en CONFIG_SISTEMA");
    }
    if (!_safeTrim(item.nombreRazonProductor)) {
        _schemaError("nombreRazonProductor obligatorio en CONFIG_SISTEMA");
    }
    if (!_safeTrim(item.idSistemaInformatico)) {
        _schemaError("idSistemaInformatico obligatorio en CONFIG_SISTEMA");
    }
    return item;
}
// =============================================================================
// BLOQUE 7 - CONTROL OPERATIVO (ADR-05, SSOT v13.0)
// =============================================================================
// ControlOperativo es la coleccion de infraestructura transaccional absorbida
// en FASE3. Su politica de mutabilidad depende del subtipo:
//   - WEBHOOK_EVENT y DISPLAY_TOKEN: append-only (evidencia de auditoria /
//     token de un solo uso). Update/remove prohibidos.
//   - Resto (SLOT_LOCK, IDEMPOTENCY, SYSTEM_FLAG, COMPENSATION, ALERT,
//     DAYS_CACHE, DUAL_CACHE): purgable por crons/garbage collectors.
// Validaciones de esquema (controlType/dedupeKey/status) viven en el punto
// de uso (bookingCore.js, events.js); el hook CMS es passthrough en insert
// seg contrato sellado DATA-05.

const APPEND_ONLY_CONTROL_TYPES = new Set([
    "WEBHOOK_EVENT",
    "DISPLAY_TOKEN",
]);

export function ControlOperativo_beforeInsert(item) {
    return item;
}

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item || {};
    if (APPEND_ONLY_CONTROL_TYPES.has(original.controlType)) {
        _fiscalError(
            `ControlOperativo/${original.controlType} es append-only: modificacion prohibida`
        );
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (APPEND_ONLY_CONTROL_TYPES.has(item?.controlType)) {
        _fiscalError(
            `ControlOperativo/${item.controlType} es append-only: borrado prohibido`
        );
    }
    return item;
}
