import sys

def edit(path, old, new, label):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if old not in content:
        print(f"FAIL [{label}]: pattern not found in {path}")
        sys.exit(1)
    if content.count(old) != 1:
        print(f"FAIL [{label}]: pattern found {content.count(old)} times in {path}")
        sys.exit(1)
    content = content.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"OK  [{label}] {path}")

# ============================================================================
# 1. bookingUtils.js: pickStaffByLowestLoad (0 consumidores)
# ============================================================================
edit(
    "src/backend/booking/bookingUtils.js",
    """export function pickStaffByLowestLoad(candidateIds, loadByResourceId) {
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


/**
 * Rank available staff by already-booked minutes""",
    """/**
 * Rank available staff by already-booked minutes""",
    "bookingUtils/pickStaffByLowestLoad",
)

# ============================================================================
# 2. bookingUtils.js: resolveLinkedPhase2Duration (0 consumidores)
# ============================================================================
edit(
    "src/backend/booking/bookingUtils.js",
    """// ============================================================================
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

        report("resolveLinkedPhase2Duration: servicio F2 sin phase2Duration valida", {
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
// ADD-ONS (UTILS-09/10)""",
    """// ============================================================================
// ADD-ONS (UTILS-09/10)""",
    "bookingUtils/resolveLinkedPhase2Duration",
)

# ============================================================================
# 3. bookingUtils.js: resolveAddOnIds (0 consumidores) + normalizeCatalogAddOn
#    pasa a interna (solo la consumian resolveAddOnIds y calculateBookingAmount)
# ============================================================================
edit(
    "src/backend/booking/bookingUtils.js",
    "export function normalizeCatalogAddOn(addOn) {",
    "function normalizeCatalogAddOn(addOn) {",
    "bookingUtils/normalizeCatalogAddOn-private",
)
edit(
    "src/backend/booking/bookingUtils.js",
    """export function resolveAddOnIds(catalogAddOns, requestedIds, maxPerBooking) {
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

/* CERO-DEUDA H-07 (2026-10-20): alias export const resolveNativeAddOnIds
   eliminado (0 consumidores verificados con grep -rw en todo src/). */""",
    """/* CERO-DEUDA H-07 (2026-10-20): alias export const resolveNativeAddOnIds
   eliminado (0 consumidores verificados con grep -rw en todo src/).
   CERO-DEUDA SSOT-SCAN (2026-10-23): resolveAddOnIds eliminado (0
   consumidores; la normalizacion real de complementos en la saga la
   ejecuta _detectAddons en bookingSaga.js). */""",
    "bookingUtils/resolveAddOnIds",
)

# ============================================================================
# 4. bookingCore.js: claimTransaction (0 consumidores)
# ============================================================================
edit(
    "src/backend/booking/bookingCore.js",
    """export async function claimTransaction(
    pairToken,
    newOwnerExecutionId,
    newTraceId
) {
    const id = _safeTrim(pairToken);
    if (!id) return { ok: false, reason: "INVALID_PAIR_TOKEN" };

    const current = await _getTransactionById(id);
    if (!current) return { ok: false, reason: "NOT_FOUND" };

    const tx = _readTransaction(current);

    if (tx.status === "COMPLETED") {
        return { ok: false, reason: "ALREADY_COMPLETED" };
    }

    const leaseExpiresAt = tx.leaseExpiresAt;
    if (leaseExpiresAt && leaseExpiresAt.getTime() > Date.now()) {
        return { ok: false, reason: "LEASE_NOT_EXPIRED" };
    }

    const now = new Date();
    const newState = {
        status: "IN_PROGRESS",
        payloadHash: tx.payloadHash,
        ownerTraceId: String(newTraceId || ""),
        ownerExecutionId: String(newOwnerExecutionId || ""),
        leaseExpiresAt: new Date(now.getTime() + TRANSACTION_LEASE_MS),
        heartbeatAt: now,
        attempt: tx.attempt + 1,
        bookingId: tx.bookingId,
    };

    try {
        await elevatedUpdate(
            TRANSACTIONS_COL,
            _buildTransactionControl(id, newState, current)
        );
        return {
            ok: true,
            transaction: _readTransaction(await _getTransactionById(id)),
        };
    } catch (error) {
        if (_isRevisionConflictError(error)) {
            return { ok: false, reason: "CLAIM_RACE" };
        }
        log.error("claimTransaction: update failed", {
            pairToken: id,
            error: error && error.message,
        });
        return { ok: false, reason: ERROR_CODES.DATABASE_ERROR };
    }
}

export async function _completeTransaction(pairToken, result, traceId) {""",
    """export async function _completeTransaction(pairToken, result, traceId) {""",
    "bookingCore/claimTransaction",
)

