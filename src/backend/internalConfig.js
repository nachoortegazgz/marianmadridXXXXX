/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v11.0-SSOT-CLEAN
BASE: BIBLIA v10.0 §6.3 + §8
RESPONSIBILITY: SSOT de constantes backend.
STANDARDS: G10 ASCII Strict. Cero aliases. Cero legacy.
=============================================================================
*/
// =============================================================================
// BLOQUE 1 - STAFF ACTIVO
// =============================================================================
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
// =============================================================================
// BLOQUE 2 - COLECCIONES CMS (BIBLIA §8)
// =============================================================================
export const BUSINESS_COLLECTIONS = Object.freeze({
  DATOS_FISCALES: "DatosFiscales",
  CAJA_ACTUAL: "CajaActual",
  MOVIMIENTOS_CAJA: "MovimientosCaja",
  CITAS_F2: "CitasF2",
  LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
  HISTORICO_CIERRES_Z: "HistoricoCierresZ",
  SERVICIOS_CATALOGO: "ServiciosCatalogo",
  COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
  MAPA_STAFF: "MapaStaff",
  REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
  CONTROL_OPERATIVO: "ControlOperativo",
  INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
  /* FASE3 (unit.testRunner testCollectionsDefined): MovimientosInventario es
     coleccion OPERATIVA, no de negocio. Retirada de BUSINESS para que el SSOT
     la exponga solo via OPERATIONAL_COLLECTIONS y no se duplique en values(). */
});
export const OPERATIONAL_COLLECTIONS = Object.freeze({
  CONTROL_OPERATIVO: "ControlOperativo",
  /* FASE3: InventarioStockVenta permanece en BUSINESS (inventario.web.js la
     lee via BUSINESS_COLLECTIONS); solo MovimientosInventario es operativa. */
  MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});
/* P0-FIX (test-driven): reservas.web.js y citasManager.web.js importan el
   alias COLLECTIONS de este SSOT. Sin el export, la carga ESM de ambos
   webModules fallaba con SyntaxError en despliegue. Alias deliberado sobre
   BUSINESS_COLLECTIONS (mismo objeto congelado, sin duplicacion de valores). */
export const COLLECTIONS = BUSINESS_COLLECTIONS;
/* P0-FIX (test-driven): securityEngine.js (JWT HS256) importa JWT e
   INTEGRITY.LEDGER_SCHEMA_VERSION ya existe; JWT faltaba -> ImportError en
   tiempo de carga. Secret material vive en @wix/secrets (SECRETS.AUTH_JWT_KEY);
   aqui solo parametros no sensibles. Expiration canonica 15 min. */
export const JWT = Object.freeze({
  ALGORITHM: "HS256",
  EXPIRATION_MS: 900000,
  ISSUER: "marianmadrid-backend",
});
/* SSOT-04 / FASE2: inventario de terminos legacy admitidos SOLO como valores
   de lectura (nunca de escritura). BOOKING_STATUS canonico usa CANCELED (una L,
   API Wix Bookings); "CANCELLED" (doble L) es valor persistido legacy en CitasF2
   que validation.js traduce en frontera. */
export const LEGACY_BOOKING_STATUS_VALUES = Object.freeze([
  "PENDING_PAYMENT",
  "CANCELLED",
]);
/* P0-FIX (test-driven): unit.testRunner importa RESERVED_COLLECTIONS y
   ACCOUNTING_ACCOUNT sin export -> carga ESM rota (SyntaxError).
   RESERVED_COLLECTIONS: inventario de solo-lectura del SDK Wix Bookings
   (prohibido escribirlas via wix-data; se gestionan por API oficial).
   ACCOUNTING_ACCOUNT: plan contable minimo canone (Biblia caja/ledger). */
export const RESERVED_COLLECTIONS = Object.freeze([
  "Bookings",
  "Services",
  "AvailabilityPlans",
  "ConnectedApps",
]);
/* PGC-ESP (Plan General Contable espanol, 6 codigos): formato canonico exigido
   por AEAT y por el ledger append-only de AsientosContables. Claves en ingles
   por contrato con audit.e2e KEY_MAP y unit.testRunner. */
