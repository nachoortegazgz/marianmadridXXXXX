/*
 * MODULE: backend/internalConfig.js
 * VERSION: v5010.11-SSOT-RESTORED
 * Correcciones criticas aplicadas (depuracion 2026-10-19):
 * - Se restauran los exports eliminados por la edicion v5010.10 que rompieron
 *   TODOS los modulos dependientes (SyntaxError: does not provide an export
 *   named 'ROL_WEBSITE', etc.). Lista completa verificada contra los
 *   importadores reales de src/ (backend, pages, public y suites de tests).
 * - Se conservan los nombres publicos originales de las constantes.
 * - Se corrigen referencias BOOKING_STATUS.
 * - Se conservan los enums nativos Wix con guion bajo.
 * - Se corrige el identificador de Alba.
 * - Se corrige la plantilla de buildInvoiceNumber.
 */

export const STAFF = Object.freeze({
  IDS: Object.freeze([
    "e556070a-6d6a-402e-8422-11133033ea76",
    "07f7344f-e7e4-4c53-854b-47fd82ac8d40",
    "9b905bfd-1a09-485d-9273-a24a20dfe648",
  ]),
  RESOURCE_TO_DISPLAY: Object.freeze({
    "e556070a-6d6a-402e-8422-11133033ea76": "MARIAN MADRID",
    "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "ANDREA STAFF",
    "9b905bfd-1a09-485d-9273-a24a20dfe648": "ALBA STAFF",
  }),
});

// Nombre por defecto cuando la identidad staff no se puede resolver via
// Bookings Staff API (staff.js v9, PEND-MAP-01).
export const STAFF_DEFAULT_NAME = "STAFF";

export const BUSINESS_COLLECTIONS = Object.freeze({
  CAJA_ACTUAL: "CajaActual",
  CITAS_F2: "CitasF2",
  COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
  CONTROL_OPERATIVO: "ControlOperativo",
  DATOS_FISCALES: "DatosFiscales",
  HISTORICO_CIERRES_Z: "HistoricoCierresZ",
  LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
  INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
  MOVIMIENTOS_CAJA: "MovimientosCaja",
  REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
  SERVICIOS_CATALOGO: "ServiciosCatalogo",
});

// FASE3 (8-en-1, ADR-05): las colecciones de soporte/lock/cache fueron
// absorbidas por ControlOperativo. CERO-ALIAS (v13.0): los alias singulares
// MOVIMIENTO_CAJA / MOVIMIENTO_INVENTARIO y las claves sin consumidores
// PROVEEDORES_LISTA / SERVICIOS_CATALOGO quedan ERRADICADOS del SSOT; el
// nombre canonico plural vive en BUSINESS_COLLECTIONS (MOVIMIENTOS_CAJA) y
// OPERATIONAL_COLLECTIONS (MOVIMIENTOS_INVENTARIO). CONTROL_OPERATIVO se
// expone deliberadamente en ambos grupos con el mismo valor (alias
// intencional documentado en unit.testRunner allowedOverlaps).
export const OPERATIONAL_COLLECTIONS = Object.freeze({
  CONTROL_OPERATIVO: "ControlOperativo",
  MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});

// ITEM_NATURE canonico v12.0+ (SSOT-08). Los valores legacy observados en la
// exportacion real del CMS (SERVICIO_PROPIO, PRODUCTO_VENTA, PRODUCTO_USO,
// GASTO_FIJO) se aceptan en lectura via data.js VALID_ITEM_NATURES pero NO
// forman parte del enum canonico de escritura.
export const ITEM_NATURE = Object.freeze({
  SERVICIO: "SERVICIO",
  PRODUCTO: "PRODUCTO",
});

export const FORBIDDEN_COLLECTIONS = Object.freeze([
  "AsientosContables",
  "EventosSistemaFacturacion",
  "FacturasRecibidas",
  "ConfiguracionFiscal",
  "LibroRegistroFacturasRecibidas",
  "PlanCuentasContables",
  "CategoriasServicio",
  "LibroRegistroFacturasExpedidas",
]);