# ============================================================================
# 5. bookingCore.js: _extractResourceIdsFromSlot (wrapper muerto) +
#    _projectCertifiedSlot (proyeccion en desuso)
# ============================================================================
edit(
    "src/backend/booking/bookingCore.js",
    """// =============================================================================
// BLOQUE 14 - RESOURCEIDS DESDE SLOTS
// =============================================================================
export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 15 - CONTIGUIDAD / GAP""",
    """// =============================================================================
// BLOQUE 15 - CONTIGUIDAD / GAP""",
    "bookingCore/_extractResourceIdsFromSlot",
)
edit(
    "src/backend/booking/bookingCore.js",
    """// =============================================================================
// BLOQUE 16 - PROYECCION SLOTS
// =============================================================================
export function _projectCertifiedSlot(slot, resourceId) {
    const normalized = normalizeAvailabilitySlot(slot);
    if (!normalized) return null;
    const serviceId = _safeTrim(normalized.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;
    const resourceCandidate =
        normalized.resource && typeof normalized.resource === "object"
            ? normalized.resource
            : {};
    const resourceIdClean = _safeTrim(
        resourceId || normalized.resourceId || resourceCandidate.id
    );
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
    const localStartDate = normalized.localStartDate;
    const localEndDate = normalized.localEndDate;
    if (!localStartDate || !localEndDate) return null;
    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);
    if (
        !startDateUtc ||
        !endDateUtc ||
        endDateUtc.getTime() <= startDateUtc.getTime()
    ) {
        return null;
    }
    const slotLocation =
        normalized.location && typeof normalized.location === "object"
            ? normalized.location
            : {};
    const location = _resolveWriteLocation(slotLocation, null);
    if (!location) return null;
    const nestedSlot = normalized.slot && typeof normalized.slot === "object" ? normalized.slot : {};
    return {
        serviceId: serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(normalized.scheduleId || nestedSlot.scheduleId),
        localStartDate: localStartDate,
        localEndDate: localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: normalized.bookable === true,
        availableResources: _extractResourceIdsFromSlot(normalized),
        timezone: _safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
        locationId: location.id,
        locationName: _safeTrim(slotLocation.name),
        formattedAddress: _safeTrim(slotLocation.formattedAddress),
    };
}

// CERO-DEUDA ZC-07: eliminado _projectWriterSlotFromAvailability
// (0 consumidores fuera de su propia definicion; el flujo de escritura usa
// _projectCertifiedSlot directamente).

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANONICO""",
    """// CERO-DEUDA ZC-07: eliminados _projectWriterSlotFromAvailability y
// _projectCertifiedSlot (SSOT-SCAN 2026-10-23, 0 consumidores; el flujo de
// escritura consume directamente los slots pristinos).

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANONICO""",
    "bookingCore/_projectCertifiedSlot",
)

# ============================================================================
# 6. bookingCore.js: alias redundante _buildLockKeys
# ============================================================================
edit(
    "src/backend/booking/bookingCore.js",
    """export const _buildLockKeys = buildLockKeys;
export function buildLockKeys(phases, resourceId) {""",
    """export function buildLockKeys(phases, resourceId) {""",
    "bookingCore/_buildLockKeys-alias",
)

