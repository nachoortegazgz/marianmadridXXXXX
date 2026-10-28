/*
MODULE: src/backend/fiscalDocuments.web.js
RESPONSIBILITY: Creates, lists and retrieves fiscal documents and manager reporting packages.
STATIC DEPENDENCIES: @wix/web-methods, backend/secretVault, backend/dataAccess, backend/internalConfig, backend/mmSecrets, backend/security, backend/responseUtils, backend/fiscalAggregator.web, public/mmUtils, backend/data
NAMED EXPORT DECLARATIONS DETECTED: previewManagerPackage, createManagerPackageVersion, getManagerPackageHistory, getPreparedManagerPackages, downloadManagerPackageVersion, emailManagerPackageVersion
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are omitted.
*/
import { webMethod, Permissions } from "@wix/web-methods";
import { getSecretValue } from "backend/secretVault";

import { queryItems, wql, saveItem as dalSave, getItem as dalGet } from "backend/dataAccess";

import { BUSINESS_COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { requireMarianManager } from "backend/security";
import { _toPublicError } from "backend/responseUtils";

import {
  getQuarterlyTaxSummary,
  getLibroRegistroFacturasExpedidasInternal,
} from "backend/fiscalAggregator.web";

import { makeTraceId, _safeTrim, withTimeout, _roundMoney } from "public/mmUtils";

// SSOT-KEYFIELD-02: lectura canonica con fallback alias (contrato unico).
import { readMovementField } from "backend/data";

const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
const DOCS_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;
const MAX_EMAIL_ATTACHMENT_BYTES = SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_ATTACHMENT_BYTES || 3145728;
const MAX_EMAIL_SEND_ATTEMPTS = SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_SEND_ATTEMPTS || 3;
const DEFAULT_MANAGER_EMAIL = SDK_CONFIG?.DOCUMENTS?.DEFAULT_MANAGER_EMAIL || "gestion@marianmadrid.es";


// =============================================================================
// BLOQUE 0 - BASE64 PURO UTF-8 (ALN-03: Buffer no existe en Velo)
// =============================================================================

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function _toBase64Utf8(str) {
    const text = String(str == null ? "" : str);
    if (text === "") return "";

    // Camino rapido: TextEncoder + btoa (ambos disponibles en runtime Velo).
    if (typeof TextEncoder === "function" && typeof btoa === "function") {
        try {
            const bytes = new TextEncoder().encode(text);
            let binary = "";
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(
                    null,
                    Array.from(bytes.subarray(i, i + CHUNK))
                );
            }
            return btoa(binary);
        } catch (_) {
            // cae al camino manual
        }
    }

    // Fallback manual puro (compatibilidad total).
    if (typeof TextEncoder !== "function") {
        throw new Error("BASE64_ENCODING_FAILED: TextEncoder no disponible");
    }
    const bytes = new TextEncoder().encode(text);
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : null;
        const c = i + 2 < bytes.length ? bytes[i + 2] : null;
        const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        result += BASE64_CHARS[(triplet >> 18) & 0x3f];
        result += BASE64_CHARS[(triplet >> 12) & 0x3f];
        result += b === null ? "=" : BASE64_CHARS[(triplet >> 6) & 0x3f];
        result += c === null ? "=" : BASE64_CHARS[triplet & 0x3f];
    }
    return result;
}

// =============================================================================
// BLOQUE 1 - HELPERS
// =============================================================================

function _formatDocumentId(year, quarter, version = 1) {
  const vStr = String(version).padStart(4, "0");
  return `DOC_GESTORIA_${year}_T${quarter}_PAQUETE_GESTORIA_V${vStr}`;
}

// SSOT-KEYFIELD-02: consume el contrato canon->alias UNICO (data.js) sobre
// claves fisicas canonicas; cero grafias alias aqui.
const _rf = (m, key) => _safeTrim(readMovementField(m, key));

function _buildCsvFromInvoices(invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) return "";
  const header = "Numero;Fecha;Tipo;Base;Cuota;Total;FormaPago;Hash\n";
  const rows = invoices.map((inv) =>
    `"${_rf(inv, "numSerieFactura")}";` +
    `"${_rf(inv, "fechaOperacion")}";` +
    `"${_rf(inv, "movementType").toUpperCase()}";` +
    `${_roundMoney(Number(_rf(inv, "taxBase")) || 0)};` +
    `${_roundMoney(Number(_rf(inv, "taxAmount")) || 0)};` +
    `${_roundMoney(Number(_rf(inv, "totalAmount")) || 0)};` +
    `"${_rf(inv, "paymentMethod")}";` +
    `"${_rf(inv, "recordHash")}"`
  ).join("\n");
  return header + rows;
}

