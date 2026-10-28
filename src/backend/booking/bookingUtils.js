/*
MODULE: src/backend/booking/bookingUtils.js
RESPONSIBILITY: Pure booking-domain utilities for dates, paired phases, staff/resource selection and canonical booking payload normalization.
DEPENDENCIES: public/mmUtils
PUBLIC EXPORTS: _normalizeGuidForComparison, _buildPairFingerprint, _buildPairTokenDeterministic, normalizeSlotShape, getResourceIdsFromSlot, _rankResourcesByLoad, normalizeCatalogAddOn, calculateBookingAmount, cleanGuidList, cleanGuidListByKey, computeGapMinutes, toUtcRange, isDualGapWithinLimit, readDurationRange, resolveExpectedSlotMinutes, computeTotalDuration, validateSlotDuration
HISTORY: This header documents the current source contract only. Historical changes belong to Git commit history; no unverified version/changelog claims are retained here.
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

const PAIR_FINGERPRINT_FIELDS = Object.freeze([
    "serviceId",
    "linkedPhases",
    "dateYmd",
    "f1Start",
    "f1End",
    "f2Start",
    "f2End",
    "resourceId"
]);

const DATE_YMD_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

function _assertPairFingerprintContract() {
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

/**
 * Rank available staff by already-booked minutes for the requested day.
 * Invalid or missing load values sort last. Equal loads use the display name
 * as a stable tie-breaker, then the original candidate order.
 */
export function _rankResourcesByLoad(candidateIds, minutesByResourceId, namesByResourceId) {
    const candidates = cleanGuidList(candidateIds);
    const loads = minutesByResourceId && typeof minutesByResourceId === "object"
        ? minutesByResourceId
        : {};
    const names = namesByResourceId && typeof namesByResourceId === "object"
        ? namesByResourceId
        : {};

    return candidates
        .map(function (resourceId, index) {
            const rawLoad = Number(loads[resourceId]);
            const load = Number.isFinite(rawLoad) && rawLoad >= 0
                ? rawLoad
                : Infinity;
            return {
                resourceId: resourceId,
                load: load,
                name: _safeTrim(names[resourceId]).toLowerCase(),
                index: index
            };
        })
        .sort(function (a, b) {
            if (a.load !== b.load) return a.load < b.load ? -1 : 1;
            if (a.name !== b.name) return a.name < b.name ? -1 : 1;
            return a.index - b.index;
        })
        .map(function (item) { return item.resourceId; });
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

/**
 * Calculate the operational booking total from the canonical service/add-on
 * catalog. Missing or unpriced add-ons are flagged instead of silently
 * pretending the base service price is the final total.
 */
export function calculateBookingAmount(service, selectedAddonIds = []) {
    const rawBasePrice = service && service.price;
    const basePrice = Number(rawBasePrice);
    const baseKnown =
        rawBasePrice !== undefined &&
        rawBasePrice !== null &&
        rawBasePrice !== "" &&
        Number.isFinite(basePrice) &&
        basePrice >= 0;

    let totalAmount = baseKnown ? basePrice : 0;
    let amountReconciliationRequired = !baseKnown;
    const missingAddonIds = [];
    const catalog = Array.isArray(service && service.addOnOptions)
        ? service.addOnOptions.map(normalizeCatalogAddOn).filter(Boolean)
        : [];
    const requested = Array.from(new Set(
        (Array.isArray(selectedAddonIds) ? selectedAddonIds : [])
            .map(value => _safeTrim(value))
            .filter(value => _looksLikeGuid(value))
    ));

    for (const addonId of requested) {
        const addon = catalog.find(item => item.addOnId === addonId);
        if (!addon) {
            amountReconciliationRequired = true;
            missingAddonIds.push(addonId);
            continue;
        }
        totalAmount += addon.price;
    }

    return {
        totalAmount: Math.round((totalAmount + Number.EPSILON) * 100) / 100,
        amountSource: "SERVICIOS_CATALOGO",
        amountReconciliationRequired,
        missingAddonIds,
    };
}

/* CERO-DEUDA H-07 (2026-10-20): alias export const resolveNativeAddOnIds
   eliminado (0 consumidores verificados con grep -rw en todo src/).
   CERO-DEUDA SSOT-SCAN (2026-10-23): resolveAddOnIds eliminado (0
   consumidores; la normalizacion real de complementos en la saga la
   ejecuta _detectAddons en bookingSaga.js). */