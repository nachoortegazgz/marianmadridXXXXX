/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v12.0-SSOT-FINAL
BASE: v11.0-SSOT-CLEAN + eliminacion destructiva de aliases, legacy,
      datos hardcodeados y feature flags sin consumidor.
RESPONSIBILITY: SSOT de constantes backend. Unico lugar donde se declaran
  nombres de colecciones, IDs canonicos, enums de negocio y configuracion
  del SDK. Todo el ecosistema importa desde aqui.
STANDARDS: G10 ASCII Strict. Cero aliases. Cero legacy. Cero codigo
  especulativo sin consumidor verificado (BIBLIA 0.3).
ELIMINADO v12.0:
  - COLLECTIONS alias (todos los consumidores usan BUSINESS_COLLECTIONS)
  - TIMECLOCK_TYPE alias (horario.web.js usa CLOCK_EVENT_TYPE directo)
  - LEGACY_BOOKING_STATUS_VALUES (cero consumidores)
  - LEGACY_PAYMENT_METHOD_TRANSLATION (cajas.web.js v5010 inline-a traduccion)
  - INACTIVE_BOOKING_STATUSES (cero consumidores)
  - STAFF.IDS / STAFF.RESOURCE_TO_DISPLAY (datos hardcodeados; staff.js
    construye cache desde MapaStaff)
  - MAPA_STAFF_FIELDS (migrado a literales en staff.js/security.js)
  - STAFF_ACCESS (migrado a constantes locales en staff.js/security.js/
    security.web.js)
  - SDK_CONFIG.M365 / ACCOUNTING / SYNC_BOOKINGS_SERVICES_ENABLED
    (feature flags sin consumidor)
  - CATALOG_STATES.ACTIVO (data.js no valida status de catalogos;
    ADR pendiente Biblia 6.4)
ANADIDO v12.0:
  - BOOKING_FIELDS completo (24 campos CitasF2 KEY FIELDS)
  - STAFF_DEFAULT_NAME (centralizado desde reservas.web.js)
MANTENIDO (no es legacy):
  - THIRD_PARTY_TYPE: enum fiscal normativo activo (DatosFiscales.
    thirdPartyType). Consumido por eventLog.js y validation.js.
  - BOOKING_TYPE.DUALF1/DUALF2: claves sin guion (contrato codigo),
    valores con guion (contrato datos persistidos en CitasF2).
  - CONTROL_TYPE ampliado: DUAL_CACHE/DAYS_CACHE/ALERT/COMPENSATION.
  - MOVEMENT_TYPE ampliado: VENTA_ONLINE/REEMBOLSO/VENTA/ANTICIPO/
    PROPINA/VENTA_TARJETA_REGALO/CANJE_TARJETA_REGALO.
  - PAYMENT_METHOD.TARJETA_REGALO: flujo gift cards activo.
NOTA PARA validation.js: assertCitasF2 debe validar contra
  CITAS_BOOKING_STATUS y CITAS_PAYMENT_STATUS (enums CMS persistidos),
  NO contra BOOKING_STATUS/PAYMENT_STATUS (enums Wix nativos).
DEPENDENCIAS: Ninguna. Este modulo es hoja pura (leaf).
=============================================================================
*/

// =============================================================================
// BLOQUE 1 - COLECCIONES CMS (BIBLIA 5)
// =============================================================================
// Keys = nombre logico en mayusculas. Values = ID tecnico exacto del CMS
// (case-sensitive). Ningun modulo hardcodea strings de coleccion.

export const BUSINESS_COLLECTIONS = Object.freeze({
    DATOS_FISCALES: "DatosFiscales",
    CAJA_ACTUAL: "CajaActual",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    CITAS_F2: "CitasF2",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
    /* v12.1-SSOT (PEND-DAL): MapaStaff es coleccion MUERTA — staff.js v9 lee
     * exclusivamente de la Bookings Staff API. Unico consumidor restante:
     * test UNIT-STRUCT-01 (inventario de claves). No eliminar clave hasta
     * retirar el legacy en el editor Wix + drop de coleccion CMS. */
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    CONTROL_OPERATIVO: "ControlOperativo",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});

