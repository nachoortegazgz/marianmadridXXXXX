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

// =============================================================================
// ENUMS Y CONSTANTES
// =============================================================================

export const CONSISTENCY = Object.freeze({
    STRONG: "strong",
    EVENTUAL: "eventual",
});

// Re-export de wql para que los consumidores no importen wix-data
export const wql = wixData;

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
    const result = await wixData
        .query(dataCollectionId)
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
    limit = 100,
    offset = 0,
    consistency,
}) {
    const options = _buildOptions(consistency);
    let query = wixData
        .query(dataCollectionId)
        .filter(filter)
        .limit(limit)
        .skip(offset);

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
        return await wixData.get(collection, id, options);
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
    const result = await wixData
        .query(collection)
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
    return wixData.insert(collection, item);
}

/**
 * Actualiza un item existente. Requiere _id en el item.
 * @param {string} collection
 * @param {Object} item - Debe incluir _id
 * @returns {Promise<Object>} Item actualizado
 */
export async function updateItem(collection, item) {
    return wixData.update(collection, item);
}

/**
 * Elimina un item por ID.
 * @param {string} collection
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function removeItem(collection, id) {
    await wixData.remove(collection, id);
}

/**
 * Guarda un item (insert o update segun exista _id).
 * @param {string} collection
 * @param {Object} item
 * @returns {Promise<Object>}
 */
export async function saveItem(collection, item) {
    return wixData.save(collection, item);
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
    return wixData.bulkInsert(collection, items);
}

/**
 * Actualizacion masiva. Devuelve resultado con updated/failed counts.
 * @param {string} collection
 * @param {Array<Object>} items - Cada item debe incluir _id
 * @returns {Promise<Object>}
 */
export async function bulkUpdate(collection, items) {
    return wixData.bulkUpdate(collection, items);
}

/**
 * Eliminacion masiva por IDs.
 * @param {string} collection
 * @param {Array<string>} ids
 * @returns {Promise<Object>}
 */
export async function bulkRemove(collection, ids) {
    return wixData.bulkRemove(collection, ids);
}
