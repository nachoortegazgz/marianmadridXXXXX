/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5011-R2-SECURITY
BASE: v5010.2-SECURITY + delegación de identidad en backend/staff.js.
  MapaStaff existe en CMS; este módulo no la consulta directamente.
RESPONSIBILITY: Web methods de seguridad para frontend.
                Delegacion exclusiva en backend/security.js y backend/staff.js.
STANDARDS: G10 ASCII Strict.
CORRECCIONES v5011-R2:
  SECW-R2-01 (P0): _isMarianManagerIdentity no consulta directamente CMS;
    delega en backend/staff.js, que combina Bookings Staff API con el mapeo
    canónico MapaStaff y deniega roles si el mapeo está inactivo o ausente.
FIXES HEREDADOS v5010.2: MARIAN_RESOURCE_ID como dato de negocio local.
FIXES HEREDADOS v5010.1: C-02 (checkStaffCollaboratorAccess devuelve
  {isMarianManager, isAdmin, isCajero} para ZONA MARIAN.gn7mx.js).
PENDIENTES: ninguno (dataLegacyAdapter ya no se usa en este modulo).
=============================================================================
*/
import { webMethod, Permissions } from "wix-web-module";
/* SW-R3-02 (R0-02): currentMember.getMember() sustituye a
 * members.getCurrentMember(). */
import { currentMember } from "@wix/members";
import { makeTraceId } from "public/mmUtils";
import {
    isAdmin,
    isCajero,
    isStaffCollaborator,
} from "backend/security";
import {
    findStaffByResourceId,
    findMarianStaff,
    isMarianResource,
} from "backend/staff";
import {
    successResponse,
    errorResponse,
} from "backend/responseUtils";

// =============================================================================
// BLOQUE 1 - HELPERS INTERNOS
// =============================================================================

function _resolveTraceId(options, prefix) {
    const suppliedTraceId =
        options &&
        typeof options === "object" &&
        typeof options.traceId === "string" ?
            options.traceId.trim() :
            "";

    return suppliedTraceId || makeTraceId(prefix);
}

function _createAccessResponse(authorized, role) {
    return successResponse({
        authorized: authorized === true,
        role: authorized === true ? role : null,
    });
}

function _handleSecurityError(error, fallbackCode) {
    return errorResponse(
        error?.code || fallbackCode,
        error?.message || "No se pudo verificar el acceso."
    );
}

// =============================================================================
// BLOQUE 3 - CHECK ADMIN ACCESS
// =============================================================================

export const checkAdminAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-admin");

        try {
            const authorized = await isAdmin(traceId);

            return _createAccessResponse(authorized, "ADMIN");
        } catch (error) {
            return _handleSecurityError(error, "SEC_ADMIN_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 4 - CHECK CAJERO ACCESS
// =============================================================================

export const checkCajeroAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-cajero");

        try {
            const authorized = await isCajero(traceId);

            return _createAccessResponse(authorized, "CAJERO");
        } catch (error) {
            return _handleSecurityError(error, "SEC_CAJERO_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 5 - CHECK STAFF COLLABORATOR ACCESS (CONTRATO ADMINISTRACION)
// Devuelve { isMarianManager, isAdmin, isCajero }.
// isMarianManager: miembro autenticado cuyo email coincide con el staff
// resuelto via backend/staff.js para MARIAN_RESOURCE_ID (Bookings Staff
// API, con roles/vínculos validados por backend/staff.js contra MapaStaff). Fail-closed: cualquier duda
// deniega.
// =============================================================================

/* R2/DUP-03: constante local _MARIAN_RESOURCE_ID eliminada. La identidad
 * Marian vive solo en backend/staff.js (isMarianResource /
 * findStaffByResourceId). */
async function _isMarianManagerIdentity(traceId) {
    try {
        /* SW-R3-02 (R0-02): currentMember.getMember() con shape defensivo. */
        const response = await currentMember.getMember().catch(() => null);
        const contact = response?.member || response;

        const email = String(
            contact?.loginEmail || contact?.contactDetails?.email || contact?.email || ""
        ).trim().toLowerCase();

        if (!email) {
            return false;
        }

        /* R2/DUP-03: sin query CMS directa en este módulo ni suppressAuth. La identidad
         * Marian se resuelve via backend/staff.js (Bookings Staff API + MapaStaff):
         * el resourceId de Marian debe existir y su email coincidir con el
         * miembro autenticado. Fail-closed ante cualquier error. */
        const marian = await findMarianStaff(traceId);
        if (!marian) return false;
        const staffEmail = String(marian.email || "").trim().toLowerCase();
        return Boolean(staffEmail && staffEmail === email);
    } catch (error) {
        return false;
    }
}

export const checkStaffCollaboratorAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-staff");

        try {
            const [collaborator, admin, cashier] = await Promise.all([
                isStaffCollaborator(traceId),
                isAdmin(traceId),
                isCajero(traceId),
            ]);

            const marianManager = collaborator === true
                ? await _isMarianManagerIdentity(traceId)
                : false;

            return successResponse({
                // Contrato consumido por ADMINISTRACION.gn7mx.js (C-02):
                isMarianManager: marianManager === true,
                isAdmin: admin === true,
                isCajero: cashier === true,
                // Campos informativos retrocompatibles:
                isStaffCollaborator: collaborator === true,
                authorized: collaborator === true,
                role: collaborator === true
                    ? (marianManager ? "ADMIN" : (cashier ? "GESTION" : "ESTILISTA"))
                    : null,
            });
        } catch (error) {
            return _handleSecurityError(error, "SEC_STAFF_FAIL");
        }
    }
);