export const OPERATIONAL_COLLECTIONS = Object.freeze({
    CONTROL_OPERATIVO: "ControlOperativo",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});

// =============================================================================
// BLOQUE 2 - IDENTIFICADORES CANONICOS
// =============================================================================

/* IC-R3-04 (Biblia 0.3): SITE_ID ELIMINADO. Cero consumidores en el
 * grafo backend/pages/public. Si se necesita de nuevo, declararlo con su
 * consumidor real. */

export const API = Object.freeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
});

export const APP_IDS = Object.freeze({
    BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
    EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
    FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
    INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
    MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
    GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});

// Nombre visible por defecto cuando no se resuelve staff desde CMS/API.
// Centralizado aqui como SSOT. Antes duplicado en reservas.web.js.
export const STAFF_DEFAULT_NAME = "Marian Madrid";

// =============================================================================
// BLOQUE 3 - SDK CONFIG (BIBLIA 8)
// =============================================================================

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
    LOCATION_TYPES: Object.freeze({
        TIME_SLOTS: "BUSINESS",
        BOOKINGS_WRITER: "OWNER_BUSINESS",
    }),
    TIMEOUTS: Object.freeze({
        API_MS: 60000,
        BOOKING_CREATION_MS: 50000,
        DUAL_BOOKING_MS: 160000,
        CHECKOUT_MS: 80000,
        CMS_MS: 60000,
        WATCHDOG_MS: 180000,
        WEBHOOK_MS: 120000,
    }),
    CACHE: Object.freeze({
        SERVICES_TTL_MS: 600000,
        SLOTS_CACHE_TTL_MS: 120000,
        DUAL_CACHE_TTL_MS: 900000,
        STAFF_TTL_MS: 300000,
        MAX_ENTRIES: 100,
        DAYS_CACHE_VERSION: 1,
        AVAILABILITY_CACHE_TTL_MS: 600000,
    }),
    SECURITY: Object.freeze({
        SECRET_CACHE_TTL_MS: 300000,
        RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
        RATE_LIMIT_CACHE_MAX_ENTRIES: 5000,
    }),
    RATE_LIMIT: Object.freeze({
        MAX_REQUESTS: 10,
        WINDOW_MS: 10000,
        BOOKING_MAX_REQUESTS: 5,
        BOOKING_WINDOW_MS: 20000,
        AVAILABILITY_WINDOW_MS: 10000,
        AVAILABILITY_REQUESTER_MAX_REQUESTS: 10,
        AVAILABILITY_GLOBAL_MAX_REQUESTS: 120,
    }),
    JOBS: Object.freeze({
        TIMEOUT_MS: 60000,
        AUDIT_RETENTION_DAYS: 90,
        DELETE_BATCH_SIZE: 100,
        DELETE_MAX_PAGES: 10,
        DUAL_CACHE_CLEANUP_LIMIT: 100,
        FISCAL_RECOVERY_BATCH_SIZE: 25,
        HEALTH_CHECK_QUERY_LIMIT: 1000,
        FISCAL_DAILY_MAX_PAGES: 50,
    }),
    EVENTS: Object.freeze({
        RETRY_ATTEMPTS: 3,
        RETRY_BASE_BACKOFF_MS: 3000,
    }),
    EXTERNAL_HTTP: Object.freeze({
        RATE_LIMIT_MAX_REQUESTS: 20,
        RATE_LIMIT_WINDOW_MS: 10000,
        HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
        CORS_ALLOWED_ORIGINS: Object.freeze([
            "https://www.marianmadrid.es",
            "https://marianmadrid.es",
        ]),
    }),
    DOCUMENTS: Object.freeze({
        DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
        MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
        MAX_EMAIL_SEND_ATTEMPTS: 3,
    }),
});

// =============================================================================
// BLOQUE 4 - SINGLETONS
// =============================================================================