function _buildSummaryText(summary) {
  if (!summary) return "Sin datos de resumen.";
  const lines = [];
  lines.push(`Ejercicio: ${summary.ejercicio || "N/A"}`);
  lines.push(`Trimestre: ${summary.trimestre || "N/A"}`);
  lines.push(`Total Operaciones: ${summary.totalOperaciones || 0}`);
  lines.push(`Total Operaciones Fiscales: ${summary.totalOperacionesFiscales || 0}`);
  if (summary.totales) {
    lines.push(`Total Ventas Brutas: ${_roundMoney(summary.totales.totalVentasBrutas || 0)} EUR`);
    lines.push(`Total Reembolsos: ${_roundMoney(summary.totales.totalReembolsos || 0)} EUR`);
    lines.push(`Total Facturado Neto: ${_roundMoney(summary.totales.totalFacturadoNeto || 0)} EUR`);
  }
  if (summary.borradorIva) {
    lines.push(`Borrador IVA - Base Imponible: ${_roundMoney(summary.borradorIva.baseImponibleRegistrada || 0)} EUR`);
    lines.push(`Borrador IVA - Cuota IVA: ${_roundMoney(summary.borradorIva.cuotaIvaRegistrada || 0)} EUR`);
  }
  return lines.join("\n");
}

// =============================================================================
// BLOQUE 2 - PREVIEW DE PAQUETE
// =============================================================================