# ============================================================================
# 7. bookingSaga.js: consume buildLockKeys por su nombre canonico
# ============================================================================
edit(
    "src/backend/booking/bookingSaga.js",
    "    _buildLockKeys,",
    "    buildLockKeys,",
    "bookingSaga/import-buildLockKeys",
)
edit(
    "src/backend/booking/bookingSaga.js",
    "        lockKeys = _buildLockKeys(phases, finalResourceId);",
    "        lockKeys = buildLockKeys(phases, finalResourceId);",
    "bookingSaga/call-buildLockKeys",
)

# ============================================================================
# 8. bookingSaga.js: doble export normalizePersistedMeta
# ============================================================================
edit(
    "src/backend/booking/bookingSaga.js",
    """}
export { _normalizePersistedMeta as normalizePersistedMeta };

// =============================================================================
// BLOCK 3 - UTILIDADES""",
    """}

// =============================================================================
// BLOCK 3 - UTILIDADES""",
    "bookingSaga/normalizePersistedMeta-alias",
)

# ============================================================================
# 9. reservas.web.js: getServiceForBookingInternal (wrapper, 0 llamadas)
# ============================================================================
edit(
    "src/backend/reservas.web.js",
    """export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return _getServiceBySlugOrIdInternal(serviceId, traceId || makeTraceId("service-internal"));
}


/* Public catalog read path:""",
    """/* Public catalog read path:""",
    "reservas/getServiceForBookingInternal",
)

# ============================================================================
# 10. security.js: isEstilista, isKeyPersistentlyBlocked, test hook
# ============================================================================
edit(
    "src/backend/security.js",
    """export async function isEstilista(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.contactId) {
        return false;
    }

    const staff = await _resolveStaffByIdentity(memberInfo, traceId);

    return _readStaffRole(staff) === ROL_WEBSITE.ESTILISTA;
}

export async function isStaffCollaborator(traceId = null) {""",
    """export async function isStaffCollaborator(traceId = null) {""",
    "security/isEstilista",
)
edit(
    "src/backend/security.js",
    """export async function isKeyPersistentlyBlocked(surface, key) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    if (!normalizedSurface || !normalizedKey) {
        return false;
    }

    try {
        const result = await dalQuery(RATE_LIMIT_BLOCKS_COL())
            .eq("surface", normalizedSurface)
            .eq("key", normalizedKey)
            .gt("expiresAt", new Date())
            .limit(1)
            .find(STRONG_READ);

        return Array.isArray(result?.items) && result.items.length > 0;
    } catch (error) {
        log.error("Persistent block lookup failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
        });

        return false;
    }
}

// RATE_LIMIT_BLOCKS no esta en BUSINESS_COLLECTIONS v12.0.""",
    """// RATE_LIMIT_BLOCKS no esta en BUSINESS_COLLECTIONS v12.0.""",
    "security/isKeyPersistentlyBlocked",
)
edit(
    "src/backend/security.js",
    """/**
 * Test-harness API (offline suites only). Clears the in-memory rate-limit cache.
 * Never invoked by production webMethods; safe because RATE_LIMIT_CACHE is
 * module-scoped and rebuilt lazily on next request.
 */
export function _resetRateLimitCacheForTests() {
    RATE_LIMIT_CACHE.clear();
    // SEC-R3-04: el cache LRU de staff.js persista entre requests del
    // harness; debe invalidarse junto al rate-limit para tests deterministas.
    _invalidateStaffCache();
}

export async function requireMarianManager(traceId = null) {""",
    """export async function requireMarianManager(traceId = null) {""",
    "security/_resetRateLimitCacheForTests",
)

# ============================================================================
# 11. staff.js: listStaff (0 consumidores)
# ============================================================================
edit(
    "src/backend/staff.js",
    """export async function listStaff(traceId = null) {
    return _fetchAllStaff(traceId);
}

/**
 * Nombre visible de staff.""",
    """/**
 * Nombre visible de staff.""",
    "staff/listStaff",
)

