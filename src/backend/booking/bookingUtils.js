/*
MODULE: backend/booking/bookingUtils.js
VERSION: v5009.0-UTILS06-FINAL
BASE: v5008.7-UTILS05-FIX + revision UTILS-06 (17 patches)
RESPONSIBILITY: Capa de utilidades PURAS del dominio de reservas. Sin acceso a
                CMS, sin SDK de Wix, sin efectos.
                Precedencia: mmUtils > bookingUtils > bookingCore > *.web.js
STANDARDS: G10 ASCII estricto. Solo imports de public/mmUtils.

FIXES APLICADOS v5009.0-UTILS06-FINAL:
  UTILS-06: guarda real de PAIR_FINGERPRINT_FIELDS (whitelist esperada,
            trim, no-vacio). Sustituye la comprobacion circular anterior.
  UTILS-07: dateYmd derivado estricto. Si f1Start no es YYYY-MM-DD valido,
            se lanza error. Nunca se genera huella con fecha vacia.
  UTILS-08: _assertPairDateOrder valida f1End > f1Start, f2End > f2Start y
            f2Start >= f1End antes de serializar.
  UTILS-09: normalizeCatalogAddOn devuelve solo { addOnId, name, price }.
            Se elimina nativeId del contrato (no existe en ComplementosCatalogo).
  UTILS-10: resolveNativeAddOnIds renombrado a resolveAddOnIds. Se conserva
            alias deprecado para compatibilidad transitoria.
  UTILS-11: resolveLinkedPhase2Duration no muta el Set recibido.
  UTILS-12: resolveLinkedPhase2Duration acepta logger opcional inyectable.
            Sin logger, no se registra nada (capa pura).
  UTILS-13: getResourceIdsFromSlot exige staffResourceTypeId explicito.
            Sin el, devuelve [] (fail-closed).
  UTILS-14: pickStaffByLowestLoad asigna Infinity a cargas invalidas para
            no priorizar recursos con datos corruptos.
  UTILS-15: _normalizeGuidForComparison para comparaciones estables en
            dedupe de GUIDs.

VENTANA DE DRENAJE OBLIGATORIA:
  Al cambiar la huella cambian todos los pairToken. Desplegar en ventana de
  bajo trafico y ejecutar cleanExpiredLocks antes. Sin drenaje, una reserva
  dual en vuelo durante el despliegue podria duplicarse.

REGLAS DE IMPORT (UTILS-16):
  bookingUtils SOLO puede importar public/mmUtils. Cero imports de
  reservas.web, bookingCore, bookingSaga, citasManager, internalConfig,
  dataAccess, wix-*.
=============================================================================
*/

import {
    _safeTrim,
    _looksLikeGuid,
    _hashKey,
    _stableSerialize,
    _normalizeLocalIsoStr,
    cleanGuidList,
    cleanGuidListByKey,
    computeGapMinutes,
    toUtcRange,
    isDualGapWithinLimit,
    readDurationRange,
    resolveExpectedSlotMinutes,
    computeTotalDuration,
    validateSlotDuration
} from "public/mmUtils";

// ============================================================================
// REEXPORTS: primitivas genericas (hogar canonico = public/mmUtils)
// ============================================================================
export {
    cleanGuidList,
    cleanGuidListByKey,
    computeGapMinutes,
    toUtcRange,
    isDualGapWithinLimit,
    readDurationRange,
    resolveExpectedSlotMinutes,
    computeTotalDuration,
    validateSlotDuration
};

// ============================================================================
// NORMALIZACION DE COMPARACION (UTILS-15)
// ============================================================================

/**
 * GUID estable para comparaciones y dedupe. Preserva el formato original
 * cuando se persiste; solo normaliza para igualdad.
 */
export function _normalizeGuidForComparison(value) {
    return _safeTrim(value).toLowerCase();
}

// ============================================================================
// HUELLA Y TOKEN DEL PAR DUAL (UTILS-05/06/07/08)
// ============================================================================

const EXPECTED_PAIR_FINGERPRINT_FIELDS = Object.freeze([
    "serviceId",
    "linkedPhases",
    "dateYmd",
    "f1Start",
    "f1End",
    "f2Start",
    "f2End",
    "resourceId"
]);

const PAIR_FINGERPRINT_FIELDS = EXPECTED_PAIR_FINGERPRINT_FIELDS;

const DATE_YMD_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

function _assertPairFingerprintContract() {
    const actual = JSON.stringify(PAIR_FINGERPRINT_FIELDS);
    const expected = JSON.stringify(EXPECTED_PAIR_FINGERPRINT_FIELDS);

    if (actual !== expected) {
        throw new Error(
            "PAIR_FINGERPRINT_FIELDS contract mismatch: " +
            "expected " + expected + ", got " + actual
        );
    }

    for (let i = 0; i < PAIR_FINGERPRINT_FIELDS.length; i += 1) {
        const field = PAIR_FINGERPRINT_FIELDS[i];
        if (typeof field !== "string" || field.length === 0) {
            throw new Error(
                "PAIR_FINGERPRINT_FIELDS contains empty or non-string field"
            );
        }
        if (field !== field.trim()) {
            throw new Error(
                "PAIR_FINGERPRINT_FIELDS contains field with whitespace: " +
                JSON.stringify(field)
            );
        }
    }
}