export const RECORD_TYPE = Object.freeze({
  TERCERO: "TERCERO",
  CONFIG_SISTEMA: "CONFIG_SISTEMA",
});
export const RECORDTYPECONFIGSISTEMA = RECORD_TYPE.CONFIG_SISTEMA;

export const COLLECTIONS = Object.freeze({
  ...BUSINESS_COLLECTIONS,
  ...OPERATIONAL_COLLECTIONS,
});

export const API = Object.freeze({
  STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
  MARIAN_MANAGEMENT_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

export const SDK_CONFIG = Object.freeze({
  TZ: "Europe/Madrid",
  LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
  LOCATION_TYPES: Object.freeze({
    TIME_SLOTS: "BUSINESS",
    BOOKINGS_WRITER: "OWNER_BUSINESS",
  }),
  M365: Object.freeze({ ENABLED: false }),
  ACCOUNTING: Object.freeze({ ENABLED: false }),
  SYNC_BOOKINGS_SERVICES_ENABLED: false,
});

export const BOOKING_STATUS = Object.freeze({
  CREATED: "CREATED",
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  DECLINED: "DECLINED",
  WAITING_LIST: "WAITING_LIST",
  UPDATED: "UPDATED",
  CANCELED: "CANCELED",
  REFUNDED: "REFUNDED",
});

export const INACTIVE_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.CANCELED,
  BOOKING_STATUS.DECLINED,
  "REJECTED",
  "NOSHOW",
]);

export const PAYMENT_STATUS = Object.freeze({
  UNDEFINED: "UNDEFINED",
  NOT_PAID: "NOT_PAID",
  // FASE1-P0 (MATRIZ alias F): el alias UNPAID queda ERRADICADO. El valor
  // canonico es NOT_PAID; CITAS_PAYMENT_STATUS.UNPAID es dominio de lectura
  // legacy del CMS y no sustituye este enum.
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PENDING_LEDGER: "PENDING_LEDGER",
  PAID: "PAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  EXEMPT: "EXEMPT",
});

/* ===========================================================================
 * BLOQUE RESTAURADO (v5010.11): constantes consumidas por los modulos de
 * src/. Valores verificados contra los usos reales (comparaciones con
 * literales del ledger fiscal, espejo publico mmUtils.js, enums citados por
 * validation.js/cajas.web.js/crons.js y fixtures de las suites node --test).
 * =========================================================================*/

// Identidad de apps Wix usada por events.js / citasManager.web.js /
// bookingSaga.js al filtrar webhooks y crear bookings.
export const APP_IDS = Object.freeze({
  BOOKINGS: "bookings",
});

// Roles de sitio (security.js SEC-R3, staff.js v9 rolWebsite).
export const ROL_WEBSITE = Object.freeze({
  ADMIN: "ADMIN",
  GESTION: "GESTION",
  ESTILISTA: "ESTILISTA",
});

// Config JWT de securityEngine.js. ALN-01: el nombre canonico es
// EXPIRATION_MS; MS_EXPIRACION se conserva como alias legacy porque
// securityEngine.js lo menciona historicamente (nunca debe usarse).
export const JWT = Object.freeze({
  ALGORITHM: "HS256",
  EXPIRATION_MS: 3600000, // 1 hora
  MS_EXPIRACION: 3600000, // alias legacy (no usar)
});

// Timeout de busqueda de slots (espejo fiel de public/mmUtils.js SLOT_SEARCH,
// BIBLIA 3.2; MINUTOS_TOLERANCIA citado literalmente por bookingCore.js).
export const SLOT_SEARCH = Object.freeze({
  DIAS_LIMITE: 14,
  MINUTOS_TOLERANCIA: 120,
  MINUTOS_MAX_HUECO_DUAL: 120,
});

// Parametros de concurrencia/transaccion (bookingCore.js BCORE-*, crons.js).
export const CONCURRENCY = Object.freeze({
  DEFAULT_DURATION_MIN: 60,
  MS_LATIDO: 15000,
  MS_TTL_MUTEX: 300000,
  TRANSACTION_LEASE_MS: 300000,
  TRANSACTION_MAX_WAIT_MS: 3000,
  TRANSACTION_POLL_BASE_MS: 250,
});

// Singleton ids de caja (cajas.web.js ALN-04, eventLog.js).
export const SINGLETONS = Object.freeze({
  CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
  CAJA_SEQ: "CAJA_SEQ",
});