export const SINGLETONS = Object.freeze({
    CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
    CAJA_SEQ: "CAJA_SEQ",
    CONFIG_SISTEMA_FISCAL: "CONFIG_SISTEMA_FISCAL",
});

// =============================================================================
// BLOQUE 5 - CONCURRENCIA (BIBLIA 3.2.1)
// =============================================================================

export const CONCURRENCY = Object.freeze({
    MS_TTL_MUTEX: 300000,
    MS_LATIDO: 15000,
    MS_TTL_MUTEX_ASIENTO: 60000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 6 - SLOT SEARCH (BIBLIA 3.2.1)
// =============================================================================

export const SLOT_SEARCH = Object.freeze({
    MINUTOS_TOLERANCIA: 120,
    MINUTOS_MAX_HUECO_DUAL: 120,
});

// =============================================================================
// BLOQUE 7 - ENUMS WIX NATIVOS (BIBLIA 6.1)
// =============================================================================
// Valores que devuelve la API de Wix Bookings V2. Se preservan en ingles.
// NO se persisten en el CMS. La traduccion a enum CMS ocurre en
// bookingCore._toCmsBookingStatus / _toCmsPaymentStatus.

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

export const PAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT",
});

// =============================================================================
// BLOQUE 8 - ENUMS CMS (BIBLIA 6.2)
// =============================================================================
// Valores persistidos en CitasF2. Coinciden exactamente con CMS KEY FIELDS.
// NOTA: assertCitasF2 en validation.js debe usar estos enums, NO los
// enums Wix nativos del BLOQUE 7.

export const CITAS_BOOKING_STATUS = Object.freeze({
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    NO_SHOW: "NO_SHOW",
});

export const CITAS_PAYMENT_STATUS = Object.freeze({
    UNPAID: "UNPAID",
    PARTIAL: "PARTIAL",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
});

// =============================================================================
// BLOQUE 9 - ENUMS DE NEGOCIO (BIBLIA 6.3)
// =============================================================================

export const MOVEMENT_TYPE = Object.freeze({
    COBRO: "COBRO",
    DEVOLUCION: "DEVOLUCION",
    APORTACION: "APORTACION",
    RETIRO: "RETIRO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    AJUSTE: "AJUSTE",
    VENTA_ONLINE: "VENTA_ONLINE",
    REEMBOLSO: "REEMBOLSO",
    VENTA: "VENTA",
    ANTICIPO: "ANTICIPO",
    PROPINA: "PROPINA",
    VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
    CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
});

export const CHANNEL_TYPE = Object.freeze({
    PRESENCIAL: "PRESENCIAL",
    ONLINE: "ONLINE",
});

export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    TRANSFERENCIA: "TRANSFERENCIA",
    WIX_PAYMENTS: "WIX_PAYMENTS",
    OTRO: "OTRO",
    TARJETA_REGALO: "TARJETA_REGALO",
});

export const TIPO_IMPOSITIVO_VALIDOS = Object.freeze([0, 0.04, 0.10, 0.21]);

export const CLOCK_EVENT_TYPE = Object.freeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
    PAUSA_INICIO: "PAUSA_INICIO",
    PAUSA_FIN: "PAUSA_FIN",
    AJUSTE: "AJUSTE",
});

export const RECORD_TYPE_HORARIOS = Object.freeze({
    REGULAR: "REGULAR",
    AJUSTE: "AJUSTE",
});

export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
    VENTA: "VENTA",
    DEVOLUCION: "DEVOLUCION",
    AJUSTE: "AJUSTE",
    ENTRADA_STOCK: "ENTRADA_STOCK",
    SALIDA_STOCK: "SALIDA_STOCK",
    TRANSFERENCIA: "TRANSFERENCIA",
});

export const ROL_BOOKINGS = Object.freeze({
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    RECEPTIONIST: "RECEPTIONIST",
    STAFF: "STAFF",
});

export const ROL_WEBSITE = Object.freeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA",
});

