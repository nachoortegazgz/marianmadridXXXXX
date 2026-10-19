/*
=============================================================================
MODULE: backend/mmSecrets.js
VERSION: v5015-ALIGNED
BASE: v5009-FISCAL-V20.1 + verificacion contra internalConfig v12.0 y
      consumidores de v5015 (cajas.web, eventLog, securityEngine,
      fiscalDocuments, events, audit).
RESPONSIBILITY: Nombres canonicos de secretos Wix.
STANDARDS: G10 ASCII Strict.

CAMBIOS DE ALINEACION v5015-ALIGNED:
  ALN-01: Sin cambios funcionales respecto a v5009. Todos los nombres
          referenciados por los consumidores v5015 existen:
            - SECRETS.FISCAL_KEY (cajas.web, securityEngine, contabilidad)
            - SECRETS.FISCAL_NIF_EMISOR (cajas.web, events, fiscalAggregator)
            - SECRETS.FISCAL_SIGNER_ENDPOINT / _BEARER (cajas.web)
            - SECRETS.AUTH_JWT_KEY (securityEngine)
            - SECRETS.RESEND_API_KEY / _FROM_EMAIL (fiscalDocuments)
          Los secretos legacy (ADMIN_EMAILS, CAJERO_EMAILS) se mantienen
          declarados por compatibilidad con despliegues historicos; su
          consumidor v5015 es null (los roles viven en MapaStaff.rolWebsite).

CORRECTIONS (heredadas):
  [VF-01].
=============================================================================
*/

export const SECRETS = Object.freeze({
    // Fiscal (obligatorio Veri*factu)
    FISCAL_KEY: "SECRET_FISCALKEY",
    FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",

    // Firma X.509 delegada en microservicio externo
    FISCAL_SIGNER_ENDPOINT: "FISCAL_SIGNER_ENDPOINT",
    FISCAL_SIGNER_BEARER: "FISCAL_SIGNER_BEARER",

    // Autenticacion y roles
    AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",
    // Legacy: no consultados por v5015. Se conservan declarados por si
    // algun script de migracion los referencia explicitamente.
    ADMIN_EMAILS: "ADMIN_EMAILS",
    CAJERO_EMAILS: "CAJERO_EMAILS",

    // Automatizacion
    POWER_AUTOMATE: "POWER_AUTOMATE_TOKEN",

    // Email (SendGrid legacy + Resend actual)
    SENDGRID_API_KEY: "SENDGRID_API_KEY",
    SENDGRID_FROM_EMAIL: "SENDGRID_FROM_EMAIL",
    RESEND_API_KEY: "RESEND_API_KEY",
    RESEND_FROM_EMAIL: "RESEND_FROM_EMAIL",

    // Asistente IA
    MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",

    // Microsoft 365 Graph API
    M365_GRAPH_CLIENT_ID: "M365_CLIENT_ID",
    M365_GRAPH_CLIENT_SECRET: "M365_CLIENT_SECRET",
    M365_GRAPH_TENANT_ID: "M365_TENANT_ID",
    M365_GRAPH_SITE_ID: "M365_GRAPH_SITE_ID",
    M365_GRAPH_LIST_ID: "M365_LIST_ID",
    M365_WEBHOOK_HMAC_KEY: "SECRET_M365_WEBHOOK_HMAC_KEY",
});