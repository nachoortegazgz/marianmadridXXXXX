/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v2.0-UNIFIED
BASE: v1.x + unificacion completa. Eliminada dualidad DAL/wix-data.
RESPONSIBILITY: Capa unica de acceso a datos CMS. Todos los modulos
  backend importan desde aqui. Ningun modulo importa wix-data directamente
  (excepto data.js para hooks).
STANDARDS: G10 ASCII Strict. Cero suppressAuth. Elevacion explicita
  via auth.elevate() cuando sea necesaria.
CONTRATO:
  - queryFirstItem(params) -> item | null
  - queryItems(params) -> { items, totalCount, hasNext, next }
  - insertItem(collection, item) -> item
  - updateItem(collection, item) -> item
  - removeItem(collection, id) -> void
  - getItem(collection, id) -> item | null
  - countItems(collection, filter) -> number
  - wql (re-export de wix-data wql para filtros)
  - CONSISTENCY (enum de opciones de lectura)
NOTAS:
  - No existe suppressAuth. Si una operacion requiere elevacion, el
    llamante usa auth.elevate() de @wix/essentials sobre la funcion
    correspondiente.
  - CONSISTENCY.STRONG equivale a consistencyMode:"strong".
  - CONSISTENCY.EVENTUAL equivale a consistencyMode:"eventual".
  - Los filtros se construyen con wql.eq(), wql.in(), etc.
DEPENDENCIAS: wix-data (nativo).
=============================================================================
*/

import wixData from "wix-data";
/* DA-ELEV-01 (PEND-D1 cierre definitivo, 2026-10): la elevacion era
   responsabilidad del llamante pero NINGUN consumidor de esta capa usaba
   auth.elevate sobre wix-data; fiscalDocuments.web.js pasaba aun
   suppressAuth:true al adaptador legacy, que lo ignora desde que se
   elimino el relleno automatico -> las operaciones admin-only
   (collection con permisos restringidos) fallaban en runtime para
   site members no-admin. Se centraliza aqui la elevacion incondicional
   (identidad del backend), conforme a ADR-T06 y a la cabecera R1/R5.
   En Velo los hooks (backend/data.js) se ejecutan SIEMPRE bajo identidad
   elevada: ni elevate ni options los eximen (semantica verificada por
   el harness offline, loader.mjs). */
import { auth } from "@wix/essentials";

const elevatedQuery = auth.elevate(wixData.query);
const elevatedGet = auth.elevate(wixData.get);
const elevatedInsert = auth.elevate(wixData.insert);
const elevatedUpdate = auth.elevate(wixData.update);
const elevatedRemove = auth.elevate(wixData.remove);
const elevatedSave = auth.elevate(wixData.save);
const elevatedBulkInsert = auth.elevate(wixData.bulkInsert);
const elevatedBulkUpdate = auth.elevate(wixData.bulkUpdate);
const elevatedBulkRemove = auth.elevate(wixData.bulkRemove);
const elevatedQueryReferencedItems = auth.elevate(wixData.queryReferencedItems);

// =============================================================================
// ENUMS Y CONSTANTES
// =============================================================================

export const CONSISTENCY = Object.freeze({
    STRONG: "strong",
    EVENTUAL: "eventual",
});

// DAL-WQL-01 (fix derivado de tests E2E 2026-10-14): re-export de wql para
// que los consumidores no importen wix-data. ANTES era literalmente el SDK
// ("export const wql = wixData"), lo que provocaba "wql.eq is not a function"
// en tiempo de ejecucion: el paquete wix-data NO expone .eq/.in/.hasSome como
// funciones de modulo (eso es el builder WixDataQuery). dataLegacyAdapter y
// reservas.web.js usan la convencion de clausulas pureas wql.eq(field, value)
// -> { [field]: { $eq: value } } compatible con queryItems(filter) del SDK v2
// (query().filter(clause)). Se construye aqui el factory canonico; sin estado,
// sin efectos, composition via $and verificada contra el matcher del harness.
const _wqlFieldClause = (field, op, value) => ({ [String(field)]: { [op]: value } });

export const wql = Object.freeze({
    eq: (field, value) => _wqlFieldClause(field, '$eq', value),
    ne: (field, value) => _wqlFieldClause(field, '$ne', value),
    gt: (field, value) => _wqlFieldClause(field, '$gt', value),
    gte: (field, value) => _wqlFieldClause(field, '$gte', value),
    lt: (field, value) => _wqlFieldClause(field, '$lt', value),
    lte: (field, value) => _wqlFieldClause(field, '$lte', value),
    in: (field, values) => _wqlFieldClause(field, '$in', Array.isArray(values) ? values : [values]),
    hasSome: (field, values) => _wqlFieldClause(field, '$hasSome', Array.isArray(values) ? values : [values]),
    startsWith: (field, value) => _wqlFieldClause(field, '$startsWith', value),
    and: (...clauses) => ({ $and: clauses.filter(Boolean) }),
    or: (...clauses) => ({ $or: clauses.filter(Boolean) }),
});

// DA-SORT-01 (fix derivado de tests 2026-10-14): helper de ordenacion para
// queryItems. Cada entrada es { fieldName, direction: 'ASC'|'DESC' }.
// dataLegacyAdapter (LegacyQueryBuilder.ascending/descending) y cualquier
// consumidor futuro construyen aqui el array `sort` canonico del SDK v2.
export const order = Object.freeze({
    asc: (fieldName) => [{ fieldName, direction: 'ASC' }],
    desc: (fieldName) => [{ fieldName, direction: 'DESC' }],
});