export const CONTROL_TYPE = Object.freeze({
    SLOT_LOCK: "SLOT_LOCK",
    WEBHOOK_EVENT: "WEBHOOK_EVENT",
    DEDUPE_KEY: "DEDUPE_KEY",
    IDEMPOTENCY: "IDEMPOTENCY",
    RATE_LIMIT: "RATE_LIMIT",
    SYSTEM_FLAG: "SYSTEM_FLAG",
    ALERT: "ALERT",
    COMPENSATION: "COMPENSATION",
    DUAL_CACHE: "DUAL_CACHE",
    DAYS_CACHE: "DAYS_CACHE",
});

export const CONTROL_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    COMPLETED: "COMPLETED",
    EXPIRED: "EXPIRED",
    PENDING: "PENDING",
    EXECUTED: "EXECUTED",
    FAILED: "FAILED",
    CLOSED: "CLOSED",
    BLOCKED: "BLOCKED",
});

export const COMPENSATION_KIND = Object.freeze({
    CANCEL_BOOKING: "CANCEL_BOOKING",
    REFUND_PAYMENT: "REFUND_PAYMENT",
});

export const COMPENSATION_STATUS = Object.freeze({
    PENDING: "PENDING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
});

// =============================================================================
// BLOQUE 10 - ENUMS FISCALES (VeriFactu RD 1007/2023)
// =============================================================================

export const RECORD_TYPE = Object.freeze({
    TERCERO: "TERCERO",
    CONFIG_SISTEMA: "CONFIG_SISTEMA",
});

// THIRD_PARTY_TYPE: enum fiscal normativo activo. NO es legacy.
// Consumido por validation.js (assertDatosFiscales) y eventLog.js.
// DatosFiscales.thirdPartyType es campo real del CMS (KEY FIELDS).
export const THIRD_PARTY_TYPE = Object.freeze({
    CLIENTE: "CLIENTE",
    PROVEEDOR: "PROVEEDOR",
    STAFF: "STAFF",
    AAPP: "AAPP",
    MIXTO: "MIXTO",
    EMISOR: "EMISOR",
});

export const FISCAL_ROLE = Object.freeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR",
});

export const CASH_REGISTER_STATUS = Object.freeze({
    ABIERTA: "ABIERTA",
    CERRADA: "CERRADA",
});

export const TIPO_FACTURA = Object.freeze({
    F1: "F1",
    F2: "F2",
    F3: "F3",
    R1: "R1",
    R2: "R2",
    R3: "R3",
    R4: "R4",
    R5: "R5",
    LC: "LC",
});

export const VAT_ACCRUAL_STATUS = Object.freeze({
    DEVENGADO: "DEVENGADO",
    ANTICIPADO: "ANTICIPADO",
    APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
});

export const IVA_RATES = Object.freeze({
    GENERAL: 0.21,
    REDUCIDO: 0.10,
    SUPERREDUCIDO: 0.04,
    CERO: 0,
    /* R2: IGIC eliminado (negocio en Zaragoza; no esta en
     * TIPO_IMPOSITIVO_VALIDOS ni tiene consumidor verificado). */
});

export const CORRECTION_REASON = Object.freeze({
    DESCUENTO_O_MARGEN: "01",
    ELEMENTOS_SEGURIDAD: "02",
    CAMBIOS_BASE_IMPONIBLE: "03",
    CUOTA_ERRONEA: "04",
    EXENTA_NO_SUJETA_REPETIDA: "05",
    SIMPLIFICADA_REPETIDA: "06",
    OTRAS: "07",
});

// =============================================================================
// BLOQUE 11 - BOOKING TYPE (BIBLIA 6.3 + ADR-17)
// =============================================================================
// Claves canonicas SIN guion bajo (contrato de codigo).
// Valores CON guion bajo (contrato de datos persistidos en CitasF2).
// normalizeBookingType() acepta ambas grafias como entrada y canoniza
// al valor CMS. isDualBookingType() compara contra valores.

