/*
=============================================================================
MODULE: backend/fiscalDocuments.web.js
VERSION: v5013-CMS-FINAL
RESPONSIBILITY: Fiscal package preview, versioning, download and email dispatch.
STANDARDS: G10 ASCII Strict.

CHANGES v5013-CMS-FINAL (alignment pages <-> backend):
  - FISCAL-DOC-01: Re-ported emailManagerPackageVersion webMethod. The page
    "ZONA MARIAN.gn7mx.js" imports and invokes it (ACTIONS.EMAIL_PACKAGE);
    its absence broke the frontend module graph (ESM import of a missing
    export). Dispatch uses fetch() against the Resend API (no Buffer needed:
    CSV is sent as a plain string attachment). Rate-limited via security.
    rateLimiter with an in-memory fallback if persistent block storage fails.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import { currentMember } from "@wix/members";
import { query, getItem, saveItem as save } from "backend/dataAccess";
import { secrets } from "@wix/secrets";

import {
  BUSINESS_COLLECTIONS,
  SDK_CONFIG,
} from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import {
  makeTraceId,
  _safeTrim,
  withTimeout,
  _roundMoney,
  getMadridDateYmd,
} from "public/mmUtils";
import { requireMarianManager, rateLimiter } from "backend/security";
import { logger } from "backend/logger";
import { _toPublicError } from "backend/responseUtils";
import {
  getQuarterlyTaxSummary,
  getLibroRegistroFacturasExpedidasInternal,
} from "backend/fiscalAggregator.web.js";

const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
const DOCS_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;
const MAX_EMAIL_ATTACHMENT_BYTES = Number(
  SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_ATTACHMENT_BYTES || 3145728
);
const MAX_EMAIL_SEND_ATTEMPTS = Number(
  SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_SEND_ATTEMPTS || 3
);
const DEFAULT_MANAGER_EMAIL =
  SDK_CONFIG?.DOCUMENTS?.DEFAULT_MANAGER_EMAIL || "gestion@marianmadrid.es";

function _validatePeriod(period = {}) {
  const year = Number(period.year);
  const quarter = Number(period.quarter);

  if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return null;
  }

  return { year, quarter };
}

function _formatDocumentId(year, quarter, version = 1) {
  return `DOC_GESTORIA_${year}_T${quarter}_PAQUETE_GESTORIA_V${String(version).padStart(4, "0")}`;
}

function _readInvoiceValue(invoice, canonical, ...legacyFields) {
  for (const field of [canonical, ...legacyFields]) {
    if (invoice?.[field] !== undefined && invoice?.[field] !== null) {
      return invoice[field];
    }
  }
  return "";
}

function _buildCsvFromInvoices(invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) {
    return "";
  }

  const header = "Numero;Fecha;Tipo;Base;Cuota;Total;FormaPago;Hash\n";
  const rows = invoices.map((invoice) => {
    const invoiceNumber = _readInvoiceValue(invoice, "invoiceNumber", "numTicketFactura");
    const issueDate = _readInvoiceValue(invoice, "issueDate", "fechaExpedicion", "diaKey");
    const movementType = _readInvoiceValue(invoice, "movementType", "tipoMovimiento");
    const taxableAmount = Number(_readInvoiceValue(invoice, "taxableAmount", "baseImponible") || 0);
    const taxAmount = Number(_readInvoiceValue(invoice, "taxAmount", "cuotaIva") || 0);
    const totalAmount = Number(invoice?.totalAmount || 0);
    const paymentMethod = _readInvoiceValue(invoice, "paymentMethod", "formaPago");
    const recordHash = _readInvoiceValue(invoice, "hashCompleto", "recordHash", "currentRecordHash", "hashCadena");

    return [
      invoiceNumber,
      issueDate,
      movementType,
      _roundMoney(taxableAmount),
      _roundMoney(taxAmount),
      _roundMoney(totalAmount),
      paymentMethod,
      recordHash,
    ].map((value) => `"${_safeTrim(value)}"`).join(";");
  });

  return `${header}${rows.join("\n")}`;
}

function _buildSummaryText(summary) {
  if (!summary) {
    return "Sin datos de resumen.";
  }

  const lines = [
    `Ejercicio: ${summary.ejercicio || "N/A"}`,
    `Trimestre: ${summary.trimestre || "N/A"}`,
    `Total Operaciones: ${summary.totalOperaciones || 0}`,
    `Total Operaciones Fiscales: ${summary.totalOperacionesFiscales || 0}`,
  ];

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

async function _readPackageHistory(year, quarter) {
  let query = query(DOCS_COL).eq("closingType", "PAQUETE_GESTORIA");

  if (Number.isInteger(year)) {
    query = query.eq("fiscalYear", year);
  }

  if (Number.isInteger(quarter) && quarter >= 1 && quarter <= 4) {
    query = query.startsWith("inventoryClosingId", `DOC_GESTORIA_${year}_T${quarter}`);
  }

  const result = await withTimeout(
    query.descending("_createdDate").limit(50).find(),
    CMS_TIMEOUT_MS,
    "docHistory"
  );

  return result?.items || [];
}

export const previewManagerPackage = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-preview");

    try {
      await requireMarianManager(traceId);
      const validPeriod = _validatePeriod(period);

      if (!validPeriod) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
      }

      const [summaryResult, bookResult] = await Promise.all([
        getQuarterlyTaxSummary(validPeriod.year, validPeriod.quarter, { traceId }),
        getLibroRegistroFacturasExpedidasInternal(validPeriod.year, validPeriod.quarter, { traceId }),
      ]);

      const invoices = bookResult?.data?.filas || [];

      return {
        status: "SUCCESS",
        data: {
          period: validPeriod,
          documentIdDraft: _formatDocumentId(validPeriod.year, validPeriod.quarter),
          summary: summaryResult?.data || null,
          invoiceCount: invoices.length,
          previewGeneratedAt: new Date(),
        },
        error: null,
      };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_PREVIEW_FAIL") };
    }
  }
);

export const createManagerPackageVersion = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-create");

    try {
      await requireMarianManager(traceId);
      const validPeriod = _validatePeriod(period);

      if (!validPeriod) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
      }

      const history = await _readPackageHistory(validPeriod.year, validPeriod.quarter);
      const version = history.length + 1;
      const documentId = _formatDocumentId(validPeriod.year, validPeriod.quarter, version);
      const [summaryResult, bookResult] = await Promise.all([
        getQuarterlyTaxSummary(validPeriod.year, validPeriod.quarter, { traceId }),
        getLibroRegistroFacturasExpedidasInternal(validPeriod.year, validPeriod.quarter, { traceId }),
      ]);
      const createdAt = new Date();
      const record = {
        _id: documentId,
        inventoryClosingId: documentId,
        fiscalYear: validPeriod.year,
        closingDate: createdAt,
        closingType: "PAQUETE_GESTORIA",
        summaryData: summaryResult?.data || {},
        invoiceData: bookResult?.data?.filas || [],
        status: "PREPARED",
        traceId,
        _createdDate: createdAt,
      };

      await withTimeout(
        save(DOCS_COL, record),
        CMS_TIMEOUT_MS,
        "saveManagerPackage"
      );

      return { status: "SUCCESS", data: { documentId, version, createdAt }, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_CREATE_FAIL") };
    }
  }
);

export const getManagerPackageHistory = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-history");

    try {
      await requireMarianManager(traceId);
      const year = Number(period.year);
      const quarter = Number(period.quarter);
      const items = await _readPackageHistory(
        Number.isInteger(year) ? year : null,
        Number.isInteger(quarter) ? quarter : null
      );

      return { status: "SUCCESS", data: items, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_HIST_FAIL") };
    }
  }
);

export const getPreparedManagerPackages = webMethod(
  Permissions.SiteMember,
  async () => {
    const traceId = makeTraceId("doc-prep");

    try {
      await requireMarianManager(traceId);
      const result = await withTimeout(
        query(DOCS_COL)
          .eq("closingType", "PAQUETE_GESTORIA")
          .descending("_createdDate")
          .limit(20)
          .find(),
        CMS_TIMEOUT_MS,
        "preparedPackages"
      );

      return { status: "SUCCESS", data: { items: result?.items || [] }, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_PREP_FAIL") };
    }
  }
);

export const downloadManagerPackageVersion = webMethod(
  Permissions.SiteMember,
  async (params = {}) => {
    const traceId = makeTraceId("doc-download");

    try {
      await requireMarianManager(traceId);
      const documentId = _safeTrim(params.documentId);

      if (!documentId) {
        return { status: "ERROR", data: null, error: { code: "DOC_ID_REQUIRED", message: "documentId required" } };
      }

      const document = await withTimeout(
        getItem(DOCS_COL, documentId),
        CMS_TIMEOUT_MS,
        "getDocPackage"
      );

      if (!document) {
        return { status: "ERROR", data: null, error: { code: "DOC_NOT_FOUND", message: "Document version not found" } };
      }

      const invoices = Array.isArray(document.invoiceData) ? document.invoiceData : [];
      return {
        status: "SUCCESS",
        data: {
          documentId,
          csvContent: _buildCsvFromInvoices(invoices),
          summaryText: _buildSummaryText(document.summaryData),
          summary: document.summaryData || {},
          invoiceCount: invoices.length,
          createdAt: document._createdDate || document.closingDate,
        },
        error: null,
      };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_DOWNLOAD_FAIL") };
    }
  }
);

export async function prepareScheduledManagerPackages(options = {}) {
  const traceId = options.traceId || makeTraceId("cron-packages");

  try {
    const now = new Date();
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    const result = await createManagerPackageVersion({
      year: now.getFullYear(),
      quarter,
    });

    return { status: "SUCCESS", data: result?.data || null, error: null };
  } catch (error) {
    return { status: "ERROR", data: null, error: _toPublicError(error, "SCHEDULED_PACKAGES_FAIL") };
  }
}

// ============================================================================
// EMAIL DISPATCH (FISCAL-DOC-01, v5013-CMS-FINAL)
// Resend API via fetch(). No Buffer dependency: the CSV attachment is a plain
// UTF-8 string, which Resend accepts directly. Rate-limited per member/day to
// prevent abuse of outbound email.
// ============================================================================

const RESEND_API_URL = "https://api.resend.com/emails";
const EMAIL_RATE_MAX_PER_DAY = 10;
const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function _getSecretValue(name) {
  try {
    return await secrets.getSecret(name);
  } catch (error) {
    logger.warn("fiscalDocuments: secret unavailable", {
      name,
      message: error?.message || String(error),
    });
    return null;
  }
}

async function _resolveRecipientEmail(params = {}) {
  const explicit = _safeTrim(params.to || params.recipientEmail).toLowerCase();
  if (explicit && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(explicit)) {
    return explicit;
  }
  const configured = _safeTrim(
    SDK_CONFIG?.DOCUMENTS?.DEFAULT_MANAGER_EMAIL
  ).toLowerCase();
  return configured || null;
}

export const emailManagerPackageVersion = webMethod(
  Permissions.SiteMember,
  async (params = {}) => {
    const traceId = makeTraceId("doc-email");

    try {
      await requireMarianManager(traceId);

      const documentId = _safeTrim(params.documentId);
      if (!documentId) {
        return { status: "ERROR", data: null, error: { code: "DOC_ID_REQUIRED", message: "documentId required" } };
      }

      // Per-member daily rate limit (in-memory limiter; persistent block is
      // handled internally by security.rateLimiter when threshold is hit).
      let rateKey = "anonymous";
      try {
        const member = await currentMember.getMember();
        rateKey = member?.id || "anonymous";
      } catch (error) {
        logger.warn("fiscalDocuments: rate key resolution failed", {
          traceId,
          message: error?.message || String(error),
        });
      }
      const rateResult = rateLimiter(
        { surface: "doc-email", key: `${rateKey}:${getMadridDateYmd()}` },
        EMAIL_RATE_MAX_PER_DAY,
        EMAIL_RATE_WINDOW_MS
      );
      if (!rateResult.allowed) {
        return {
          status: "ERROR",
          data: null,
          error: {
            code: "DOC_EMAIL_RATE_LIMIT",
            message: `Too many email requests. Retry after ${rateResult.retryAfter}s`,
          },
        };
      }

      const document = await withTimeout(
        getItem(DOCS_COL, documentId),
        CMS_TIMEOUT_MS,
        "getDocPackageForEmail"
      );
      if (!document) {
        return { status: "ERROR", data: null, error: { code: "DOC_NOT_FOUND", message: "Document version not found" } };
      }

      const invoices = Array.isArray(document.invoiceData) ? document.invoiceData : [];
      const csvContent = _buildCsvFromInvoices(invoices);
      const summaryText = _buildSummaryText(document.summaryData);

      const sizeBytes = new TextEncoder().encode(csvContent + summaryText).length;
      if (sizeBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
        return { status: "ERROR", data: null, error: { code: "DOC_EMAIL_TOO_LARGE", message: "Package exceeds max attachment size" } };
      }

      const apiKey = await _getSecretValue(SECRETS.RESEND_API_KEY);
      const fromEmail = _safeTrim(
        (await _getSecretValue(SECRETS.RESEND_FROM_EMAIL)) ||
        DEFAULT_MANAGER_EMAIL
      );
      const toEmail = await _resolveRecipientEmail(params);

      if (!apiKey || !fromEmail || !toEmail) {
        return { status: "ERROR", data: null, error: { code: "DOC_EMAIL_NOT_CONFIGURED", message: "Email dispatch not configured (RESEND_API_KEY / RESEND_FROM_EMAIL / recipient)" } };
      }

      const payload = {
        from: fromEmail,
        to: [toEmail],
        subject: `Paquete gestion fiscal ${documentId}`,
        text: [
          "Paquete de gestion para la gestoria.",
          "",
          summaryText,
          "",
          `Documento: ${documentId}`,
          `Facturas incluidas: ${invoices.length}`,
        ].join("\n"),
        attachments: [
          {
            filename: `${documentId}.csv`,
            content: csvContent,
            content_type: "text/csv",
          },
        ],
      };

      let lastError = null;
      for (let attempt = 1; attempt <= MAX_EMAIL_SEND_ATTEMPTS; attempt += 1) {
        try {
          const response = await withTimeout(
            fetch(RESEND_API_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            }),
            CMS_TIMEOUT_MS,
            `resend_email_attempt_${attempt}`
          );

          if (response.ok) {
            const data = await response.json().catch(() => null);
            return {
              status: "SUCCESS",
              data: {
                documentId,
                emailId: data?.id || null,
                to: toEmail,
                attempts: attempt,
                invoiceCount: invoices.length,
              },
              error: null,
            };
          }

          const errBody = await response.text().catch(() => "");
          lastError = `RESEND_HTTP_${response.status}: ${errBody.slice(0, 200)}`;
          // Non-retryable client errors (bad payload / auth): stop early.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            break;
          }
        } catch (error) {
          lastError = error?.message || String(error);
        }
      }

      logger.error("fiscalDocuments: email dispatch failed", { traceId, documentId, lastError });
      return { status: "ERROR", data: null, error: { code: "DOC_EMAIL_SEND_FAIL", message: "Email dispatch failed after retries" } };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_EMAIL_FAIL") };
    }
  }
);