// DA-QRI-01 (fix derivado de tests 2026-10-14): envoltura uniforme de
// wixData.queryReferencedItems(). Devuelve SIEMPRE un array de items
// resueltos (el SDK legacy responde { items: [...] }; se normaliza para
// que dataLegacyAdapter y staff.js compartan una unica forma).
export async function queryReferencedItems(collection, id, fieldName, consistency) {
    const options = _buildOptions(consistency);
    const res = await elevatedQueryReferencedItems(collection, id, fieldName, options);
    if (Array.isArray(res)) return res;
    return res?.items || [];
}

// =============================================================================
// HELPERS INTERNOS
// =============================================================================

function _buildOptions(consistency) {
    if (!consistency) return {};
    return { consistencyMode: consistency };
}

// =============================================================================
// LECTURA
// =============================================================================

/**
 * Devuelve el primer item que cumple el filtro, o null.
 * @param {Object} params
 * @param {string} params.dataCollectionId - Nombre de la coleccion
 * @param {Object} params.filter - Filtro wql (ej: wql.eq("field", value))
 * @param {string} [params.consistency] - CONSISTENCY.STRONG | EVENTUAL
 * @returns {Promise<Object|null>}
 */
export async function queryFirstItem({ dataCollectionId, filter, consistency }) {
    const options = _buildOptions(consistency);
    const result = await elevatedQuery(dataCollectionId)
        .filter(filter)
        .limit(1)
        .find(options);
    return result?.items?.[0] || null;
}

/**
 * Devuelve pagina de items con soporte de paginacion.
 * @param {Object} params
 * @param {string} params.dataCollectionId
 * @param {Object} params.filter
 * @param {number} [params.limit=100]
 * @param {number} [params.offset=0]
 * @param {string} [params.consistency]
 * @returns {Promise<{items: Array, totalCount: number, hasNext: boolean, next: Function|null}>}
 */
export async function queryItems({
    dataCollectionId,
    filter,
    sort,
    limit = 100,
    offset = 0,
    consistency,
}) {
    const options = _buildOptions(consistency);
    let query = elevatedQuery(dataCollectionId)
        .filter(filter);
    // DA-SORT-02: propagacion de ordenacion (array {fieldName,direction}).
    if (Array.isArray(sort) && sort.length > 0) {
        query = query.ascending(...sort.map((s) => s.fieldName));
    }
    query = query.limit(limit).skip(offset);

    const result = await query.find(options);
    const items = result?.items || [];
    const totalCount = result?.totalCount || items.length;
    const hasNext = items.length === limit;

    return {
        items,
        totalCount,
        hasNext,
        next: hasNext
            ? async () =>
                  queryItems({
                      dataCollectionId,
                      filter,
                      limit,
                      offset: offset + limit,
                      consistency,
                  })
            : null,
    };
}

/**
 * Obtiene un item por ID, o null si no existe.
 * @param {string} collection
 * @param {string} id
 * @param {string} [consistency]
 * @returns {Promise<Object|null>}
 */
export async function getItem(collection, id, consistency) {
    const options = _buildOptions(consistency);
    try {
        return await elevatedGet(collection, id, options);
    } catch (err) {
        // WDE0073 = item not found
        if (String(err?.message || "").includes("WDE0073")) {
            return null;
        }
        throw err;
    }
}

/**
 * Cuenta items que cumplen el filtro.
 * @param {string} collection
 * @param {Object} filter
 * @param {string} [consistency]
 * @returns {Promise<number>}
 */
export async function countItems(collection, filter, consistency) {
    const options = _buildOptions(consistency);
    const result = await elevatedQuery(collection)
        .filter(filter)
        .count(options);
    return result || 0;
}

// =============================================================================
// ESCRITURA
// =============================================================================

/**
 * Inserta un item en la coleccion.
 * @param {string} collection
 * @param {Object} item
 * @returns {Promise<Object>} Item insertado con _id
 */
export async function insertItem(collection, item) {
    return elevatedInsert(collection, item);
}

/**
 * Actualiza un item existente. Requiere _id en el item.
 * @param {string} collection
 * @param {Object} item - Debe incluir _id
 * @returns {Promise<Object>} Item actualizado
 */
export async function updateItem(collection, item) {
    return elevatedUpdate(collection, item);
}

/**
 * Elimina un item por ID.
 * @param {string} collection
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function removeItem(collection, id) {
    await elevatedRemove(collection, id);
}

/**
 * Guarda un item (insert o update segun exista _id).
 * @param {string} collection
 * @param {Object} item
 * @returns {Promise<Object>}
 */
export async function saveItem(collection, item) {
    return elevatedSave(collection, item);
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

/**
 * Insercion masiva. Devuelve resultado con inserted/failed counts.
 * @param {string} collection
 * @param {Array<Object>} items
 * @returns {Promise<Object>}
 */
export async function bulkInsert(collection, items) {
    return elevatedBulkInsert(collection, items);
}

/**
 * Actualizacion masiva. Devuelve resultado con updated/failed counts.
 * @param {string} collection
 * @param {Array<Object>} items - Cada item debe incluir _id
 * @returns {Promise<Object>}
 */
export async function bulkUpdate(collection, items) {
    return elevatedBulkUpdate(collection, items);
}

/**
 * Eliminacion masiva por IDs.
 * @param {string} collection
 * @param {Array<string>} ids
 * @returns {Promise<Object>}
 */
export async function bulkRemove(collection, ids) {
    return elevatedBulkRemove(collection, ids);
}