export const BOOKING_TYPE = Object.freeze({
    SIMPLE: "SIMPLE",
    DUALF1: "DUAL_F1",
    DUALF2: "DUAL_F2",
});

// =============================================================================
// BLOQUE 12 - CAMPOS FISICOS DE CITAS_F2 (CMS KEY FIELDS)
// =============================================================================
// Mapa completo de las 24 keys fisicas reales segun extracto CMS KEY FIELDS.
// Usar BOOKING_FIELDS.X en lugar de literales string en todo el backend.

export const BOOKING_FIELDS = Object.freeze({
    BOOKING_ID: "bookingId",
    /* P2/F-10: META anadido. CitasF2 KEY FIELDS confirma meta/meta;
     * bookingSaga escribe pairTokenSource, f1Start/f2End, channelType,
     * writerRevision y addOnIds dentro de meta. */
    META: "meta",
    PAIR_TOKEN: "pairToken",
    CATALOG_ID: "catalogId",
    SERVICE_ID: "serviceId",
    SCHEDULE_ID: "scheduleId",
    RESOURCE_ID: "resourceId",
    STAFF_RESOURCE_ID: "staffResourceId",
    THIRD_PARTY_ID: "thirdPartyId",
    CASH_MOVEMENT_ID: "cashMovementId",
    DATE_YMD: "dateYmd",
    SLOT_START: "slotStart",
    SLOT_END: "slotEnd",
    START_DATE: "startDate",
    END_DATE: "endDate",
    BOOKING_TYPE: "bookingType",
    STATUS: "bookingStatus",
    PAYMENT_STATUS: "paymentStatus",
    TOTAL_AMOUNT: "totalAmount",
    CONTACT_DETAILS: "contactDetails",
    FISCAL_DATA: "fiscalData",
    INVOICING_DATE: "invoicingDate",
    SOURCE_EVENT_ID: "sourceEventId",
    REVISION: "revision",
    TRACE_ID: "traceId",
});

// =============================================================================
// BLOQUE 13 - CATALOG STATES (BIBLIA 6.4)
// =============================================================================
// ACTIVO eliminado: no existe en CMS KEY FIELDS de ServiciosCatalogo.
// data.js no tiene hooks de catalogo que validen status.
// Pendiente ADR formal antes de activar validacion en hooks.

export const CATALOG_STATES = Object.freeze({
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
    ARCHIVED: "ARCHIVED",
});

// =============================================================================
// BLOQUE 14 - INTEGRIDAD
// =============================================================================

export const INTEGRITY = Object.freeze({
    LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL",
});

// =============================================================================
// BLOQUE 15 - JWT (parametros no sensibles)
// =============================================================================
// El material secreto vive en @wix/secrets (SECRETS.AUTH_JWT_KEY).
// Consumidor: securityEngine.js.

export const JWT = Object.freeze({
    ALGORITHM: "HS256",
    EXPIRATION_MS: 900000,
    ISSUER: "marianmadrid-backend",
});

// =============================================================================
// BLOQUE 16 - COLECCIONES RESERVADAS Y PROHIBIDAS
// =============================================================================

export const RESERVED_COLLECTIONS = Object.freeze([
    "Bookings",
    "Services",
    "AvailabilityPlans",
    "ConnectedApps",
]);

export const FORBIDDEN_COLLECTIONS = Object.freeze([
    "CategoriasServicio",
    "LibroRegistroFacturasExpedidas",
    "ConfiguracionFiscal",
    "AsientosContables",
    "FacturasRecibidas",
    "SlotLocks",
    "ProcessedWebhookEvents",
    "BookingTransactions",
]);

// =============================================================================
// BLOQUE 17 - PLAN CONTABLE (PGC Espanol)
// =============================================================================

export const ACCOUNTING_ACCOUNT = Object.freeze({
    CASH: "570000",
    BANKS: "572000",
    CLIENTS: "430000",
    SUPPLIERS: "400000",
    SERVICE_REVENUE: "705000",
    ADDON_REVENUE: "754000",
    VAT_OUTPUT: "477000",
    VAT_INPUT: "472000",
    REFUNDS: "708000",
});