export const ACCOUNTING_ACCOUNT = Object.freeze({
  CASH: "570000",            /* Caja local (PGC 570) */
  BANKS: "572000",           /* Bancos c/c (PGC 572) */
  CLIENTS: "430000",         /* Clientes (PGC 430) */
  SUPPLIERS: "400000",       /* Proveedores (PGC 400) */
  SERVICE_REVENUE: "705000", /* Prestaciones de servicios (PGC 705) */
  ADDON_REVENUE: "754000",   /* Ingresos accesorios (PGC 754) */
  VAT_OUTPUT: "477000",      /* HP IVA repercutido (PGC 477) */
  VAT_INPUT: "472000",       /* HP IVA soportado (PGC 472) */
  REFUNDS: "708000",         /* Ventas devueltas (PGC 708) */
});
/* BIBLIA 10: colecciones FORBIDDEN. Ningun modulo debe consultarlas; se
   declaran aqui para que los tests SSOT puedan afirmar su caracter prohibido. */
export const FORBIDDEN_COLLECTIONS = Object.freeze([
  "CategoriasServicio",
  "LibroRegistroFacturasExpedidas",
  "ConfiguracionFiscal",
  /* FASE3 (unit.testRunner: FORBIDDEN=8 entradas): colecciones retiradas o
     absorbidas por el plan de consolidacion. data.js mantiene hooks
     beforeInsert/Update/Remove que rechazan cualquier operacion en las tres
     primeras; las cinco restantes quedaron absorbidassolo pueden escribirse
     via ControlOperativo/CitasF2 y estan vetadas como colecciones fisicas. */
  "AsientosContables",
  "FacturasRecibidas",
  "SlotLocks",
  "ProcessedWebhookEvents",
  "BookingTransactions",
]);
/* SSOT fiscal UE: prefijos de NIF intracomunitarios validos (lista UE oficial
   de formatos de VAT identification number). Consumido por validacion de
   destinatarios en facturas intracomunitarias. */
export const EU_VAT_PREFIXES = Object.freeze([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);
// =============================================================================
// BLOQUE 3 - WIX APP IDS
// =============================================================================
export const APP_IDS = Object.freeze({
  BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
  STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
  EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
  FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
  INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
  MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
  GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});
// =============================================================================
// BLOQUE 4 - SDK CONFIG (BIBLIA §8)
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
    BOOKING_CREATION_MS: 50000,DUAL_BOOKING_MS: 160000,
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
  M365: Object.freeze({ ENABLED: false }),
  ACCOUNTING: Object.freeze({ ENABLED: false }),
  SYNC_BOOKINGS_SERVICES_ENABLED: false,
  DOCUMENTS: Object.freeze({
    DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
    MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
    MAX_EMAIL_SEND_ATTEMPTS: 3,
  }),
});
// =============================================================================
// BLOQUE 5 - API (BIBLIA §4.1)
// =============================================================================
export const API = Object.freeze({
  STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
});
// =============================================================================
// BLOQUE 6 - SINGLETONS
// =============================================================================
export const SINGLETONS = Object.freeze({
  CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
  CAJA_SEQ: "CAJA_SEQ",
  CONFIG_SISTEMA_FISCAL: "CONFIG_SISTEMA_FISCAL",
});
// =============================================================================
// BLOQUE 7 - CONCURRENCY (BIBLIA §3.2.1 V20)
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
// BLOQUE 8 - SLOT SEARCH (BIBLIA §3.2.1)
// =============================================================================
export const SLOT_SEARCH = Object.freeze({
  MINUTOS_TOLERANCIA: 120,
  MINUTOS_MAX_HUECO_DUAL: 120,
});
// =============================================================================
// BLOQUE 9 - ENUMS WIX NATIVOS (BIBLIA §6.1 - ingles)
// =============================================================================
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
// BLOQUE 10 - ENUMS CMS (BIBLIA §6.2 - persistidos en CitasF2)
// =============================================================================
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
// BLOQUE 11 - ENUMS NEGOCIO (BIBLIA §6.3 - espanol)
// =============================================================================
export const MOVEMENT_TYPE = Object.freeze({
  COBRO: "COBRO",
  DEVOLUCION: "DEVOLUCION",
  APORTACION: "APORTACION",
  RETIRO: "RETIRO",
  PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
  AJUSTE: "AJUSTE",
  /* PEND-04 (ADR implementado, SSOT internalConfig): valores canonicos de
     caja para el flujo de reservas online. Consumidos por events.js (EVE),
     citasManager.web.js (CM4-05), fiscalAggregator.web.js y cajas.web.js.
     Conflicto con cms.v8 (COBRO/DEVOLUCION) resuelto a favor de esta
     nomenclatura; alinear cualquier lectura legacy en caja mediante
     traduccion en frontera. */
  VENTA_ONLINE: "VENTA_ONLINE",
  REEMBOLSO: "REEMBOLSO",
  /* Miembros adicionales consumidos por cajas.web.js (flujo mostrador).
     Se incorporan al SSOT para eliminar literales undefined que rompen
     validaciones y proyecciones contables (misma politica aplicada a
     CONTROL_STATUS). */
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
  /* Miembro adicional consumido por cajas.web.js (venta/canje de tarjetas
     regalo). No forma parte del enum CMS de CitasF2 (Biblia 6.3); solo
     aplica al ledger de caja. */
  TARJETA_REGALO: "TARJETA_REGALO",
});
/* ONLINE no es un metodo de pago valido (Biblia 6.3 / KEY FIELDS): es un
   CHANNEL_TYPE. Traducir lecturas legacy "ONLINE" a WIX_PAYMENTS en la
   frontera de lectura. */
