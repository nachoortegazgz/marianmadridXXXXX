/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5010.2-SECURITY
BASE: v5010.1-SECURITY + eliminacion de STAFF_ACCESS (internalConfig v12).
RESPONSIBILITY: Web methods de seguridad para frontend.
                Delegacion exclusiva en backend/security.js.
STANDARDS: G10 ASCII Strict.
CORRECCIONES APLICADAS v5010.2:
  SECW-01 (P0): STAFF_ACCESS eliminado. MARIAN_RESOURCE_ID definido como
    constante local _MARIAN_RESOURCE_ID. El GUID de Marian es dato de
    negocio, no configuracion transversal.
FIXES HEREDADOS v5010.1: C-02 (checkStaffCollaboratorAccess devuelve
  {isMarianManager, isAdmin, isCajero} para ADMINISTRACION.gn7mx.js).
FIXES HEREDADOS v5009-FISCAL-V20.1: V20-01 (sin renombrados funcionales).
PENDIENTES:
  - Migracion dataLegacyAdapter -> backend/dataAccess.
  - Migracion suppressAuth -> consistencyMode (matriz transversal).
=============================================================================
*/
import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataLegacyAdapter";
import { members } from "@wix/members";
import { makeTraceId } from "public/mmUtils";
import {
    isAdmin,
    isCajero,
    isStaffCollaborator,
} from "backend/security";
// SECW-01: STAFF_ACCESS eliminado. Constante local abajo.
import {
    successResponse,
    errorResponse,
} from "backend/responseUtils";

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

// SECW-01: GUID de Marian Madrid. Antes en STAFF_ACCESS.MARIAN_RESOURCE_ID.
// Si cambia el resourceId de Marian en MapaStaff, actualizar aqui.
const _MARIAN_RESOURCE_ID = "e556070a-6d6a-402e-8422-11133033ea76";

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
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
// isMarianManager: miembro autenticado cuyo email esta dado de alta
// en MapaStaff con resourceId = _MARIAN_RESOURCE_ID y rol ADMIN
// (identidad Marian). Fail-closed: cualquier duda deniega.
// =============================================================================

// SECW-01: Usa constante local _MARIAN_RESOURCE_ID.
// Antes: STAFF_ACCESS.MARIAN_RESOURCE_ID.
async function _isMarianManagerIdentity(traceId) {
    try {
        const contact = await members.getCurrentMember().catch(() => null);

        const email = String(
            contact?.loginEmail || contact?.contactDetails?.email || contact?.email || ""
        ).trim().toLowerCase();

        if (!email) {
            return false;
        }

        const res = await wixData
            .query("MapaStaff")
            .eq("email", email)
            .eq("resourceId", _MARIAN_RESOURCE_ID)
            .limit(1)
            .find({ suppressAuth: true });

        return Boolean(res?.items?.[0]);
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