export const previewManagerPackage = webMethod(Permissions.SiteMember, async (period = {}) => {
  const traceId = makeTraceId("doc-preview");
  try {
    await requireMarianManager(traceId);
    const year = Number(period.year);
    const quarter = Number(period.quarter);
    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
    }

    const [summaryRes, bookRes] = await Promise.all([
      getQuarterlyTaxSummary(year, quarter, { traceId }),
      getLibroRegistroFacturasExpedidasInternal(year, quarter, { traceId, rateLimitKey: "manager" }),
    ]);

    const summary = summaryRes?.data || null;
    const invoices = bookRes?.data?.filas || [];

    return {
      status: "SUCCESS",
      data: {
        period: { year, quarter },
        documentIdDraft: _formatDocumentId(year, quarter, 1),
        summary,
        invoiceCount: invoices.length,
        previewGeneratedAt: new Date(),
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_PREVIEW_FAIL") };
  }
});

// =============================================================================
// BLOQUE 3 - CREAR VERSION DE PAQUETE
// =============================================================================

export const createManagerPackageVersion = webMethod(Permissions.SiteMember, async (period = {}) => {
  const traceId = makeTraceId("doc-create");
  try {
    await requireMarianManager(traceId);
    const year = Number(period.year);
    const quarter = Number(period.quarter);
    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
    }

    const historyRes = await getManagerPackageHistory({ year, quarter });
    const nextVersion = (historyRes?.data?.length || 0) + 1;
    const documentId = _formatDocumentId(year, quarter, nextVersion);

    const [summaryRes, bookRes] = await Promise.all([
      getQuarterlyTaxSummary(year, quarter, { traceId }),
      getLibroRegistroFacturasExpedidasInternal(year, quarter, { traceId, rateLimitKey: "manager" }),
    ]);

    const record = {
      _id: documentId,
      inventoryClosingId: documentId,
      fiscalYear: year,
      closingDate: new Date(),
      closingType: "PAQUETE_GESTORIA",
      summaryData: summaryRes?.data || {},
      invoiceData: bookRes?.data?.filas || [],
      status: "PREPARED",
      traceId,
      _createdDate: new Date(),
    };

    await withTimeout(
      dalSave(DOCS_COL, record),
      CMS_TIMEOUT_MS,
      "saveManagerPackage"
    );

    return {
      status: "SUCCESS",
      data: { documentId, version: nextVersion, createdAt: record._createdDate },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_CREATE_FAIL") };
  }
});

// =============================================================================
// BLOQUE 4 - HISTORIAL DE PAQUETES
// =============================================================================

export const getManagerPackageHistory = webMethod(Permissions.SiteMember, async (period = {}) => {
  const traceId = makeTraceId("doc-hist");
  try {
    await requireMarianManager(traceId);
    const year = Number(period.year);
    const quarter = Number(period.quarter);
    let filter = wql.eq("closingType", "PAQUETE_GESTORIA");
    if (year && Number.isFinite(year)) filter = wql.and(filter, wql.eq("fiscalYear", year));
    if (quarter && Number.isFinite(quarter) && quarter >= 1 && quarter <= 4) {
      filter = wql.and(filter, wql.startsWith("inventoryClosingId", `DOC_GESTORIA_${year}_T${quarter}`));
    }
    const res = await withTimeout(
      queryItems({ dataCollectionId: DOCS_COL, filter, sort: [{ fieldName: "_createdDate", order: "DESC" }], limit: 50 }),
      CMS_TIMEOUT_MS,
      "docHistory"
    );
    return { status: "SUCCESS", data: res?.items || [], error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_HIST_FAIL") };
  }
});

export const getPreparedManagerPackages = webMethod(Permissions.SiteMember, async () => {
  const traceId = makeTraceId("doc-prep");
  try {
    await requireMarianManager(traceId);
    const res = await withTimeout(
      queryItems({ dataCollectionId: DOCS_COL, filter: wql.eq("closingType", "PAQUETE_GESTORIA"), sort: [{ fieldName: "_createdDate", order: "DESC" }], limit: 20 }),
      CMS_TIMEOUT_MS,
      "preparedPackages"
    );
    return { status: "SUCCESS", data: { items: res?.items || [] }, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_PREP_FAIL") };
  }
});

// =============================================================================
// BLOQUE 5 - DESCARGAR VERSION
// =============================================================================

export const downloadManagerPackageVersion = webMethod(Permissions.SiteMember, async (params = {}) => {
  const traceId = makeTraceId("doc-download");
  try {
    await requireMarianManager(traceId);
    const documentId = _safeTrim(params.documentId);
    if (!documentId) {
      return { status: "ERROR", data: null, error: { code: "DOC_ID_REQUIRED", message: "documentId required" } };
    }

    const doc = await withTimeout(
      dalGet(DOCS_COL, documentId, "strong"),
      CMS_TIMEOUT_MS,
      "getDocPackage"
    );

    if (!doc) {
      return { status: "ERROR", data: null, error: { code: "DOC_NOT_FOUND", message: "Document version not found" } };
    }

    const invoices = Array.isArray(doc.invoiceData) ? doc.invoiceData : [];
    const csvContent = _buildCsvFromInvoices(invoices);
    const summaryText = _buildSummaryText(doc.summaryData);

    return {
      status: "SUCCESS",
      data: {
        documentId,
        csvContent,
        summaryText,
        summary: doc.summaryData || {},
        invoiceCount: invoices.length,
        createdAt: doc._createdDate || doc.closingDate,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_DOWNLOAD_FAIL") };
  }
});

// =============================================================================
// BLOQUE 6 - ENVIAR POR EMAIL
// =============================================================================

export const emailManagerPackageVersion = webMethod(Permissions.SiteMember, async (params = {}) => {
  const traceId = makeTraceId("doc-email");
  try {
    await requireMarianManager(traceId);
    const documentId = _safeTrim(params.documentId);
    const recipient = _safeTrim(params.recipient);
    if (!documentId || !recipient || params.confirmed !== true) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "CONFIRMATION_REQUIRED", message: "Confirmation, documentId, and recipient required" },
      };
    }

    const downloadRes = await downloadManagerPackageVersion({ documentId });
    if (downloadRes.status !== "SUCCESS" || !downloadRes.data) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "DOC_PACKAGE_FAILED", message: "Could not package document data" },
      };
    }

    const apiKey = await getSecretValue(SECRETS.RESEND_API_KEY).catch(() => "");
    const fromEmail = (await getSecretValue(SECRETS.RESEND_FROM_EMAIL).catch(() => "")) || DEFAULT_MANAGER_EMAIL;

    if (!apiKey) {
      return {
        status: "SUCCESS",
        data: {
          sent: false,
          note: "Resend API key not configured in Secrets Manager. Package stored in CMS history.",
        },
        error: null,
      };
    }

    // ALN-03: Buffer NO existe en Velo. Base64 puro UTF-8.
    const csvBase64 = _toBase64Utf8(downloadRes.data.csvContent);
    if (csvBase64.length > MAX_EMAIL_ATTACHMENT_BYTES) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "ATTACHMENT_TOO_LARGE", message: "CSV attachment exceeds maximum allowed size" },
      };
    }

    const resendPayload = {
      from: `Marian Madrid <${fromEmail}>`,
      to: [recipient],
      subject: `[Gestoria] Paquete Fiscal ${documentId}`,
      text: `Adjunto resumen fiscal y extracto del libro diario para el paquete ${documentId}.\n\n${downloadRes.data.summaryText}\n\nGenerado: ${new Date().toISOString()}`,
      attachments: [
        {
          filename: `${documentId}.csv`,
          content: csvBase64,
        },
      ],
    };

    let sent = false;
    for (let attempt = 1; attempt <= MAX_EMAIL_SEND_ATTEMPTS; attempt++) {
      try {
        const response = await withTimeout(
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(resendPayload),
          }),
          CMS_TIMEOUT_MS,
          `resend_email_attempt_${attempt}`
        );
        if (response.ok) {
          sent = true;
          break;
        }
      } catch (emailErr) {
        if (attempt === MAX_EMAIL_SEND_ATTEMPTS) throw emailErr;
      }
    }

    return { status: "SUCCESS", data: { sent, recipient, documentId }, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_EMAIL_FAIL") };
  }
});

/* CERO-DEUDA SSOT-SCAN (2026-10-23): eliminada
   prepareScheduledManagerPackages() (cron desconectado: no registrada en
   jobs.config ni importada en crons.js). La generacion de paquetes de
   gestoria se ejecuta on-demand via createManagerPackageVersion. */