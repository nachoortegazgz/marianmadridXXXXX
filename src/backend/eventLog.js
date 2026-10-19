/*
=============================================================================
MODULE: backend/eventLog.js
VERSION: v5015-ALIGNED
BASE: v5009-FISCAL-V20.1 + alineacion con internalConfig v12.0-SSOT-FINAL
      y dataAccess v2.1-UNIFIED
RESPONSIBILITY: Motor atomico de registro fiscal (append-only) + proyector
                secundario + API fiscal.
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Cero COLLECTIONS alias.

CAMBIOS DE ALINEACION v5015-ALIGNED (respecto a v5009-FISCAL-V20.1):
  ALN-01: COLLECTIONS/SINGLETONS alias eliminados. Uso de
          BUSINESS_COLLECTIONS / OPERATIONAL_COLLECTIONS y de
          SINGLETONS.CAJA_PRINCIPAL / .CAJA_SEQ.
  ALN-02: AEAT_INVOICE_TYPE -> TIPO_FACTURA (v12.0).
  ALN-03: VAT_ACCRUAL_STATUS no existe en v12.0. Constantes locales
          VAT_ACCRUAL_DEVENGADO / _ANTICIPADO / _APLICACION_ANTICIPO.
  ALN-04: LIBRO_ORIGEN_TIPO / LIBRO_ORIGEN_REGISTRO no existen en v12.0.
          Eliminados (import muerto; el modulo no los usaba).
  ALN-05: MOVEMENT_TYPE.DEVOLUCION_SERVICIO y .DEVOLUCION_PRODUCTO no
          existen en v12.0. Sustituidos por MOVEMENT_TYPE.DEVOLUCION /
          MOVEMENT_TYPE.REEMBOLSO.
  ALN-06: _getNextSequenceInternal: la version v5009 usaba
          _lockSlotKeyOrFail("FISCAL_SEQUENCE_LOCK", ...) que SIEMPRE falla
          contra bookingCore v5014 (el parser exige formato
          slot_{prefix}_{guid}_{epoch}_{epoch}). Se sustituye por
          concurrencia optimista via _revision de wix-data.
  ALN-07: COMPUTER_SYSTEM v12.0 = { nombre, version, getSecretKey } (forma
          nueva). El payload AEAT exige la nomenclatura Veri*factu
          (sistemaInformaticoNombre, idSistemaInformatico,
          numeroInstalacion, tipoUsoPosibleSoloVerifactu, etc.). Se
          define COMPUTER_SYSTEM_FALLBACK local; _getFiscalSystemConfig
          lee del singleton DatosFiscales y rellena con el fallback.
  ALN-08: wixData.query/get/insert/save -> dalQuery/dalGet/dalInsert/
          dalSave (dataAccess v2.1).
  ALN-09: _buildFiscalPayloadSnapshot usa el resultado resuelto de
          _getFiscalSystemConfig (antes usaba COMPUTER_SYSTEM de v5009
          directamente, quedando incompleto contra v12.0).

FIXES APLICADOS v5009-FISCAL-V20.1 (heredados):
  - V20-01..V20-04.
FIXES APLICADOS v5009-FISCAL (heredados):
  - FIX-EV-01..08.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";

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
    IVA_RATES,
    TIPO_FACTURA,
    FISCAL_ROLE,
    EVENT_TYPE,
    THIRD_PARTY_TYPE,
    PROJECTION_STATUS,
    RECORD_TYPE,
} from "backend/internalConfig";

import { hashChain } from "backend/securityEngine";

import {
    makeTraceId,
    _safeTrim,
    _cleanText,
    _looksLikeGuid,
    withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

// ============================================================================
// CONSTANTES (ALN-01, ALN-03)
// ============================================================================

const CASH_REGISTER_ID = SINGLETONS.CAJA_PRINCIPAL;
const CASH_SEQ_ID = SINGLETONS.CAJA_SEQ;

const VAT_ACCRUAL_DEVENGADO = "DEVENGADO";
const VAT_ACCRUAL_ANTICIPADO = "ANTICIPADO";
const VAT_ACCRUAL_APLICACION_ANTICIPO = "APLICACION_ANTICIPO";

const MOVIMIENTOS_CAJA_COL = BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA;
const CAJA_ACTUAL_COL = BUSINESS_COLLECTIONS.CAJA_ACTUAL;
const DATOS_FISCALES_COL = BUSINESS_COLLECTIONS.DATOS_FISCALES;
const SERVICIOS_CATALOGO_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const HISTORICO_CIERRES_Z_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;

const LEDGER_SCHEMA_VERSION = "LEDGER_V5_FISCAL";
const GENESIS_HASH = "0".repeat(64);

const PROYECCION_BATCH_LIMIT = 25;
const PROYECCION_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const SEQUENCE_MAX_RETRIES = 5;

// ============================================================================
// ALN-07: COMPUTER_SYSTEM (fallback local con nomenclatura Veri*factu)
// ============================================================================

const COMPUTER_SYSTEM_FALLBACK = Object.freeze({
    sistemaInformaticoNombre: "Wix Bookings - Marian Madrid CMS",
    idSistemaInformatico: "",
    version: "v5015-ALIGNED",
    numeroInstalacion: "1",
    tipoUsoPosibleSoloVerifactu: "N",
    tipoUsoPosibleMultiOT: "S",
    indicadorMultiplesOT: "S",
    nombreRazonProductor: "Marian Madrid",
});

let _fiscalSystemCache = null;
let _fiscalSystemCacheAt = 0;
const FISCAL_SYSTEM_CACHE_TTL_MS =
    Number(SDK_CONFIG?.SECURITY?.SECRET_CACHE_TTL_MS) || 300000;

async function _getFiscalSystemConfig(traceId) {
    const now = Date.now();
    if (_fiscalSystemCache && now - _fiscalSystemCacheAt < FISCAL_SYSTEM_CACHE_TTL_MS) {
        return _fiscalSystemCache;
    }
    let config = null;
    try {
        const res = await dalQuery(DATOS_FISCALES_COL)
            .eq("recordType", RECORD_TYPE.CONFIG_SISTEMA)
            .limit(1)
            .find();
        config = res?.items?.[0] || null;
    } catch (err) {
        log.warn("No se pudo leer el singleton fiscal (DatosFiscales CONFIG_SISTEMA)", {
            traceId, message: err?.message,
        });
    }
    _fiscalSystemCache = Object.freeze({
        sistemaInformaticoNombre:
            _safeTrim(config?.sistemaInformaticoNombre) ||
            _safeTrim(config?.nombreSistemaInformatico) ||
            COMPUTER_SYSTEM_FALLBACK.sistemaInformaticoNombre,
        idSistemaInformatico:
            _safeTrim(config?.idSistemaInformatico) ||
            COMPUTER_SYSTEM_FALLBACK.idSistemaInformatico,
        version:
            _safeTrim(config?.version) || COMPUTER_SYSTEM_FALLBACK.version,
        numeroInstalacion:
            _safeTrim(config?.numeroInstalacion) ||
            COMPUTER_SYSTEM_FALLBACK.numeroInstalacion,
        tipoUsoPosibleSoloVerifactu:
            _safeTrim(config?.tipoUsoPosibleSoloVerifactu) ||
            COMPUTER_SYSTEM_FALLBACK.tipoUsoPosibleSoloVerifactu,
        tipoUsoPosibleMultiOT:
            _safeTrim(config?.tipoUsoPosibleMultiOT) ||
            COMPUTER_SYSTEM_FALLBACK.tipoUsoPosibleMultiOT,
        indicadorMultiplesOT:
            _safeTrim(config?.indicadorMultiplesOT) ||
            COMPUTER_SYSTEM_FALLBACK.indicadorMultiplesOT,
        nifProductor: _safeTrim(config?.nifProductor),
        nombreRazonProductor:
            _safeTrim(config?.nombreRazonProductor) ||
            COMPUTER_SYSTEM_FALLBACK.nombreRazonProductor,
        fechaInicioVerifactu: _safeTrim(config?.fechaInicioVerifactu) || null,
    });
    _fiscalSystemCacheAt = now;
    return _fiscalSystemCache;
}

// ============================================================================
// SECCION 1 - HELPERS DE FECHA / AEAT
// ============================================================================

function _formatAEATDate(ymd) {
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    if (!match) return clean;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function _formatAEATDateTimeMadrid(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridOffset = (() => {
        const madridStr = dt.toLocaleString("en-US", {
            timeZone: "Europe/Madrid",
            timeZoneName: "longOffset",
        });
        const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(madridStr);
        if (m) return `${m[1]}${m[2]}:${m[3]}`;
        const localMadrid = new Date(dt.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
        const diffMinutes = Math.round((localMadrid - dt) / 60000);
        const sign = diffMinutes >= 0 ? "+" : "-";
        const abs = Math.abs(diffMinutes);
        return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    })();

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${madridOffset}`;
}

function _buildGenerationTimestamp(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

function _buildAEATPayload(movement, generatedAt) {
    const recipientTaxId = _safeTrim(movement.recipientTaxId);
    const recipientLegalName = _safeTrim(movement.recipientLegalName);
    const invoiceNumber = _safeTrim(movement.invoiceNumber);
    const invoiceIssueDate = _safeTrim(movement.invoiceIssueDate);
    const invoiceType = _safeTrim(movement.invoiceType) || TIPO_FACTURA.F1;
    const taxAmount = Number(movement.taxAmount ?? 0);
    const totalAmount = Number(movement.totalAmount ?? 0);
    const previousRecordHash = _safeTrim(movement.previousRecordHash);
    const issuerTaxId = _safeTrim(movement.issuerTaxId);
    const correctionType = _safeTrim(movement.correctionType);
    const previousInvoiceId = _safeTrim(movement.previousInvoiceId);
    const correctionReason = _safeTrim(movement.correctionReason);
    const vatAccrualStatus = _safeTrim(movement.vatAccrualStatus);
    const linkedAdvanceId = _safeTrim(movement.linkedAdvanceId);
    const irpfWithholdingAmount = Number(movement.irpfWithholdingAmount || 0);
    const withholdingBase = Number(movement.withholdingBase || 0);
    const fiscalRole = _safeTrim(movement.fiscalRole);
    const surchargeAmount = Number(movement.surchargeAmount ?? 0);
    const bankReconciliationReference = _safeTrim(movement.bankReconciliationReference);

    const fields = [
        ["IDEmisorFactura", issuerTaxId || ""],
        ["NumSerieFactura", invoiceNumber || ""],
        ["FechaExpedicionFactura", _formatAEATDate(invoiceIssueDate)],
        ["TipoFactura", invoiceType],
        ["CuotaTotal", String(taxAmount.toFixed(2))],
        ["ImporteTotal", String(totalAmount.toFixed(2))],
        ["Huella", previousRecordHash || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];

    if (recipientTaxId) fields.push(["NIFDestinatario", recipientTaxId.slice(0, 20)]);
    if (recipientLegalName) fields.push(["NombreRazonDestinatario", recipientLegalName.slice(0, 200)]);
    if (bankReconciliationReference) fields.push(["ReferenciaBancaria", bankReconciliationReference.slice(0, 60)]);

    if (vatAccrualStatus === VAT_ACCRUAL_APLICACION_ANTICIPO) {
        fields.push(["TipoRectificativa", "I"]);
        if (linkedAdvanceId) fields.push(["IdAnticipoVinculado", linkedAdvanceId.slice(0, 120)]);
    }

    if (correctionType) fields.push(["TipoRectificativa", correctionType.slice(0, 4)]);
    if (irpfWithholdingAmount > 0) {
        fields.push(["ImporteRetencionIRPF", String(irpfWithholdingAmount.toFixed(2))]);
        if (withholdingBase > 0) fields.push(["BaseImponibleRetencion", String(withholdingBase.toFixed(2))]);
        if (fiscalRole) fields.push(["RolFiscal", fiscalRole.slice(0, 10)]);
    }

    if (surchargeAmount > 0) fields.push(["ImporteRecargoEquivalencia", String(surchargeAmount.toFixed(2))]);
    if (correctionReason) fields.push(["MotivoRectificacion", correctionReason.slice(0, 4)]);
    if (previousInvoiceId) fields.push(["IdFacturaRectificada", previousInvoiceId.slice(0, 120)]);

    return fields.map(([k, v]) => `${k}=${v}`).join("&");
}

// ============================================================================
// SECCION 2 - SECUENCIA GLOBAL (ALN-06: concurrencia optimista)
// ============================================================================

export async function _getNextSequenceInternal(traceId) {
    for (let attempt = 0; attempt < SEQUENCE_MAX_RETRIES; attempt++) {
        try {
            let seqDoc = await dalGet(CAJA_ACTUAL_COL, CASH_SEQ_ID, "strong").catch(() => null);

            if (!seqDoc) {
                const legacyCashRegister = await dalGet(CAJA_ACTUAL_COL, CASH_REGISTER_ID, "strong").catch(() => null);
                const legacyCounters =
                    legacyCashRegister && legacyCashRegister.sequenceCounters
                        ? legacyCashRegister.sequenceCounters
                        : { seqGlobal: 0 };

                seqDoc = {
                    _id: CASH_SEQ_ID,
                    sequenceCounters: { ...legacyCounters },
                    migratedFrom: CASH_REGISTER_ID,
                    migratedAt: new Date(),
                    _createdDate: new Date(),
                    _updatedDate: new Date(),
                };

                try {
                    await dalInsert(CAJA_ACTUAL_COL, seqDoc);
                } catch (insertErr) {
                    // Carrera: otro proceso lo creo. Reintentar lectura.
                    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
                    continue;
                }
            }

            const counters = { ...(seqDoc.sequenceCounters || {}) };
            const nextGlobal = Number(counters.seqGlobal || 0) + 1;
            const yearKey = String(new Date().getFullYear());
            const nextYear = Number(counters[yearKey] || 0) + 1;
            counters.seqGlobal = nextGlobal;
            counters[yearKey] = nextYear;

            const updated = {
                ...seqDoc,
                sequenceCounters: counters,
                _updatedDate: new Date(),
            };

            // dataAccess.updateItem pasa el item a wixData.update; si lleva
            // _revision, Wix aplica concurrencia optimista y lanza error si
            // otra escritura incremento la revision.
            await dalUpdate(CAJA_ACTUAL_COL, updated);

            return {
                sequenceNumber: nextGlobal,
                yearSequence: nextYear,
                invoiceNumber: `FAC-${yearKey}-${String(nextYear).padStart(5, "0")}`,
            };
        } catch (err) {
            if (attempt === SEQUENCE_MAX_RETRIES - 1) {
                log.error("_getNextSequenceInternal exhausted retries", {
                    traceId, error: err?.message,
                });
                throw new Error(`SEQUENCE_ERROR: ${err?.message || "unknown"}`);
            }
            await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt) + Math.random() * 100));
        }
    }
    throw new Error("SEQUENCE_ERROR: unreachable");
}

async function _getLastCashEvent() {
    const res = await dalQuery(MOVIMIENTOS_CAJA_COL)
        .descending("sequenceNumber")
        .limit(1)
        .find();
    return res?.items?.[0] || null;
}

// ============================================================================
// SECCION 3 - MAESTROS
// ============================================================================

async function _upsertDatosFiscales({ taxId, legalName, thirdPartyType, contactData }, traceId) {
    const normalizedTaxId = _safeTrim(taxId).toUpperCase();
    if (!normalizedTaxId) return null;

    const existing = await dalQuery(DATOS_FISCALES_COL)
        .eq("taxId", normalizedTaxId)
        .limit(1)
        .find();

    if (existing?.items?.[0]) return existing.items[0];

    return await dalInsert(DATOS_FISCALES_COL, {
        taxId: normalizedTaxId,
        legalName: _safeTrim(legalName).toUpperCase() || "SIN NOMBRE",
        thirdPartyType: thirdPartyType || THIRD_PARTY_TYPE.CLIENTE,
        contactData: contactData || null,
        registrationTraceId: traceId,
        _createdDate: new Date(),
        _updatedDate: new Date(),
    });
}

async function _getServicioCatalogo(catalogId, traceId) {
    const id = _safeTrim(catalogId);
    if (!_looksLikeGuid(id)) return null;
    try {
        return await dalGet(SERVICIOS_CATALOGO_COL, id, "strong");
    } catch (_) {
        log.warn("Catalogo no encontrado", { traceId, catalogId: id });
        return null;
    }
}

// ============================================================================
// SECCION 4 - PAYLOAD FISCAL (ALN-09: usa sistema resuelto)
// ============================================================================

function _buildFiscalPayloadSnapshot({
    thirdParty, catalog, input, ts, previousRecordHash, recordHash, recordTimestamp, sistemaInformatico,
}) {
    return {
        idEmisorFactura: _safeTrim(input.issuerTaxId),
        nombreRazonEmisor: _safeTrim(input.issuerLegalName),
        nifDestinatario: _safeTrim(thirdParty?.taxId || input.recipientTaxId),
        nombreRazonDestinatario: _safeTrim(thirdParty?.legalName || input.recipientLegalName),
        domicilioDestinatario: thirdParty?.contactData || input.recipientAddress || null,
        emitidaPorTerceroODestinatario: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        nombreRazonTercero: _safeTrim(input.thirdPartyLegalName) || null,
        nifTerceroExpedidor: _safeTrim(input.issuerThirdPartyTaxId) || null,
        numSerieFactura: _safeTrim(input.invoiceNumber),
        fechaExpedicionFactura: _safeTrim(input.invoiceIssueDate),
        fechaOperacion: _safeTrim(input.operationDate) || null,
        tipoFactura: _safeTrim(input.invoiceType) || TIPO_FACTURA.F1,
        tipoRectificativa: _safeTrim(input.correctionType) || null,
        descripcionOperacion: _safeTrim(input.operationDescription),
        importeTotal: Number(input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.taxableBaseOrNonSubjectAmount ?? 0),
        cuotaTotal: Number(input.taxAmount ?? 0),
        tipoImpositivo: Number(input.taxRate ?? catalog?.taxRate ?? 0),
        tipoRecargoEquivalencia: Number(input.surchargeRate ?? 0),
        cuotaRecargoEquivalencia: Number(input.surchargeAmount ?? 0),
        importeRetencionIRPF: Number(input.irpfWithholdingAmount ?? 0),
        tipoRetencionIRPF: Number(input.irpfWithholdingRate ?? 0),
        baseImponibleRetencion: Number(input.withholdingBase ?? 0),
        claveRegimen: _safeTrim(input.regimeKey || catalog?.aeatRegimeKey) || "01",
        calificacionOperacion: _safeTrim(input.operationClassification || catalog?.aeatOperationClassification) || "S1",
        operacionExenta: _safeTrim(input.exemptOperation || catalog?.aeatExemptOperation) || null,
        inversionSujetoPasivo: input.reverseCharge === true || catalog?.reverseCharge === true,
        causaNoSujeta: _safeTrim(input.nonSubjectReason) || null,
        regimenEspecialCriterioCaja: input.cashBasisRegime === true,
        exentaPorArticulo20: input.article20Exempt === true,
        sistemaInformatico: { ...sistemaInformatico },
        idFacturaAnterior: _safeTrim(input.previousInvoiceId) || null,
        numSerieFacturaAnterior: _safeTrim(input.previousInvoiceNumber) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.previousInvoiceIssueDate) || null,
        huellaAnterior: previousRecordHash || null,
        huella: recordHash,
        fechaHoraHusoGenRegistro: recordTimestamp,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: Array.isArray(input.breakdown) ? input.breakdown : [],
    };
}

// ============================================================================
// SECCION 5 - MOTOR - registrarEventoEconomico
// ============================================================================

export async function registrarEventoEconomico(input) {
    const traceId = input.traceId || makeTraceId("evento");
    const ts = new Date();

    // 1. Resolver tercero
    const thirdParty = await _upsertDatosFiscales({
        taxId: input.recipientTaxId || input.issuerTaxId,
        legalName: input.recipientLegalName || input.issuerLegalName,
        thirdPartyType: input.thirdPartyType || THIRD_PARTY_TYPE.CLIENTE,
        contactData: input.contactData || input.recipientAddress || null,
    }, traceId);

    // 2. Resolver catalogo
    const catalog = await _getServicioCatalogo(input.catalogId, traceId);

    // 3. Sistema informatico (ALN-09)
    const sistemaInformatico = await _getFiscalSystemConfig(traceId);

    // 4. Ultimo evento + secuencia
    const previous = await _getLastCashEvent();
    const seq = await _getNextSequenceInternal(traceId);

    const previousRecordHash = _safeTrim(previous?.recordHash) || GENESIS_HASH;
    const recordTimestamp = _formatAEATDateTimeMadrid(ts);

    // 5. Construir movimiento base
    const movementTypeRaw = _safeTrim(input.movementType);
    const accountingAmount = Number(input.accountingAmount ??
        (movementTypeRaw === MOVEMENT_TYPE.REEMBOLSO ||
         movementTypeRaw === MOVEMENT_TYPE.DEVOLUCION
            ? -Number(input.totalAmount ?? 0)
            : Number(input.totalAmount ?? 0)));
    const baseMovement = {
        sequenceNumber: seq.sequenceNumber,
        invoiceNumber: _safeTrim(input.invoiceNumber) || seq.invoiceNumber,
        invoiceIssueDate: _safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        operationDate: _safeTrim(input.operationDate) || null,
        fiscalPeriod: (_safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" })).slice(0, 7),

        movementType: _safeTrim(input.movementType),
        eventType: _safeTrim(input.eventType),
        paymentMethod: _safeTrim(input.paymentMethod),
        channelType: _safeTrim(input.channelType) || "POS",

        totalAmount: Number(input.totalAmount ?? 0),
        accountingAmount,
        taxableBaseOrNonSubjectAmount: Number(input.taxableBaseOrNonSubjectAmount ?? 0),
        taxAmount: Number(input.taxAmount ?? 0),
        taxRate: Number(input.taxRate ?? IVA_RATES.GENERAL),
        surchargeRate: Number(input.surchargeRate ?? 0),
        surchargeAmount: Number(input.surchargeAmount ?? 0),
        irpfWithholdingAmount: Number(input.irpfWithholdingAmount ?? 0),
        irpfWithholdingRate: Number(input.irpfWithholdingRate ?? 0),
        withholdingBase: Number(input.withholdingBase ?? 0),
        fiscalRole: _safeTrim(input.fiscalRole) || FISCAL_ROLE.EMISOR,

        operationDescription: _cleanText(input.operationDescription || "", 500),

        invoiceType: _safeTrim(input.invoiceType) || TIPO_FACTURA.F1,
        correctionType: _safeTrim(input.correctionType) || null,
        correctionReason: _safeTrim(input.correctionReason) || null,
        previousInvoiceId: _safeTrim(input.previousInvoiceId) || null,
        previousInvoiceNumber: _safeTrim(input.previousInvoiceNumber) || null,
        previousInvoiceIssueDate: _safeTrim(input.previousInvoiceIssueDate) || null,
        issuerInvoiceNumber: _safeTrim(input.issuerInvoiceNumber) || null,
        correctionAmount: input.correctionAmount || null,

        issuerTaxId: _safeTrim(input.issuerTaxId),
        issuerLegalName: _safeTrim(input.issuerLegalName),
        recipientTaxId: _safeTrim(thirdParty?.taxId || input.recipientTaxId),
        recipientLegalName: _safeTrim(thirdParty?.legalName || input.recipientLegalName),
        recipientAddress: thirdParty?.contactData || input.recipientAddress || null,
        isB2B: input.isB2B === true,

        issuedByThirdPartyOrRecipient: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        thirdPartyLegalName: _safeTrim(input.thirdPartyLegalName) || null,
        issuerThirdPartyTaxId: _safeTrim(input.issuerThirdPartyTaxId) || null,
        nonSubjectReason: _safeTrim(input.nonSubjectReason) || null,
        reverseCharge: input.reverseCharge === true || catalog?.reverseCharge === true,

        regimeKey: _safeTrim(input.regimeKey || catalog?.aeatRegimeKey) || "01",
        operationClassification: _safeTrim(input.operationClassification || catalog?.aeatOperationClassification) || "S1",
        exemptOperation: _safeTrim(input.exemptOperation || catalog?.aeatExemptOperation) || null,
        cashBasisRegime: input.cashBasisRegime === true,
        article20Exempt: input.article20Exempt === true,

        linkedAdvanceId: _safeTrim(input.linkedAdvanceId) || null,
        vatAccrualStatus: _safeTrim(input.vatAccrualStatus) || VAT_ACCRUAL_DEVENGADO,
        bankReconciliationReference: _safeTrim(input.bankReconciliationReference) || null,

        resourceId: _safeTrim(input.resourceId) || null,
        staffResourceId: _safeTrim(input.staffResourceId) || null,
        linkedBookingIds: _safeTrim(input.linkedBookingIds) || null,
        transactionId: _safeTrim(input.transactionId) || `TX_${seq.sequenceNumber}`,
        orderId: _safeTrim(input.orderId) || null,
        refundId: _safeTrim(input.refundId) || null,
        pairToken: _safeTrim(input.pairToken) || null,

        thirdPartyId: thirdParty?._id || null,
        catalogId: catalog?._id || null,

        schemaVersion: LEDGER_SCHEMA_VERSION,
        recordSource: _safeTrim(input.recordSource) || "INTERNAL",
        lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    };

    // 6. AEAT payload + huella
    const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, ts);
    const recordHash = await hashChain(previousRecordHash, aeatPayload);

    // 7. Snapshot inmutable (ALN-09: sistemaInformatico resuelto)
    const fiscalPayload = _buildFiscalPayloadSnapshot({
        thirdParty, catalog, input, ts,
        previousRecordHash, recordHash,
        recordTimestamp,
        sistemaInformatico,
    });

    // 8. Doc cabecera
    const doc = {
        ...baseMovement,
        recordHash,
        previousRecordHash,
        recordTimestamp,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: fiscalPayload.desgloseDetallado,
        computerSystem: fiscalPayload.sistemaInformatico,
        fiscalPayload,
        projectionStatus: PROJECTION_STATUS.PENDIENTE,
        traceId,
        _createdDate: new Date(),
    };

    let cabecera;
    try {
        cabecera = await dalInsert(MOVIMIENTOS_CAJA_COL, doc);
    } catch (err) {
        log.error("registrarEventoEconomico: insercion de cabecera fallo", {
            traceId,
            message: err?.message,
            code: err?.code || null,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "LEDGER_INSERT_FAIL",
                message: err?.message || "No se pudo registrar el evento economico.",
                traceId,
            },
        };
    }

    // 9. Proyeccion secundaria - NUNCA propaga errores al caller
    const detailIds = [];
    let projectionStatus = PROJECTION_STATUS.OK;
    try {
        await _proyectarSegunTipoEvento(cabecera, detailIds, traceId);
    } catch (err) {
        projectionStatus = PROJECTION_STATUS.ERROR;
        log.error("Proyeccion secundaria fallo (no bloqueante)", {
            traceId,
            eventoId: cabecera._id,
            eventType: cabecera.eventType,
            message: err?.message,
        });
    }

    return {
        status: projectionStatus === PROJECTION_STATUS.OK ? "SUCCESS" : "PARTIAL",
        data: {
            cabeceraId: cabecera._id,
            detailIds,
            recordHash,
            sequenceNumber: seq.sequenceNumber,
            invoiceNumber: doc.invoiceNumber,
            projectionStatus,
        },
        error: null,
    };
}

// ============================================================================
// SECCION 6 - PROYECCION SECUNDARIA
// ============================================================================

async function _proyectarSegunTipoEvento(cabecera, detailIds, traceId) {
    switch (cabecera.eventType) {
        case EVENT_TYPE.VENTA_LINEA:
        case EVENT_TYPE.RECTIFICATIVA:
        case EVENT_TYPE.AJUSTE:
        case EVENT_TYPE.COMPRA_LINEA:
            // Sin proyeccion separada: MovimientosCaja es SSOT fiscal unico.
            break;
        case EVENT_TYPE.MOV_STOCK:
            await _proyectarMovimientoInventario(cabecera, traceId);
            break;
        case EVENT_TYPE.CIERRE_Z:
            await _proyectarCierreZ(cabecera, traceId);
            break;
        default:
            log.warn("Tipo evento sin proyeccion", { traceId, eventType: cabecera.eventType });
    }
}

async function _proyectarMovimientoInventario(cabecera, traceId) {
    try {
        const mod = await import("backend/inventario.web");
        const fn = mod?.recordInventoryMovementSafe;
        if (typeof fn !== "function") {
            log.warn("inventario.recordInventoryMovementSafe no disponible", { traceId });
            return;
        }
        await fn({
            wixProductId: cabecera.fiscalPayload?.wixProductId || null,
            sku: cabecera.fiscalPayload?.sku || null,
            orderId: cabecera.orderId || null,
            refundId: cabecera.fiscalPayload?.refundId || null,
            sourceEventId: cabecera._id,
            catalogId: cabecera.catalogId,
            magnitude: cabecera.fiscalPayload?.magnitude || 1,
            thirdPartyId: cabecera.thirdPartyId,
            traceId,
        });
    } catch (err) {
        log.warn("Proyeccion inventario fallo", { traceId, eventoId: cabecera._id, message: err?.message });
        throw err;
    }
}

async function _proyectarCierreZ(cabecera, traceId) {
    // NOTA: la proyeccion usa un subconjunto de campos no presentes en el
    // schema BIBLIA de HistoricoCierresZ (balancesByMethod, breakdownByRegime,
    // etc.). El CMS de Wix acepta campos arbitrarios, pero la BIBLIA define
    // totalCash/totalCard/totalBizum/totalOnline/snapshotJson. Se mantiene
    // este comportamiento por compatibilidad con el cierre Z legacy de
    // cajas.web.js (que escribe el schema BIBLIA). ADR pendiente para
    // unificar la forma del documento.
    try {
        await dalInsert(HISTORICO_CIERRES_Z_COL, {
            _id: `Z_${cabecera.invoiceIssueDate}`,
            operationDate: cabecera.invoiceIssueDate,
            balancesByMethod: cabecera.fiscalPayload?.saldosPorMetodo || {},
            sourceEventId: cabecera._id,
            breakdownByRegime: cabecera.fiscalPayload?.desglosePorRegimen || [],
            breakdownByOperationType: cabecera.fiscalPayload?.desglosePorTipoOperacion || [],
            breakdownByTaxRate: cabecera.fiscalPayload?.desglosePorTipoImpositivo || [],
            verifactuSummary: cabecera.fiscalPayload?.resumenVerifactu || {},
            aeatSubmissionStatus: "PENDIENTE",
            traceId,
            _createdDate: new Date(),
        });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("WDE0123") || msg.includes("Duplicated") || msg.includes("already exists")) {
            log.info("CierreZ ya existe (idempotente)", { traceId, fecha: cabecera.invoiceIssueDate });
            return;
        }
        throw err;
    }
}

// ============================================================================
// SECCION 7 - CONSULTAS DE EVENTOS
// ============================================================================

export const getEventoPorId = webMethod(
    Permissions.Admin,
    async (eventoId) => {
        const traceId = makeTraceId("get-evento");
        try {
            if (!_looksLikeGuid(eventoId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const evento = await dalGet(MOVIMIENTOS_CAJA_COL, eventoId, "strong").catch(() => null);
            if (!evento) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            return {
                status: "SUCCESS",
                data: {
                    cabecera: evento,
                    detalle: Array.isArray(evento.desgloseDetallado)
                        ? evento.desgloseDetallado
                        : (Array.isArray(evento.detailedBreakdown) ? evento.detailedBreakdown : []),
                },
                error: null,
            };
        } catch (error) {
            log.error("getEventoPorId fallo", { traceId, message: error?.message });
            return { status: "ERROR", data: null, error: { code: "LOOKUP_FAILED" } };
        }
    }
);

// ============================================================================
// SECCION 8 - RECONCILIACION (cron)
// ============================================================================

export async function reconciliarProyecciones() {
    const traceId = makeTraceId("recon");
    let processed = 0;
    let failed = 0;
    try {
        const pending = await dalQuery(MOVIMIENTOS_CAJA_COL)
            .ne("projectionStatus", PROJECTION_STATUS.OK)
            .descending("sequenceNumber")
            .limit(PROYECCION_BATCH_LIMIT)
            .find();

        for (const evento of pending.items || []) {
            try {
                await withTimeout(
                    () => _proyectarSegunTipoEvento(evento, [], traceId),
                    PROYECCION_TIMEOUT_MS,
                    "reconciliarProyecciones"
                );
                processed += 1;
            } catch (err) {
                failed += 1;
                log.warn("Reconciliacion fallo", {
                    traceId,
                    eventoId: evento._id,
                    message: err?.message,
                });
            }
        }

        return {
            status: "SUCCESS",
            data: { processed, failed, total: pending.items?.length || 0 },
        };
    } catch (err) {
        log.error("reconciliarProyecciones fallo global", { traceId, message: err?.message });
        return {
            status: "ERROR",
            data: { processed, failed },
            error: { code: "RECON_FAIL", message: err?.message },
        };
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    registrarEventoEconomico,
    _getNextSequenceInternal,
    getEventoPorId,
    reconciliarProyecciones,
};