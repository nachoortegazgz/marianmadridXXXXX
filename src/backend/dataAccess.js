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
// DA-BUILDER-01 (PEND-DAL cierre, 2026-10): factory canonico de consultas.
// Sustituye al builder legacy eliminado (dataLegacyAdapter). Encapsula la
// elevacion (DA-ELEV-01) y ofrece paginacion continua hasNext()/next(),
// exactamente como WixDataQuery oficial. Cada operador devuelve una NUEVA
// instancia inmutable (semantica del SDK real). Sin suppressAuth, sin
// suppressHooks: los hooks de backend/data.js se ejecutan siempre (R2/SSOT-14).
class QueryBuilder {
    constructor(dataCollectionId, clauses = [], sort = [], limit = undefined, offset = 0, consistency = null) {
        this._col = dataCollectionId;
        this._clauses = clauses;
        this._sort = sort;
        this._limit = limit;
        this._offset = offset;
        /* DA-QB-CONS: consistencia declarable en la cadena (find({consistencyMode})
         * y .consistent() sobre el builder canonico), como WixDataQuery oficial. */
        this._consistency = consistency;
    }
    _with(patch) {
        return new QueryBuilder(
            this._col,
            patch.clauses ?? this._clauses,
            patch.sort ?? this._sort,
            patch.limit !== undefined ? patch.limit : this._limit,
            patch.offset !== undefined ? patch.offset : this._offset,
            patch.consistency !== undefined ? patch.consistency : this._consistency,
        );
    }
    consistent() { return this._with({ consistency: CONSISTENCY.STRONG }); }
    _add(clause) { return this._with({ clauses: [...this._clauses, clause] }); }
    eq(field, value) { return this._add(wql.eq(field, value)); }
    ne(field, value) { return this._add(wql.ne(field, value)); }
    gt(field, value) { return this._add(wql.gt(field, value)); }
    gte(field, value) { return this._add(wql.gte(field, value)); }
    lt(field, value) { return this._add(wql.lt(field, value)); }
    lte(field, value) { return this._add(wql.lte(field, value)); }
    hasSome(field, values) { return this._add(wql.hasSome(field, Array.isArray(values) ? values : [values])); }
    in(field, values) { return this.hasSome(field, values); }
    startsWith(field, value) { return this._add(wql.startsWith(field, value)); }
    contains(field, value) {
        // Equivalente SDK v2 verificado: $hasSome para arrays de referencia
        // (*Id/*Ids, p.ej. linkedBookingIds); prefijo para texto escalar
        // (p.ej. productName en busqueda de inventario — UX de autocomplete).
        const fname = String(field);
        if (/Ids?$/.test(fname)) return this.hasSome(field, [value]);
        return this.startsWith(field, value);
    }
    ascending(...fields) { return this._with({ sort: [...this._sort, ...fields.map((f) => `${f} ASC`)] }); }
    descending(...fields) { return this._with({ sort: [...this._sort, ...fields.map((f) => `${f} DESC`)] }); }
    limit(n) { return this._with({ limit: n }); }
    skip(n) { return this._with({ offset: n }); }
    _filter() {
        if (this._clauses.length === 0) return undefined;
        if (this._clauses.length === 1) return this._clauses[0];
        return wql.and(...this._clauses);
    }
    async find(options) {
        /* DA-QB-CONS: acepta el options de WixDataQuery.find({consistencyMode}). */
        const consistency =
            (options && options.consistencyMode) || this._consistency || undefined;
        const res = await this._runPage(this._offset, consistency);
        return this._pageResult(res, this._offset);
    }
    _runPage(offset, consistency) {
        return queryItems({
            dataCollectionId: this._col,
            filter: this._filter(),
            sort: this._sort,
            limit: this._limit,
            offset,
            consistency,
        });
    }
    _pageResult(res, offset) {
        const self = this;
        const items = res.items || [];
        const total = res.totalCount != null ? res.totalCount : offset + items.length;
        return {
            items,
            length: items.length,
            totalCount: total,
            hasNext: () => offset + items.length < total,
            next: async () => {
                if (!items.length) return self._pageResult({ items: [], totalCount: total }, offset);
                return self._pageResult(await self._runPage(offset + items.length), offset + items.length);
            },
        };
    }
    async count() {
        const res = await queryItems({
            dataCollectionId: this._col,
            filter: this._filter(),
            limit: 1,
            offset: 0,
        });
        return res.totalCount != null ? res.totalCount : 0;
    }
}

export function query(dataCollectionId) {
    return new QueryBuilder(dataCollectionId);
}

/**
 * Pagina de items con soporte de paginacion (primitiva interna; consumidores
 * usan query() salvo migraciones explicitas a objeto-filter).
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
    let query = elevatedQuery(dataCollectionId);
    if (filter) query = query.filter(filter);
    // Ordenacion: entradas "field ASC|DESC" (QueryBuilder) o
    // { fieldName, direction } (convencion order.asc/desc).
    if (Array.isArray(sort) && sort.length > 0) {
        const ascFields = [];
        const descFields = [];
        for (const s of sort) {
            if (typeof s === "string") {
                const [f, d] = s.trim().split(/\s+/);
                (String(d || "ASC").toUpperCase() === "DESC" ? descFields : ascFields).push(f);
            } else if ((s.direction || "ASC") === "DESC") {
                descFields.push(s.fieldName);
            } else {
                ascFields.push(s.fieldName);
            }
        }
        if (ascFields.length) query = query.ascending(...ascFields);
        if (descFields.length) query = query.descending(...descFields);
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
                      sort,
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

// DA-BUILDER-01 (PEND-DAL cierre): eliminacion por _id con normalizacion
// del contrato legacy (wix-data.remove admitia objeto completo; SDK v2 exige
// id). Los hooks beforeRemove reciben la fila autoritativa via WixDataProvider
// nativo del SDK, no pasando el objeto.
export async function removeById(collection, idOrItem) {
    const itemId =
        idOrItem && typeof idOrItem === "object"
            ? idOrItem._id || idOrItem.id
            : idOrItem;
    await elevatedRemove(collection, itemId);
    return { _id: itemId };
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
