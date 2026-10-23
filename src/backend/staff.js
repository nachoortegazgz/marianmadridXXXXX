/*
=============================================================================
MODULE: backend/staff.js
VERSION: v9-BRIDGES
BASE: Canonical MapaStaff SSOT joined to native Wix Bookings identities.
RESPONSIBILITY: Resolve staff identity from Bookings, with business roles,
member IDs, third-party links, and schedule IDs read from MapaStaff.
STANDARDS: G10 ASCII Strict. Fail closed when a canonical mapping is missing.
=============================================================================
*/
import { staffMembers } from "@wix/bookings";
import { contactsV5 } from "@wix/crm";
import { auth } from "@wix/essentials";
import {
    SDK_CONFIG,
    BUSINESS_COLLECTIONS,
    STAFF_DEFAULT_NAME,
    isValidGuid,
} from "backend/internalConfig";
import { query as dalQuery } from "backend/dataAccess";
import { _safeTrim, withTimeout } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// CONSTANTES
// =============================================================================
const CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.STAFF_TTL_MS) || 300000;
const CACHE_MAX_ENTRIES = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 100;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

// Bookings Staff Members API oficial.
const queryStaffMembersElevated = auth.elevate(staffMembers.queryStaffMembers);
const getContactElevated = auth.elevate(contactsV5.getContact);
const STAFF_MEMBER_FIELDS = Object.freeze(["RESOURCE_DETAILS", "ASSOCIATED_IDENTITY_STATUS"]);
const MAX_STAFF_PAGES = 20;
const MAPA_STAFF_COL = BUSINESS_COLLECTIONS.MAPA_STAFF;
const STRONG_READ = Object.freeze({ consistencyMode: "strong" });

// =============================================================================
// CACHE LRU
// =============================================================================
const _cache = new Map();

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _cache.delete(key);
        return null;
    }
    _cache.delete(key);
    _cache.set(key, entry);
    return entry.val;
}

function _cacheSet(key, val) {
    if (_cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest) _cache.delete(oldest);
    }
    _cache.set(key, { val, ts: Date.now() });
}

export function invalidateStaffCache() {
    _cache.clear();
}

// =============================================================================
// STAFF IDENTITY AND ROLE NORMALIZATION
// =============================================================================

/**
 * Obtiene un staff member por resourceId desde Bookings Staff API.
 * Retorna objeto normalizado o null.
 */
function _normalizeStaffMember(staff) {
    if (!staff || typeof staff !== "object") return null;

    const resource = staff.resource && typeof staff.resource === "object"
        ? staff.resource
        : {};
    const identity = staff.associatedWixIdentity || {};
    const identityStatus = _safeTrim(identity.connectionStatus || identity.connection?.status || "").toUpperCase();
    const identificationData = identity.identificationData || {};
    const contactId = identityStatus === "CONNECTED"
        ? _safeTrim(identificationData.contactId || "")
        : "";
    const workingHours = Array.isArray(resource.workingHoursSchedules)
        ? resource.workingHoursSchedules[0]
        : null;
    const resourceId = _safeTrim(staff.resourceId || resource.id || resource._id || "");

    const normalized = {
        staffMemberId: _safeTrim(staff.id || staff._id || ""),
        resourceId,
        contactId,
        displayName: _safeTrim(staff.name || ""),
        roleWebsite: "",
        memberId: "",
        thirdPartyId: "",
        rolBookings: "STAFF",
        staffName: _safeTrim(staff.name || ""),
        scheduleId: _safeTrim(
            workingHours?.id ||
            workingHours?._id ||
            resource.eventsSchedule?.id ||
            resource.eventsSchedule?._id ||
            ""
        ),
    };

    return normalized.resourceId ? normalized : null;
}

async function _attachCanonicalMapping(staff, traceId = null) {
    if (!staff?.resourceId) return null;
    const result = await dalQuery(MAPA_STAFF_COL)
        .eq("resourceId", staff.resourceId)
        .limit(1)
        .find(STRONG_READ);
    const mapping = result?.items?.[0];
    if (!mapping || _safeTrim(mapping.resourceId) !== staff.resourceId) {
        log.warn("STAFF_CANONICAL_MAPPING_MISSING", {
            resourceId: staff.resourceId,
            traceId,
        });
        return {
            ...staff,
            roleWebsite: "",
            memberId: "",
            thirdPartyId: "",
            mappingFound: false,
        };
    }

    const roleWebsite = _safeTrim(mapping.rolWebsite).toUpperCase();
    const allowedRoles = new Set(["ADMIN", "GESTION", "ESTILISTA"]);
    return {
        ...staff,
        staffMemberId: _safeTrim(mapping.staffMemberId || staff.staffMemberId),
        displayName: _safeTrim(mapping.staffName || mapping.displayName || staff.displayName),
        staffName: _safeTrim(mapping.staffName || ""),
        memberId: _safeTrim(mapping.memberId || ""),
        thirdPartyId: _safeTrim(mapping.thirdPartyId || ""),
        roleWebsite: allowedRoles.has(roleWebsite) ? roleWebsite : "",
        rolBookings: _safeTrim(mapping.rolBookings || ""),
        scheduleId: _safeTrim(mapping.scheduleId || staff.scheduleId),
        mappingFound: true,
    };
}

