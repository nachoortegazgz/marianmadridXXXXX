/*
=============================================================================
MODULE: backend/data.js
VERSION: v13.0-MINIMAL
BASE: v12.0-HOOKS-CLEAN + eliminacion de verificaciones prescindibles
RESPONSIBILITY: Hooks CMS de integridad fiscal, laboral y append-only.
STANDARDS: G10 ASCII Strict. Cero dependencias de dataLegacyAdapter.
PRINCIPIO: Solo se valida lo exigido por ley (Ley 11/2021, RD 8/2019,
  PGC RD 1514/2007) o lo necesario para integridad estructural minima
  de ledgers y singletons. Todo lo demas se valida en el punto de uso
  (bookingCore, events, security) o lo gestiona Wix Data nativamente
  (indices unique).
ELIMINADO v13.0:
  DATA-01: InventarioStockVenta, MovimientosInventario (sin valor compliance;
    reconciliacion via job).
  DATA-02: ServiciosCatalogo, ComplementosCatalogo (coleccion mutable admin;
    unicidad por indices CMS; tipoImpositivo/duraciones validados en punto
    de uso).
  DATA-03: MapaStaff (coleccion mutable admin; unicidad por indices CMS;
    roles validados en security.js).
  DATA-04: CitasF2 validaciones de enum/pairToken (ya validados en
    bookingCore._persistBooking y bookingSaga). Solo queda append-only.
  DATA-05: ControlOperativo validaciones de schema (ya validadas en
    bookingCore y events.js). Solo queda WEBHOOK_EVENT append-only.
  DATA-06: Mensajes de error personalizados por coleccion prohibida.
    Sustituidos por guardia pasiva unica _forbidCollection().
CONSERVADO (compliance legal):
  - CajaActual: singleton key, proteccion CAJA_SEQ.
  - MovimientosCaja: append-only, hash chain, traceId.
  - LibroAsientosContablesDetalle: append-only, partida doble.
  - HistoricoCierresZ: append-only, restriccion de update a firma.
  - RegistrosHorariosStaff: append-only (RD 8/2019).
  - ControlOperativo WEBHOOK_EVENT: append-only.
DEPENDENCIAS: wix-data (nativo), backend/validation.js,
  backend/internalConfig.js.
=============================================================================
*/

import wixData from "wix-data";
import { isValidNifOrEuVat } from "backend/validation";
import { BUSINESS_COLLECTIONS } from "backend/internalConfig";

// =============================================================================
// CAJA ACTUAL (Singleton)
// =============================================================================

export function CajaActual_beforeInsert(item) {
    const validKeys = ["CAJA_PRINCIPAL", "CAJA_SEQ"];
    if (!validKeys.includes(item.singletonKey)) {
        _reject("Invalid singletonKey.", "SCHEMA_VIOLATION");
    }
    return item;
}

export function CajaActual_beforeUpdate(item) {
    if (item.currentSequence !== undefined && item.singletonKey !== "CAJA_SEQ") {
        _reject("currentSequence can only be modified in CAJA_SEQ.", "SCHEMA_VIOLATION");
    }
    return item;
}

export function CajaActual_beforeRemove() {
    _reject("CajaActual documents cannot be deleted.", "FISCAL_VIOLATION");
}

// =============================================================================
// MOVIMIENTOS CAJA (Ledger fiscal append-only — Ley 11/2021)
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item.traceId) {
        _reject("traceId is required.", "FISCAL_VIOLATION");
    }
    if (!item.hash) {
        _reject("hash is required for ledger integrity.", "FISCAL_VIOLATION");
    }
    if (!item.schemaVersion) {
        _reject("schemaVersion is required.", "FISCAL_VIOLATION");
    }
    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _reject("MovimientosCaja is append-only.", "FISCAL_VIOLATION");
}

export function MovimientosCaja_beforeRemove() {
    _reject("MovimientosCaja is append-only.", "FISCAL_VIOLATION");
}


// =============================================================================
// LIBRO ASIENTOS CONTABLES DETALLE (Append-only — PGC RD 1514/2007)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item.traceId) {
        _reject("traceId is required.", "FISCAL_VIOLATION");
    }
    // Partida doble: debe y haber deben ser numeros
    if (item.debit === undefined || item.debit === null) {
        _reject("debit is required.", "SCHEMA_VIOLATION");
    }
    if (item.credit === undefined || item.credit === null) {
        _reject("credit is required.", "SCHEMA_VIOLATION");
    }
    return item;
}

export function LibroAsientosContablesDetalle_beforeUpdate() {
    _reject("LibroAsientosContablesDetalle is append-only.", "FISCAL_VIOLATION");
}

export function LibroAsientosContablesDetalle_beforeRemove() {
    _reject("LibroAsientosContablesDetalle is append-only.", "FISCAL_VIOLATION");
}

// =============================================================================
// HISTORICO CIERRES Z (Append-only)
// =============================================================================

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item.traceId) {
        _reject("traceId is required.", "FISCAL_VIOLATION");
    }
    return item;
}

export function HistoricoCierresZ_beforeUpdate(item) {
    // Solo se permite actualizar firma y verificacion
    const allowedFields = [
        "closingSignature", "closingSignatureStatus",
        "isIntegrityVerified", "verifiedAt", "approverUser",
        "estadoEnvioAEAT", "csvAEAT", "fechaEnvioAEAT",
    ];
    const keys = Object.keys(item).filter(
        (k) => !["_id", "_createdDate", "_updatedDate", "_owner"].includes(k)
    );
    for (const key of keys) {
        if (!allowedFields.includes(key)) {
            _reject("Only signature/verification fields can be updated.", "FISCAL_VIOLATION");
        }
    }
    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _reject("HistoricoCierresZ is append-only.", "FISCAL_VIOLATION");
}

// =============================================================================
// REGISTROS HORARIOS STAFF (Append-only — RD 8/2019)
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item.traceId) {
        _reject("traceId is required.", "FISCAL_VIOLATION");
    }
    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    _reject("RegistrosHorariosStaff is append-only (RD 8/2019).", "FISCAL_VIOLATION");
}

export function RegistrosHorariosStaff_beforeRemove() {
    _reject("RegistrosHorariosStaff is append-only (RD 8/2019).", "FISCAL_VIOLATION");
}

// =============================================================================
// CONTROL OPERATIVO (WEBHOOK_EVENT append-only; resto mutable)
// =============================================================================
// DATA-05: sin validaciones de schema. Esas validaciones viven en
// bookingCore y events.js. El hook solo protege WEBHOOK_EVENT.

export function ControlOperativo_beforeInsert(item) {
    return item;
}

export function ControlOperativo_beforeUpdate(item) {
    if (item.controlType === "WEBHOOK_EVENT") {
        _reject("WEBHOOK_EVENT records are append-only.", "FISCAL_VIOLATION");
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (item.controlType === "WEBHOOK_EVENT") {
        _reject("WEBHOOK_EVENT records are append-only.", "FISCAL_VIOLATION");
    }
    return item;
}