# ============================================================================
# 12. securityEngine.js: verifyTimeclockSignature (0 consumidores)
# ============================================================================
edit(
    "src/backend/securityEngine.js",
    """
export async function verifyTimeclockSignature(record, key = null) {
    try {
        const provided = _toString(record?.signature);
        if (!HEX_64_PATTERN.test(provided)) {
            return false;
        }
        const expected = await signTimeclockRecord(record, key);
        return timingSafeEqual(provided, expected);
    } catch (error) {
        log.error("verifyTimeclockSignature failed", {
            message: error?.message || String(error),
        });
        return false;
    }
}""",
    "",
    "securityEngine/verifyTimeclockSignature",
)

# ============================================================================
# 13. dataAccess.js: bulkInsert/bulkUpdate/bulkRemove/queryReferencedItems
#     (0 consumidores) + factories elevados asociados
# ============================================================================
edit(
    "src/backend/dataAccess.js",
    """const elevatedSave = auth.elevate(wixData.save);
const elevatedBulkInsert = auth.elevate(wixData.bulkInsert);
const elevatedBulkUpdate = auth.elevate(wixData.bulkUpdate);
const elevatedBulkRemove = auth.elevate(wixData.bulkRemove);
const elevatedQueryReferencedItems = auth.elevate(
    wixData.queryReferencedItems
);""",
    """const elevatedSave = auth.elevate(wixData.save);""",
    "dataAccess/elevated-factories",
)
edit(
    "src/backend/dataAccess.js",
    """export async function queryReferencedItems(
    collection,
    id,
    fieldName,
    consistency
) {
    const result = await elevatedQueryReferencedItems(
        collection,
        id,
        fieldName,
        buildOptions(consistency)
    );
    return Array.isArray(result) ? result : result?.items || [];
}

export async function queryFirstItem({""",
    """export async function queryFirstItem({""",
    "dataAccess/queryReferencedItems",
)
edit(
    "src/backend/dataAccess.js",
    """export function bulkInsert(collection, items) {
    return elevatedBulkInsert(collection, items);
}

export function bulkUpdate(collection, items) {
    return elevatedBulkUpdate(collection, items);
}

export function bulkRemove(collection, ids) {
    return elevatedBulkRemove(collection, ids);
}""",
    """/* CERO-DEUDA SSOT-SCAN (2026-10-23): bulkInsert/bulkUpdate/bulkRemove y
   queryReferencedItems eliminados (0 consumidores; el 100% de las mutaciones
   se ejecutan via insertItem/updateItem/saveItem/removeById). */""",
    "dataAccess/bulk-*",
)

# ============================================================================
# 14. eventLog.js: reconciliarProyecciones (cron desconectado) + default export
# ============================================================================
edit(
    "src/backend/eventLog.js",
    """// ============================================================================
// SECCION 8 - RECONCILIACION (cron)
// ============================================================================

export async function reconciliarProyecciones() {
    const traceId = makeTraceId("recon");
    let processed = 0;
    let failed = 0;
    try {
        const pending = await dalQuery(MOVIMIENTOS_CAJA_COL)
            .ne("projectionStatus", PROJECTION_STATUS.OK)
            .descending("sequenceNumber")
            .limit(PROYECCION_BATCH_LIMIT)
            .find();

        for (const evento of pending.items || []) {
            try {
                await withTimeout(
                    () => _proyectarSegunTipoEvento(evento, [], traceId),
                    PROYECCION_TIMEOUT_MS,
                    "reconciliarProyecciones"
                );
                processed += 1;
            } catch (err) {
                failed += 1;
                log.warn("Reconciliacion fallo", {
                    traceId,
                    eventoId: evento._id,
                    message: err?.message,
                });
            }
        }

        return {
            status: "SUCCESS",
            data: { processed, failed, total: pending.items?.length || 0 },
        };
    } catch (err) {
        log.error("reconciliarProyecciones fallo global", { traceId, message: err?.message });
        return {
            status: "ERROR",
            data: { processed, failed },
            error: { code: "RECON_FAIL", message: err?.message },
        };
    }
}

// ============================================================================
// EXPORTS""",
    """// CERO-DEUDA SSOT-SCAN (2026-10-23): eliminada reconciliarProyecciones()
// (cron desconectado: no registrada en jobs.config ni importada en crons.js).

// ============================================================================
// EXPORTS""",
    "eventLog/reconciliarProyecciones",
)
edit(
    "src/backend/eventLog.js",
    """export default {
    registrarEventoEconomico,
    _getNextSequenceInternal,
    getEventoPorId,
    reconciliarProyecciones,
};""",
    """export default {
    registrarEventoEconomico,
    _getNextSequenceInternal,
    getEventoPorId,
};""",
    "eventLog/default-export",
)