// Enum de estados de caja. ALN-05: los miembros canonicos v12 son
// ABIERTA/CERRADA; OPEN/CLOSED se conservan como alias legacy.
export const CASH_REGISTER_STATUS = Object.freeze({
  ABIERTA: "ABIERTA",
  CERRADA: "CERRADA",
  OPEN: "ABIERTA",
  CLOSED: "CERRADA",
});

// Tipos de cita internos (ledger CitasF2). CERO-ALIAS v13.0: el dominio de
// persistencia CitasF2 usa EXACTAMENTE el mismo vocabulario canonico que el
// plano interno PAYMENT_STATUS/BOOKING_STATUS (ingles, mayusculas, sin
// traducciones es). Mapear dos enums distintos sobre la misma coleccion era
// una divergencia SSOT real: bookingCore escribia PENDING/NOT_PAID mientras
// las proyecciones leian ESPANOL -> filas invisibles para cualquier guard.
// Ahora hay UN solo estado canonicoy _toCms* son identity-safe.
export const CITAS_BOOKING_STATUS = Object.freeze({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  NO_SHOW: "NO_SHOW",
});

export const CITAS_PAYMENT_STATUS = Object.freeze({
  NOT_PAID: "NOT_PAID",
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PENDING_LEDGER: "PENDING_LEDGER",
  PAID: "PAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  EXEMPT: "EXEMPT",
  UNDEFINED: "UNDEFINED",
});

// Tipo de booking (SIMPLE / DUAL F1 / DUAL F2). canonical segun
// unit.testRunner: Object.values(BOOKING_TYPE) = SIMPLE/DUALF1/DUALF2.
export const BOOKING_TYPE = Object.freeze({
  SIMPLE: "SIMPLE",
  DUALF1: "DUALF1",
  DUALF2: "DUALF2",
});

export function normalizeBookingType(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  if (s === "DUAL_F1" || s === "DUAL-F1") return BOOKING_TYPE.DUALF1;
  if (s === "DUAL_F2" || s === "DUAL-F2") return BOOKING_TYPE.DUALF2;
  if (s === BOOKING_TYPE.DUALF1 || s === BOOKING_TYPE.DUALF2 || s === BOOKING_TYPE.SIMPLE) {
    return s;
  }
  return s || BOOKING_TYPE.SIMPLE;
}

export function isDualBookingType(value) {
  const t = normalizeBookingType(value);
  return t === BOOKING_TYPE.DUALF1 || t === BOOKING_TYPE.DUALF2;
}

// Canal de origen de la operacion (events.js, validaciones).
export const CHANNEL_TYPE = Object.freeze({
  ONLINE: "ONLINE",
  PRESENCIAL: "PRESENCIAL",
});

// Metodos de pago del ledger. Miembros EFECTIVO/TARJETA/BIZUM verificados en
// site.flows.e2e (paymentMethod 'EFECTIVO'); TRANSFERENCIA admitido por el
// runner legado; WIX_PAYMENTS por citasManager ALN-06/CM5-05.
// FASE1-P0 (CAJA-01 SSOT): alias legacy "ONLINE" ERRADICADO del enum. El canon
// de pago online es WIX_PAYMENTS; la frontera de escritura (cajas.web) traduce
// "ONLINE" -> WIX_PAYMENTS para payloads/crons legacy, y el canal "ONLINE"
// sigue existiendo como dato dimensional en CHANNEL_TYPE (no es metodo de pago).
export const PAYMENT_METHOD = Object.freeze({
  EFECTIVO: "EFECTIVO",
  TARJETA: "TARJETA",
  BIZUM: "BIZUM",
  TRANSFERENCIA: "TRANSFERENCIA",
  WIX_PAYMENTS: "WIX_PAYMENTS",
  TARJETA_REGALO: "TARJETA_REGALO",
});