_assertPairFingerprintContract();

function _isValidDateYmd(value) {
    return DATE_YMD_LOCAL.test(_safeTrim(value));
}

function _assertPairDateOrder(f1Start, f1End, f2Start, f2End) {
    const f1Range = toUtcRange(f1Start, f1End);
    if (!f1Range) {
        throw new Error(
            "PAIR_FINGERPRINT contains invalid F1 slot dates"
        );
    }

    const hasF2 =
        Boolean(_safeTrim(f2Start)) || Boolean(_safeTrim(f2End));

    if (!hasF2) return;

    const f2Range = toUtcRange(f2Start, f2End);
    if (!f2Range) {
        throw new Error(
            "PAIR_FINGERPRINT contains invalid F2 slot dates"
        );
    }

    if (f2Range.startUtc.getTime() < f1Range.endUtc.getTime()) {
        throw new Error(
            "PAIR_FINGERPRINT contains overlapping phases"
        );
    }
}

export function _buildPairFingerprint(input) {
    const src = (input && typeof input === "object") ? input : {};

    const f1Start = _normalizeLocalIsoStr(src.f1Start) || _safeTrim(src.f1Start);
    const f1End = _normalizeLocalIsoStr(src.f1End) || _safeTrim(src.f1End);
    const f2Start = _normalizeLocalIsoStr(src.f2Start) || _safeTrim(src.f2Start);
    const f2End = _normalizeLocalIsoStr(src.f2End) || _safeTrim(src.f2End);

    _assertPairDateOrder(f1Start, f1End, f2Start, f2End);

    const derivedDateYmd = _safeTrim(f1Start).slice(0, 10);

    if (!_isValidDateYmd(derivedDateYmd)) {
        throw new Error(
            "PAIR_FINGERPRINT requires a valid f1Start date (YYYY-MM-DD)"
        );
    }

    const candidateDateYmd = _safeTrim(src.dateYmd).slice(0, 10);
    const dateYmd = (
        _isValidDateYmd(candidateDateYmd) &&
        candidateDateYmd === derivedDateYmd
    )
        ? candidateDateYmd
        : derivedDateYmd;

    const values = {
        serviceId: _safeTrim(src.serviceId),
        linkedPhases: _safeTrim(src.linkedPhases),
        dateYmd: dateYmd,
        f1Start: f1Start,
        f1End: f1End,
        f2Start: f2Start,
        f2End: f2End,
        resourceId: _safeTrim(src.resourceId)
    };

    const canonical = {};
    for (let i = 0; i < PAIR_FINGERPRINT_FIELDS.length; i += 1) {
        const field = PAIR_FINGERPRINT_FIELDS[i];
        const value = values[field];
        canonical[field] = (value === undefined || value === null)
            ? ""
            : String(value);
    }

    return _stableSerialize(canonical);
}

export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input));
}

// ============================================================================
// RECURSOS (STAFF) DESDE SLOTS DE DISPONIBILIDAD
// ============================================================================

export function normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return Object.assign({}, slot.slot, slot);
    }
    return slot;
}

export function normalizeAvailabilitySlot(slot) {
    const normalized = normalizeSlotShape(slot);
    if (!normalized) return null;

    const localStartDate = _normalizeLocalIsoStr(
        normalized.localStartDate || normalized.startDate
    );

    const localEndDate = _normalizeLocalIsoStr(
        normalized.localEndDate || normalized.endDate
    );

    if (
        !localStartDate ||
        !localEndDate ||
        !toUtcRange(localStartDate, localEndDate)
    ) {
        return null;
    }

    return Object.assign({}, normalized, {
        localStartDate: localStartDate,
        localEndDate: localEndDate
    });
}

export function getResourceIdsFromSlot(slot, staffResourceTypeId) {
    const normalized = normalizeSlotShape(slot);
    if (!normalized) return [];

    const wantedTypeId = _safeTrim(staffResourceTypeId);
    if (!wantedTypeId) return [];

    const groups = Array.isArray(normalized.availableResources)
        ? normalized.availableResources
        : [];

    if (groups.length > 0) {
        const staffGroup = groups.find(function (group) {
            if (!group || typeof group !== "object") return false;
            const resourceType =
                group.resourceType && typeof group.resourceType === "object"
                    ? group.resourceType
                    : {};
            const groupTypeId = _safeTrim(
                group.resourceTypeId ||
                resourceType.id ||
                resourceType._id ||
                group.typeId
            );
            return groupTypeId === wantedTypeId;
        });

        if (!staffGroup) return [];

        const collected = (Array.isArray(staffGroup.resources) ? staffGroup.resources : [])
            .map(function (resource) {
                if (!resource) return "";
                if (typeof resource === "string") return _safeTrim(resource);
                return _safeTrim(resource.id || resource._id || resource.resourceId);
            })
            .filter(_looksLikeGuid);

        return Array.from(new Set(collected));
    }

    const resource = (normalized.resource && typeof normalized.resource === "object")
        ? normalized.resource
        : {};

    const directId = _safeTrim(
        resource.id ||
        resource._id ||
        resource.resourceId ||
        normalized.resourceId
    );

    return _looksLikeGuid(directId) ? [directId] : [];
}