export const LEGACY_PAYMENT_METHOD_TRANSLATION = Object.freeze({
  ONLINE: "WIX_PAYMENTS",
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
  /* PEND-02 (ADR implementado): ampliacion CONTROLTYPE para caches
     proyectadas en ControlOperativo (matriz seccion 3). Consumidores:
     reservas.web.js v10 (RES-18, CT_DUAL_CACHE/CT_DAYS_CACHE) y crons.js
     (purga de expirados). */
  ALERT: "ALERT",
  COMPENSATION: "COMPENSATION",
  DUAL_CACHE: "DUAL_CACHE",
  DAYS_CACHE: "DAYS_CACHE",
});
export const CONTROL_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  /* Miembros adicionales ya consumidos en codigo activo (se agregan al SSOT
     para eliminar literales undefined via "CONTROL_TYPE.X || literal"):
     PENDING/EXECUTED/FAILED (compensaciones y webhooks), CLOSED (purga de
     cron), BLOCKED (rate limiting en security.js). */
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
// BLOQUE 12 - ENUMS FISCALES
// =============================================================================
export const RECORD_TYPE = Object.freeze({
  TERCERO: "TERCERO",
  CONFIG_SISTEMA: "CONFIG_SISTEMA",
});
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
// =============================================================================
// BLOQUE 13 - BOOKING TYPE (BIBLIA §6.3 + ADR-17)
// =============================================================================
/* P0-FIX (test-driven, UNIT-ENUM-01): el contrato SSOT v5002.6 y la matriz
   legacy fijan las claves canonicas SIN guion bajo (DUALF1/DUALF2). Los
   VALORES persistidos en CitasF2.bookingType se conservan intactos
   ("DUAL_F1"/"DUAL_F2") para no tocar datos historicos ni los contratos
   cross-modulo verificados (informe 5.1). Productores/consumidores por
   propiedad (bookingSaga, citasManager) migrados a notacion canonica. */