// Tipos de movimiento del ledger de caja (cajas.web.js). Default historico:
// "VENTA" (cajas.web.js L544).
export const MOVEMENT_TYPE = Object.freeze({
  VENTA: "VENTA",
  VENTA_ONLINE: "VENTA_ONLINE",
  VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
  CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
  ANTICIPO: "ANTICIPO",
  REEMBOLSO: "REEMBOLSO",
  DEVOLUCION: "DEVOLUCION",
  DEVOLUCION_SERVICIO: "DEVOLUCION_SERVICIO",
  PROPINA: "PROPINA",
  AJUSTE: "AJUSTE",
});

// Tipos de movimiento de inventario (inventario.web.js, validation.js).
export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
  ENTRADA: "ENTRADA",
  SALIDA: "SALIDA",
  COMPRA: "COMPRA",
  VENTA: "VENTA",
  MERMA: "MERMA",
  AJUSTE: "AJUSTE",
  DEVOLUCION: "DEVOLUCION",
});

// Signo de magnitudes (validation.js expectedInventoryMagnitude).
export const MAGNITUDE = Object.freeze({
  POSITIVE: "POSITIVE",
  NEGATIVE: "NEGATIVE",
  NEUTRAL: "NEUTRAL",
});

// Estados del registro de control operativo (ControlOperativo, ADR-05).
export const CONTROL_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  OPEN: "OPEN",
  EXECUTED: "EXECUTED",
  COMPLETED: "COMPLETED",
  CLOSED: "CLOSED",
  RESOLVED: "RESOLVED",
  FAILED: "FAILED",
});

// Tipos de registro de ControlOperativo (colecciones absorbidas FASE3).
// SSOT v13.0 (2026-10-19): se erradican los miembros sin productores activos
// verificados por grep en codigo fuente:
//   - RATE_LIMIT: seguridad vive en memoria de security.js, nunca en CMS.
//   - DEDUPE_KEY: deduplicacion real usa los tipos especificos (IDEMPOTENCY,
//     WEBHOOK_EVENT, COMPENSATION...), no un subtipo generico.
//   - BOOKING_TX: retirado previamente (sin productores ni consumidores).
// DISPLAY_TOKEN se conserva: tiene productor/consumidor activo en
// reservas.web.js (tokens de visualizacion efimeros de reserva).
// El contrato canonico queda alineado con controlOperativo.hooks.test.mjs.
export const CONTROL_TYPE = Object.freeze({
  ALERT: "ALERT",
  COMPENSATION: "COMPENSATION",
  DAYS_CACHE: "DAYS_CACHE",
  DISPLAY_TOKEN: "DISPLAY_TOKEN",
  DUAL_CACHE: "DUAL_CACHE",
  IDEMPOTENCY: "IDEMPOTENCY",
  SLOT_LOCK: "SLOT_LOCK",
  SYSTEM_FLAG: "SYSTEM_FLAG",
  WEBHOOK_EVENT: "WEBHOOK_EVENT",
});

// Estados de proyeccion del log fiscal (eventLog.js).
export const PROJECTION_STATUS = Object.freeze({
  OK: "OK",
  ERROR: "ERROR",
  PENDIENTE: "PENDIENTE",
});

// Tipos de evento del log fiscal (eventLog.js, events.js).
export const EVENT_TYPE = Object.freeze({
  VENTA_LINEA: "VENTA_LINEA",
  COMPRA_LINEA: "COMPRA_LINEA",
  RECTIFICATIVA: "RECTIFICATIVA",
  AJUSTE: "AJUSTE",
  MOV_STOCK: "MOV_STOCK",
  CIERRE_Z: "CIERRE_Z",
});

// Rol fiscal del tercero (Veri*factu).
export const FISCAL_ROLE = Object.freeze({
  EMISOR: "EMISOR",
  RECEPTOR: "RECEPTOR",
});

// Tipos de tercero.
export const THIRD_PARTY_TYPE = Object.freeze({
  CLIENTE: "CLIENTE",
  STAFF: "STAFF",
  PROVEEDOR: "PROVEEDOR",
});

// Tipos de factura SII (events.js usa F1/F2/R1; audit.e2e admite serie completa).
export const TIPO_FACTURA = Object.freeze({
  F1: "F1",
  F2: "F2",
  F3: "F3",
  R1: "R1",
  R2: "R2",
  R3: "R3",
  R4: "R4",
  R5: "R5",
});