function _indexStaff(staff) {
    if (!staff) return;
    _cacheSet(`staff:rid:${staff.resourceId}`, staff);
    if (staff.contactId && isValidGuid(staff.contactId)) {
        _cacheSet(`staff:contact:${staff.contactId}`, staff);
    }
}

async function _queryStaffMembers({ filter = null, traceId = null } = {}) {
    const all = [];
    let cursor = "";
    for (let page = 0; page < MAX_STAFF_PAGES; page += 1) {
        const query = {
            cursorPaging: {
                limit: 100,
                ...(cursor ? { cursor } : {}),
            },
        };
        if (!cursor && filter) query.filter = filter;

        const response = await withTimeout(
            queryStaffMembersElevated(query, { fields: STAFF_MEMBER_FIELDS }),
            API_TIMEOUT_MS,
            "Bookings.staffMembers.queryStaffMembers"
        );

        const items = Array.isArray(response?.staffMembers)
            ? response.staffMembers
            : [];
        all.push(...items);

        const nextCursor = _safeTrim(response?.pagingMetadata?.cursors?.next || "");
        if (!nextCursor) break;
        cursor = nextCursor;
    }

    return all.map(_normalizeStaffMember).filter(Boolean);
}

/**
 * Resolves a native Bookings resourceId through the documented staff-member
 * query. resourceId is not the staffMemberId, so getStaffMember(id) is not
 * valid for this lookup.
 */
async function _fetchStaffByResourceId(resourceId, traceId) {
    const id = _safeTrim(resourceId);
    if (!id || !isValidGuid(id)) return null;

    const cached = _cacheGet(`staff:rid:${id}`);
    if (cached) return cached;

    try {
        const staff = await _queryStaffMembers({
            filter: { resourceId: { $eq: id } },
            traceId,
        });
        const nativeStaff = staff.find((item) => item.resourceId === id) || null;
        const found = nativeStaff ? await _attachCanonicalMapping(nativeStaff, traceId) : null;
        if (found) _indexStaff(found);
        return found;
    } catch (error) {
        log.warn("_fetchStaffByResourceId failed", {
            resourceId: id,
            traceId,
            error: error?.message,
        });
        return null;
    }
}

/**
 * Loads native staff profiles and indexes resource/contact identifiers.
 */
async function _fetchAllStaff(traceId) {
    const cacheKey = "staff:__ALL__";
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const nativeStaff = await _queryStaffMembers({ traceId });
        const all = await Promise.all(nativeStaff.map(staff => _attachCanonicalMapping(staff, traceId)));
        for (const staff of all) _indexStaff(staff);
        _cacheSet(cacheKey, all);
        return all;
    } catch (error) {
        log.warn("_fetchAllStaff failed", { traceId, error: error?.message });
        return [];
    }
}

// =============================================================================
// API PUBLICA
// =============================================================================

export async function findStaffByContactId(contactId, traceId = null) {
    const id = _safeTrim(contactId);
    if (!isValidGuid(id)) return null;

    const cached = _cacheGet(`staff:contact:${id}`);
    if (cached) return cached;

    const all = await _fetchAllStaff(traceId);
    const found = all.find((staff) => staff.contactId === id) || null;
    if (found) _indexStaff(found);
    return found;
}

export async function findStaffByResourceId(resourceId, traceId = null) {
    return _fetchStaffByResourceId(resourceId, traceId);
}

export async function getSiteMemberIdByContactId(contactId, traceId = null) {
    const id = _safeTrim(contactId);
    if (!isValidGuid(id)) return "";

    const cacheKey = `staff:site-member:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached && isValidGuid(cached)) return cached;

    try {
        const response = await withTimeout(
            getContactElevated(id),
            API_TIMEOUT_MS,
            "CRM.contactsV5.getContact"
        );
        const contact = response?.contact || response;
        const memberId = _safeTrim(contact?.memberInfo?.memberId || "");
        if (!isValidGuid(memberId)) return "";
        _cacheSet(cacheKey, memberId);
        return memberId;
    } catch (error) {
        log.warn("getSiteMemberIdByContactId failed", {
            traceId,
            error: error?.message,
        });
        return "";
    }
}

export async function getStaffScheduleId(resourceId, traceId = null) {
    const staff = await findStaffByResourceId(resourceId, traceId);
    return staff ? _safeTrim(staff.scheduleId) || null : null;
}

export async function listStaff(traceId = null) {
    return _fetchAllStaff(traceId);
}

/**
 * Nombre visible de staff. Fallback a STAFF_DEFAULT_NAME (SSOT internalConfig).
 */
export function getStaffDisplayName(staff) {
    if (!staff) return STAFF_DEFAULT_NAME;
    return _safeTrim(staff.displayName) || STAFF_DEFAULT_NAME;
}