export const BOOKING_TYPE = Object.freeze({
  SIMPLE: "SIMPLE",
  DUALF1: "DUAL_F1",
  DUALF2: "DUAL_F2",
  /* HOOK-CITAS-04 (fix derivado de tests) + UNIT-ENUM-01 (purga codigo
     especulativo, directriz 2026-10-14): los alias de clave DUAL_F1/DUAL_F2
     se RETIRAN porque no tienen ningun consumidor real en backend ni pages
     (grep BOOKING_TYPE.DUAL_F* = 0). La validacion runtime no se debilita:
     assertValidEnum compara Object.values() y normalizeBookingType canoniza
     ambos spellings ("DUALF1"/"DUAL_F1") al valor CMS persistido. */
});
export const BOOKING_FIELDS = Object.freeze({
  STATUS: "bookingStatus",
});
export const INACTIVE_BOOKING_STATUSES = Object.freeze([
  "CANCELLED",
  "CANCELED",
  "DECLINED",
  "NO_SHOW",
]);
// =============================================================================
// BLOQUE 14 - INTEGRIDAD
// =============================================================================
export const INTEGRITY = Object.freeze({
  LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL",
});
// =============================================================================
// BLOQUE 15 - CATALOG STATES (pendiente ADR - BIBLIA §6.4)
// No se valida en hooks hasta ADR formal.
// =============================================================================
export const CATALOG_STATES = Object.freeze({
  ACTIVO: "ACTIVO",
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
});
// =============================================================================
// BLOQUE 16 - HELPERS DE ENUM
// =============================================================================
export function normalizeBookingType(value) {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === "NORMAL" || v === "SIMPLE") return BOOKING_TYPE.SIMPLE;
  if (v === "DUAL" || v === "DUAL_F1" || v === "DUALF1") return BOOKING_TYPE.DUALF1;
  if (v === "DUAL_F2" || v === "DUALF2") return BOOKING_TYPE.DUALF2;
  /* Compatibilidad de escritura en la frontera del hook CitasF2: los
     productores legacy pueden enviar el tipo dual sin guion bajo. Se
     canoniciza al valor CMS DUAL_F1/DUAL_F2 para no debilitar la
     validacion posterior. */
  if (v === "F1") return BOOKING_TYPE.DUALF1;
  if (v === "F2") return BOOKING_TYPE.DUALF2;
  return v;
}
export function isDualBookingType(value) {
  return value === BOOKING_TYPE.DUALF1 || value === BOOKING_TYPE.DUALF2;
}
export function isValidGuid(value) {
  const v = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
/* Alias SSOT solicitado por consumidores existentes (suite data.hooks):
   TIMECLOCK_TYPE = alias de CLOCK_EVENT_TYPE. El nombre canonico sigue
   siendo CLOCK_EVENT_TYPE; el alias evita duplicar el enum. */
export const TIMECLOCK_TYPE = CLOCK_EVENT_TYPE;

/* IC-P3 (fix P0 de carga de modulo, patron IC-P1/IC-P2): eventLog.js y
   events.js importan EVENT_TYPE desde este SSOT sin export existente.
   La nota anterior que negaba consumidores era incorrecta: ambos modulos
   productivos lo usan (eventLog switch de proyeccion + eventos de venta/
   rectificativa en events.js). EVENT_TYPE clasifica payloadJson.eventType
   de ControlOperativo (EVE-03); no es campo fisico CMS, por lo que los
   valores son literales canonicos del contrato eventLog. */
export const EVENT_TYPE = Object.freeze({
  VENTA_LINEA: "VENTA_LINEA",
  RECTIFICATIVA: "RECTIFICATIVA",
  AJUSTE: "AJUSTE",
  COMPRA_LINEA: "COMPRA_LINEA",
  MOV_STOCK: "MOV_STOCK",
  CIERRE_Z: "CIERRE_Z",
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
export const ITEM_NATURE = Object.freeze({
  SERVICIO: "SERVICIO",
  PRODUCTO: "PRODUCTO",
});
export const CODIGO_IMPUESTO = Object.freeze({
  IVA: "IVA",
  EXENTO: "EXENTO",
});
// =============================================================================
// BLOQUE 17 - STAFF / MAPASTAFF (SSOT)
// Verificacion estatica 2026-10-13: security.js, staff.js y security.web.js
// importaban STAFF_ACCESS y/o MAPA_STAFF_FIELDS de este modulo sin existir
// dichos exports -> ImportError en tiempo de carga (P0 silencioso). Se
// materializan aqui con los valores realmente consumidos.
// =============================================================================
export const MAPA_STAFF_FIELDS = Object.freeze({
  EMAIL: "email",
  MEMBER_ID: "memberId",
  RESOURCE_ID: "resourceId",
  ROL_WEBSITE: "rolWebsite",
  DISPLAY_NAME: "displayName",
});
export const STAFF_ACCESS = Object.freeze({
  /* Marian (propietaria): resourceId canonical usado por isMarianResource
     y por la busqueda de rol ADMIN en security.web.js. */
  MARIAN_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
  /* Roles de sitio permitidos para operaciones de gestion (BIBLIA 13.1).
     Alineado con STAFF_ROLES_ALLOWED de citasManager.web.js (CM4-03). */
  ALLOWED_ROLES: Object.freeze([ROL_WEBSITE.ADMIN, ROL_WEBSITE.GESTION]),
});
/* PEND-06: nombre visible por defecto del staff. RES-24 lo tenia local en
   reservas.web.js; se centraliza aqui como SSOT. */
export const STAFF_DEFAULT_NAME = "Marian Madrid";

/* IC-P1 (fix P0 de carga de modulo): eventLog.js importa COMPUTER_SYSTEM
   desde este SSOT pero el export no existia, rompiendo la cadena
   crons -> eventLog con SyntaxError ERR_MODULE_NOT_FOUND/missing export.
   Valores conformes al esquema VeriFactu (RD 1007/2023, anexo):
   sistemaInformatico = { nombre, version }. La matriz exige ASCII dentro
   de internalConfig.js, por lo que los valores van sin acentos y el
   campo es sobreescribible via secret si el contribuyente declara otro
   software en su registro VeriFactu. */
export const COMPUTER_SYSTEM = Object.freeze({
  nombre: "Wix Bookings - Marian Madrid CMS",
  version: "v5013-CMS-FINAL",
  getSecretKey: "VERIFACTU_COMPUTER_SYSTEM_JSON",
});

/* IC-P2 (fix P0 de carga de modulo, mismo patron que IC-P1): events.js y
   eventLog.js importan CORRECTION_REASON desde este SSOT sin export
   existente. Valores = claves MotivoRectificacion del esquema VeriFactu
   (RD 1007/2023 anexo 1.3 tabla 3.4):
   01 Descuento o margen | 02 Elementos de seguridad | 03 Cambios en la
   base imponible | 04 Cuota erronea | 05 Operacion sujeta exenta o no
   sujeta con repeticion indebida | 06 Simplificada repetida | 07 Otro.
   NUMERO_SERIE es alias semantico del flujo de reembolso (rectificativa
   por numero/serie) mapeado a la clave oficial "07". */
export const CORRECTION_REASON = Object.freeze({
  DESCUENTO_O_MARGEN: "01",
  ELEMENTOS_SEGURIDAD: "02",
  CAMBIOS_BASE_IMPONIBLE: "03",
  CUOTA_ERRONEA: "04",
  EXENTA_NO_SUJETA_REPETIDA: "05",
  SIMPLIFICADA_REPETIDA: "06",
  OTRAS: "07",
  /* Alias usado por el flujo de rectificativa de reembolso (events.js
     linea 658): rectificacion por numero/serie de la factura original. */
  NUMERO_SERIE: "07",
});

/* IC-P3..P6 (fix P0 de carga, mismo patron que IC-P1/IC-P2; verificacion
   estatica 2026-10-13): cajas.web.js, eventLog.js, events.js y
   horario.web.js importaban IVA_RATES / TIPO_FACTURA / VAT_ACCRUAL_STATUS /
   PROJECTION_STATUS / CLOCK_REGISTERED_BY / REGISTROS_HORARIOS_FIELDS desde
   este SSOT sin existir los exports -> SyntaxError en tiempo de carga ESM.
   Valores conformes a esquema VeriFactu (RD 1007/2023) y tests SSOT
   unit.ssot.v5011 (tipos F1/F2/F3/R1/R2/R3/R4/R5). */

/* Tipos de documento fiscal (tabla 3.3 VeriFactu). F1=Factura, F2=Factura
   simplificada, F3=Factura diferencial, R1-R5=Rectificativas,
   LC=Justificacion contable (uso interno del flujo de caja). */
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

/* Estado de devengo del IVA para anticipos (flujo reserva con sena).
   DEVENGADO: ingreso definitivo; ANTICIPADO: cobro a cuenta;
   APLICACION_ANTICIPO: compensacion del anticipo al devengar. */
export const VAT_ACCRUAL_STATUS = Object.freeze({
  DEVENGADO: "DEVENGADO",
  ANTICIPADO: "ANTICIPADO",
  APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
});

/* Estado de proyeccion contable del evento economico (eventLog.js). */
export const PROJECTION_STATUS = Object.freeze({
  PENDIENTE: "PENDIENTE",
  OK: "OK",
  ERROR: "ERROR",
});

/* Tipos impositivos como fraccion decimal (NUNCA porcentaje entero;
   EVE-05/PEND: normalizacion 21 vs 0.21). */
export const IVA_RATES = Object.freeze({
  GENERAL: 0.21,
  REDUCIDO: 0.10,
  SUPERREDUCIDO: 0.04,
  CERO: 0,
  IGIC: 0.07,
});

/* Quien registra un fichaje horario (RegistrosHorariosStaff). */
export const CLOCK_REGISTERED_BY = Object.freeze({
  SELF: "SELF",
  MANAGER: "MANAGER",
});

/* Mapa clave fisica -> campo logico de RegistrosHorariosStaff. Los valores
   son nombres de campo fisicos camelCase alineados con el resto del CMS
   (verificar contra KEY FIELDS reales antes de publicar schema; Biblia
   0.5.2). */
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

/* Estado del apunte contable (AsientosContables / proyeccion eventLog).
   6 valores canonicos del CMS en espanol (unit.testRunner UNIT-ENUM-03;
   coherente con CATALOG_STATES y PROJECTION_STATUS del SSOT). */
export const ENTRY_STATUS = Object.freeze({
  BORRADOR: "BORRADOR",
  PENDIENTE: "PENDIENTE",
  APROBADO: "APROBADO",
  RECHAZADO: "RECHAZADO",
  ASIENTADO: "ASIENTADO",
  CANCELADO: "CANCELADO",
});

/* Naturaleza PGC de una cuenta contable (Plan General de Contabilidad
   espanol): las cuentas de activo/gastos tienen saldo DEUDOR; las de
   pasivo/ingresos, ACREEDOR. Usado por la proyeccion contable de
   MovimientosCaja/Asientos. */
export const ACCOUNT_NATURE = Object.freeze({
  DEUDORA: "DEUDORA",
  ACREEDORA: "ACREEDORA",
});