// Tipos de compensacion del saga (bookingSaga.js).
export const COMPENSATION_KIND = Object.freeze({
  CANCEL_BOOKING: "CANCEL_BOOKING",
});

export const COMPENSATION_STATUS = Object.freeze({
  PENDING: "PENDING",
  EXECUTED: "EXECUTED",
  FAILED: "FAILED",
});

// Motivos de correccion contable (events.js).
export const CORRECTION_REASON = Object.freeze({
  NUMERO_SERIE: "NUMERO_SERIE",
  OTRAS: "OTRAS",
});

// Tipos de fichaje (horario.web.js, validation.js).
export const CLOCK_EVENT_TYPE = Object.freeze({
  ENTRADA: "ENTRADA",
  SALIDA: "SALIDA",
  PAUSA_INICIO: "PAUSA_INICIO",
  PAUSA_FIN: "PAUSA_FIN",
});

export const CLOCK_REGISTERED_BY = Object.freeze({
  SELF: "SELF",
  MANAGER: "MANAGER",
});

// Tipos de registro horario (horario.web.js).
export const RECORD_TYPE_HORARIOS = Object.freeze({
  REGULAR: "REGULAR",
  AJUSTE: "AJUSTE",
});

// Nombres de campos de RegistrosHorariosStaff (horario.web.js F.*).
export const REGISTROS_HORARIOS_FIELDS = Object.freeze({
  RESOURCE_ID: "resourceId",
  MEMBER_ID: "memberId",
  STAFF_NAME: "staffName",
  RECORDED_AT: "recordedAt",
  RECORDED_TIME: "recordedTime",
  DAY_KEY: "dayKey",
  MONTH_KEY: "monthKey",
  CLOCK_EVENT_TYPE: "clockEventType",
  RECORD_TYPE: "recordType",
  REGISTERED_BY: "registeredBy",
  REGISTERED_BY_MEMBER_ID: "registeredByMemberId",
  ADJUSTMENT_REASON: "adjustmentReason",
  DEVICE_IP_ADDRESS: "deviceIpAddress",
  META: "meta",
  TRACE_ID: "traceId",
  SIGNATURE: "signature",
});

// Campos logicos de booking normalizados (bookingCore.js / bookingSaga.js /
// citasManager.web.js / events.js).
export const BOOKING_FIELDS = Object.freeze({
  BOOKING_ID: "bookingId",
  BOOKING_TYPE: "bookingType",
  CATALOG_ID: "catalogId",
  CONTACT_DETAILS: "contactDetails",
  DATE_YMD: "dateYmd",
  END_DATE: "endDate",
  META: "meta",
  PAIR_TOKEN: "pairToken",
  PAYMENT_STATUS: "paymentStatus",
  RESOURCE_ID: "resourceId",
  REVISION: "revision",
  SCHEDULE_ID: "scheduleId",
  SERVICE_ID: "serviceId",
  SLOT_END: "slotEnd",
  SLOT_START: "slotStart",
  STAFF_RESOURCE_ID: "staffResourceId",
  START_DATE: "startDate",
  STATUS: "status",
  THIRD_PARTY_ID: "thirdPartyId",
  TOTAL_AMOUNT: "totalAmount",
  TRACE_ID: "traceId",
  X: "x",
});

// Cuentas contables minimas usadas por contabilidad.js (PGC espanol).
export const ACCOUNTING_ACCOUNT = Object.freeze({
  CASH: "410",
  BANKS: "570",
  SUPPLIERS: "400",
  SERVICE_REVENUE: "705",
  VAT_OUTPUT: "477",
  VAT_INPUT: "472",
});

// Tipos impositivos IVA Espana (rigor fiscal Ley 28/2014 RDL).
export const IVA_RATES = Object.freeze({
  GENERAL: 0.21,
  REDUCIDO: 0.10,
  SUPERREDUCIDO: 0.04,
  CERO: 0,
});

// Patron GUID canonico (VAL-R3-05: SSOT unico, validation.js/staff.js).
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidGuid(value) {
  return typeof value === "string" && GUID_REGEX.test(value.trim());
}

export function buildInvoiceNumber(year, month, sequenceNumber) {
  const seq = String(sequenceNumber).padStart(4, "0");
  return `${year}${month}-${seq}`;
}