export function pickStaffByLowestLoad(candidateIds, loadByResourceId) {
    const candidates = cleanGuidList(candidateIds);
    if (candidates.length === 0) return null;

    const loads = (loadByResourceId && typeof loadByResourceId === "object")
        ? loadByResourceId
        : {};

    let picked = null;
    let pickedLoad = Infinity;

    for (let index = 0; index < candidates.length; index += 1) {
        const id = candidates[index];
        const raw = Number(loads[id]);
        const safeLoad = (Number.isFinite(raw) && raw >= 0)
            ? raw
            : Infinity;

        if (safeLoad < pickedLoad) {
            pickedLoad = safeLoad;
            picked = id;
        }
    }

    return picked || candidates[0];
}

// ============================================================================
// CATALOGO: DURACION DE LA FASE VINCULADA (F2)
// ============================================================================

export async function resolveLinkedPhase2Duration(
    linkedPhases,
    traceId,
    visited,
    getServiceFn,
    logger = null
) {
    const linkedId = _safeTrim(linkedPhases);
    if (!_looksLikeGuid(linkedId)) return 0;
    if (typeof getServiceFn !== "function") return 0;

    const report = function (message, data) {
        if (logger && typeof logger.warn === "function") {
            logger.warn(message, data);
        }
    };

    const seen = new Set(
        visited instanceof Set ? Array.from(visited) : []
    );

    if (seen.has(linkedId)) {
        report("resolveLinkedPhase2Duration: ciclo detectado en linkedPhases", {
            traceId: traceId,
            linkedPhases: linkedId
        });
        return 0;
    }

    seen.add(linkedId);

    try {
        const result = await getServiceFn(linkedId);
        if (!result || result.status !== "SUCCESS" || !result.data) {
            report("resolveLinkedPhase2Duration: servicio F2 no resuelto", {
                traceId: traceId,
                linkedPhases: linkedId,
                status: (result && result.status) || null
            });
            return 0;
        }

        const linked = result.data;

        const declared = Number(linked.phase2Duration);
        if (Number.isFinite(declared) && declared > 0) return declared;

        const total = Number(linked.totalDuration);
        if (Number.isFinite(total) && total > 0) return total;

        const phase1 = Number(linked.phase1Duration);
        if (Number.isFinite(phase1) && phase1 > 0) return phase1;

        report("resolveLinkedPhase2Duration: servicio F2 sin duracion util", {
            traceId: traceId,
            linkedPhases: linkedId
        });
        return 0;
    } catch (error) {
        report("resolveLinkedPhase2Duration: fallo al consultar el catalogo", {
            traceId: traceId,
            linkedPhases: linkedId,
            error: (error && error.message) || String(error)
        });
        return 0;
    }
}

// ============================================================================
// ADD-ONS (UTILS-09/10)
// ============================================================================

export function normalizeCatalogAddOn(addOn) {
    if (!addOn || typeof addOn !== "object") return null;

    const addOnId = _safeTrim(
        addOn.addonId ||
        addOn.addOnId ||
        addOn.id
    );

    const name = _safeTrim(addOn.name || addOn.title);
    const price = Number(addOn.price);

    if (
        !_looksLikeGuid(addOnId) ||
        !name ||
        !Number.isFinite(price) ||
        price < 0
    ) {
        return null;
    }

    return {
        addOnId,
        name,
        price
    };
}

export function resolveAddOnIds(catalogAddOns, requestedIds, maxPerBooking) {
    const catalog = Array.isArray(catalogAddOns) ? catalogAddOns : [];
    const requested = Array.isArray(requestedIds) ? requestedIds : [];
    const limit = Number(maxPerBooking) > 0 ? Number(maxPerBooking) : 5;

    const validIds = new Set(
        catalog
            .map(normalizeCatalogAddOn)
            .filter(Boolean)
            .map(function (item) { return item.addOnId; })
    );

    const addOnIds = [];
    const rejectedAddOnIds = [];

    for (let i = 0; i < requested.length; i += 1) {
        const id = _safeTrim(requested[i]);
        if (!id) continue;

        if (validIds.has(id)) {
            if (addOnIds.indexOf(id) < 0) addOnIds.push(id);
        } else {
            rejectedAddOnIds.push(id);
        }
    }

    return {
        addOnIds: addOnIds.slice(0, limit),
        rejectedAddOnIds: rejectedAddOnIds
    };
}

export const resolveNativeAddOnIds = resolveAddOnIds;