# ============================================================================
# 15. fiscalDocuments.web.js: prepareScheduledManagerPackages (cron desconectado)
# ============================================================================
edit(
    "src/backend/fiscalDocuments.web.js",
    """export async function prepareScheduledManagerPackages(options = {}) {
  const traceId = options.traceId || makeTraceId("cron-packages");
  try {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.floor((now.getMonth() + 3) / 3);
    const created = await createManagerPackageVersion({ year, quarter });
    return { status: "SUCCESS", data: created?.data || null, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SCHEDULED_PACKAGES_FAIL") };
  }
}""",
    """/* CERO-DEUDA SSOT-SCAN (2026-10-23): eliminada
   prepareScheduledManagerPackages() (cron desconectado: no registrada en
   jobs.config ni importada en crons.js). La generacion de paquetes de
   gestoria se ejecuta on-demand via createManagerPackageVersion. */""",
    "fiscalDocuments/prepareScheduledManagerPackages",
)

# ============================================================================
# 16. data.js: alias deprecated readRecordHash (0 consumidores externos)
# ============================================================================
edit(
    "src/backend/data.js",
    """/** @deprecated Alias de dominio contable; para MovimientosCaja usa readMovementHash. */
export const readRecordHash = readMovementHash;

""",
    "",
    "data/readRecordHash-alias",
)

# ============================================================================
# 17. qrHelper.js: alias buildVerifactuQrUrl (0 consumidores)
# ============================================================================
edit(
    "src/public/qrHelper.js",
    """ * @alias buildVerifactuQrUrl - nombre esperado por consumidores externos
 *   (p. ej. ConfirmacionReserva.q5vps.js tras reemision v5010.1).
 */""",
    """ */""",
    "qrHelper/jsdoc-alias",
)
edit(
    "src/public/qrHelper.js",
    """/**
 * Alias canonico v5010.1: buildVerifactuQrUrl(params) -> URL QR AEAT.
 * Exportado porque los modulos de pagina (ConfirmacionReserva.q5vps.js)
 * lo referencian bajo este nombre tras la reemision FASE7.
 */
export const buildVerifactuQrUrl = generateVerifactuQrUrl;

""",
    "",
    "qrHelper/buildVerifactuQrUrl-alias",
)

# ============================================================================
# 18. fiscalAggregator.web.js: __test__ hook en modulo de produccion
# ============================================================================
edit(
    "src/backend/fiscalAggregator.web.js",
    """// =============================================================================
// BLOQUE 5 - TEST HOOK (no es superficie publica Velo; solo consumo offline)
// =============================================================================
export const __test__ = {
  readTaxableAmount: _readTaxableAmount,
  readTaxAmount: _readTaxAmount,
  readTaxRate: _readTaxRate,
  readRecordHash: _readRecordHash,
  getBusinessTaxId: _getBusinessTaxId,
};""",
    """// CERO-DEUDA SSOT-SCAN (2026-10-23): eliminado el bloque __test__ (hook de
// testing en modulo de produccion). Las suites offline deben replicar la
// logica minima de lectura sobre backend/data (SSOT de lectura del ledger).""",
    "fiscalAggregator/__test__",
)

print("ALL EDITS APPLIED")