// =============================================================================
// BLOQUE 18 - PREFIJOS VAT UE
// =============================================================================
/* R2/DUP-06: EU_VAT_PREFIXES ELIMINADO. La validacion de prefijos VAT-UE
 * vive en validation.js (mapa regex por pais, unico consumidor real).
 * Lista plana sin consumidores verificados (Biblia 0.3). */

// =============================================================================
// BLOQUE 19 - INVENTARIO
// =============================================================================

export const ITEM_NATURE = Object.freeze({
    SERVICIO: "SERVICIO",
    PRODUCTO: "PRODUCTO",
});

export const CODIGO_IMPUESTO = Object.freeze({
    IVA: "IVA",
    EXENTO: "EXENTO",
});

export const MAGNITUDE = Object.freeze({
    POSITIVE: "POSITIVE",
    NEGATIVE: "NEGATIVE",
    NEUTRAL: "NEUTRAL",
});

export const POSITIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    INVENTORY_MOVEMENT_TYPE.DEVOLUCION,
]);

export const NEGATIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.VENTA,
    INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
]);

// =============================================================================
// BLOQUE 20 - EVENTOS ECONOMICOS (contrato eventLog)
// =============================================================================

export const EVENT_TYPE = Object.freeze({
    VENTA_LINEA: "VENTA_LINEA",
    RECTIFICATIVA: "RECTIFICATIVA",
    AJUSTE: "AJUSTE",
    COMPRA_LINEA: "COMPRA_LINEA",
    MOV_STOCK: "MOV_STOCK",
    CIERRE_Z: "CIERRE_Z",
});

// =============================================================================
// BLOQUE 21 - HORARIOS STAFF
// =============================================================================

export const CLOCK_REGISTERED_BY = Object.freeze({
    SELF: "SELF",
    MANAGER: "MANAGER",
});

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

// =============================================================================
// BLOQUE 22 - CONTABILIDAD
// =============================================================================

export const PROJECTION_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    OK: "OK",
    ERROR: "ERROR",
});

export const ENTRY_STATUS = Object.freeze({
    BORRADOR: "BORRADOR",
    PENDIENTE: "PENDIENTE",
    APROBADO: "APROBADO",
    RECHAZADO: "RECHAZADO",
    ASIENTADO: "ASIENTADO",
    CANCELADO: "CANCELADO",
});

export const ACCOUNT_NATURE = Object.freeze({
    DEUDORA: "DEUDORA",
    ACREEDORA: "ACREEDORA",
});

// =============================================================================
// BLOQUE 23 - SISTEMA VERIFACTU
// =============================================================================

export const COMPUTER_SYSTEM = Object.freeze({
    nombre: "Wix Bookings - Marian Madrid CMS",
    version: "v5013-CMS-FINAL",
    getSecretKey: "VERIFACTU_COMPUTER_SYSTEM_JSON",
});

// =============================================================================
// BLOQUE 24 - HELPERS DE ENUM
// =============================================================================

/**
 * Canoniza cualquier grafia de bookingType al valor persistido en CitasF2.
 * Acepta: NORMAL, SIMPLE, DUAL, DUAL_F1, DUALF1, F1, DUAL_F2, DUALF2, F2.
 */
export function normalizeBookingType(value) {
    const v = String(value ?? "").trim().toUpperCase();
    if (v === "NORMAL" || v === "SIMPLE") return BOOKING_TYPE.SIMPLE;
    if (v === "DUAL" || v === "DUAL_F1" || v === "DUALF1" || v === "F1") {
        return BOOKING_TYPE.DUALF1;
    }
    if (v === "DUAL_F2" || v === "DUALF2" || v === "F2") {
        return BOOKING_TYPE.DUALF2;
    }
    return v;
}

export function isDualBookingType(value) {
    return value === BOOKING_TYPE.DUALF1 || value === BOOKING_TYPE.DUALF2;
}

export function isValidGuid(value) {
    const v = String(value ?? "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
