/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v3.0-WIX-DATA-SDK
RESPONSIBILITY: Capa unica de acceso a colecciones CMS mediante @wix/data.
STANDARDS: G10 ASCII Strict. Todas las operaciones CMS se elevan en esta capa
mediante @wix/essentials; las opciones de lectura fuerte usan consistentRead.
=============================================================================
*/

import { items as wixDataItems } from "@wix/data";
import { auth } from "@wix/essentials";

export const CONSISTENCY = Object.freeze({
    STRONG: Object.freeze({ consistentRead: true }),
});

function fieldClause(field, operator, value) {
    return {
        [String(field)]: {
            [operator]: value,
        },
    };
}

function asArray(value) {
    return Array.isArray(value) ? value : [value];
}

export const wql = Object.freeze({
    eq: (field, value) => fieldClause(field, "$eq", value),
    ne: (field, value) => fieldClause(field, "$ne", value),
    gt: (field, value) => fieldClause(field, "$gt", value),
    gte: (field, value) => fieldClause(field, "$gte", value),
    lt: (field, value) => fieldClause(field, "$lt", value),
    lte: (field, value) => fieldClause(field, "$lte", value),
    in: (field, values) => fieldClause(field, "$in", asArray(values)),
    hasSome: (field, values) =>
        fieldClause(field, "$hasSome", asArray(values)),
    startsWith: (field, value) =>
        fieldClause(field, "$startsWith", value),
    and: (...clauses) => ({
        $and: clauses.filter(Boolean),
    }),
    or: (...clauses) => ({
        $or: clauses.filter(Boolean),
    }),
});



function buildOptions(consistency) {
    return consistency === CONSISTENCY.STRONG || consistency?.consistentRead === true
        ? { consistentRead: true }
        : {};
}
function normalizeLimit(value) {
    if (value === undefined || value === null) {
        return 100;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : 100;
}

function normalizeOffset(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : 0;
}

/*
=============================================================================
ACCESO CMS MEDIANTE SDK WIX

Todas las operaciones de CMS se ejecutan mediante @wix/data y se elevan
con auth.elevate en esta capa. No se propaga suppressAuth ni se permite que
los consumidores decidan permisos. Las lecturas pueden usar consistentRead.
=============================================================================
*/

const elevatedQuery = auth.elevate(wixDataItems.query);
const elevatedCount = auth.elevate(wixDataItems.count);
const elevatedGet = auth.elevate(wixDataItems.get);
const elevatedInsert = auth.elevate(wixDataItems.insert);
const elevatedUpdate = auth.elevate(wixDataItems.update);
const elevatedSave = auth.elevate(wixDataItems.save);
const elevatedRemove = auth.elevate(wixDataItems.remove);

function normalizeSort(sort) {
    if (!Array.isArray(sort)) return [];
    return sort.flatMap((entry) => {
        if (typeof entry === "string") {
            const [fieldName, direction = "ASC"] = entry.trim().split(/\s+/);
            return fieldName ? [{ fieldName, order: direction.toUpperCase() === "DESC" ? "DESC" : "ASC" }] : [];
        }
        if (!entry || !entry.fieldName) return [];
        return [{ fieldName: entry.fieldName, order: String(entry.order || entry.direction || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC" }];
    });
}

const runQuery = async ({ dataCollectionId, filter, sort, limit, offset, consistency }) =>
    elevatedQuery(dataCollectionId, {
        filter,
        sort: normalizeSort(sort),
        paging: { limit: normalizeLimit(limit), offset: normalizeOffset(offset) },
        returnTotalCount: true,
    }, buildOptions(consistency));

const runCount = async ({ dataCollectionId, filter, consistency }) =>
    elevatedCount(dataCollectionId, { filter, ...buildOptions(consistency) });

const runGet = async ({ collection, id, consistency }) =>
    elevatedGet(collection, id, buildOptions(consistency));

const runInsert = async ({ collection, item }) => elevatedInsert(collection, item);
const runUpdate = async ({ collection, item }) => elevatedUpdate(collection, item);
const runSave = async ({ collection, item }) => elevatedSave(collection, item);
const runRemove = async ({ collection, id }) => elevatedRemove(collection, id);

/*
=============================================================================
CONSULTAS
=============================================================================
*/

export async function queryFirstItem({
    dataCollectionId,
    filter,
    consistency,
}) {
    const result = await runQuery({
        dataCollectionId,
        filter,
        limit: 1,
        offset: 0,
        consistency,
    });

    return result?.items?.[0] || null;
}

class QueryBuilder {
    constructor(
        dataCollectionId,
        clauses = [],
        sort = [],
        limit,
        offset = 0,
        consistency = null,
    ) {
        this._collection = dataCollectionId;
        this._clauses = clauses;
        this._sort = sort;
        this._limit = limit;
        this._offset = offset;
        this._consistency = consistency;
    }

    _with(changes) {
        return new QueryBuilder(
            this._collection,
            changes.clauses ?? this._clauses,
            changes.sort ?? this._sort,
            changes.limit !== undefined
                ? changes.limit
                : this._limit,
            changes.offset !== undefined
                ? changes.offset
                : this._offset,
            changes.consistency !== undefined
                ? changes.consistency
                : this._consistency,
        );
    }

    _add(clause) {
        return this._with({
            clauses: [
                ...this._clauses,
                clause,
            ],
        });
    }

    _filter() {
        if (this._clauses.length === 0) {
            return undefined;
        }

        if (this._clauses.length === 1) {
            return this._clauses[0];
        }

        return wql.and(...this._clauses);
    }

    consistent() {
        return this._with({
            consistency: CONSISTENCY.STRONG,
        });
    }

    eq(field, value) {
        return this._add(wql.eq(field, value));
    }

    ne(field, value) {
        return this._add(wql.ne(field, value));
    }

    gt(field, value) {
        return this._add(wql.gt(field, value));
    }

    gte(field, value) {
        return this._add(wql.gte(field, value));
    }

    lt(field, value) {
        return this._add(wql.lt(field, value));
    }

    lte(field, value) {
        return this._add(wql.lte(field, value));
    }

    hasSome(field, values) {
        return this._add(wql.hasSome(field, values));
    }

    in(field, values) {
        return this._add(wql.in(field, values));
    }

    startsWith(field, value) {
        return this._add(wql.startsWith(field, value));
    }

    contains(field, value) {
        return /Ids?$/.test(String(field))
            ? this.hasSome(field, [value])
            : this.startsWith(field, value);
    }

    ascending(...fields) {
        return this._with({
            sort: [
                ...this._sort,
                ...fields.map(
                    (field) => `${field} ASC`,
                ),
            ],
        });
    }

    descending(...fields) {
        return this._with({
            sort: [
                ...this._sort,
                ...fields.map(
                    (field) => `${field} DESC`,
                ),
            ],
        });
    }

    limit(value) {
        return this._with({
            limit: value,
        });
    }

    skip(value) {
        return this._with({
            offset: value,
        });
    }

    get(id) {
        return getItem(
            this._collection,
            id,
            this._consistency,
        );
    }

    insert(item) {
        return insertItem(
            this._collection,
            item,
        );
    }

    update(item) {
        return updateItem(
            this._collection,
            item,
        );
    }

    save(item) {
        return saveItem(
            this._collection,
            item,
        );
    }

    remove(idOrItem) {
        return removeById(
            this._collection,
            idOrItem,
        );
    }

    async find(options = {}) {
        const consistency = options.consistentRead === true
            ? CONSISTENCY.STRONG
            : this._consistency || undefined;

        const offset = normalizeOffset(this._offset);

        const result = await this._runPage(
            offset,
            consistency,
        );

        return this._pageResult(
            result,
            offset,
            consistency,
        );
    }

    _runPage(offset, consistency) {
        return queryItems({
            dataCollectionId: this._collection,
            filter: this._filter(),
            sort: this._sort,
            limit: this._limit,
            offset,
            consistency,
        });
    }

    _pageResult(result, offset, consistency) {
        const items = result?.items || [];

        const reportedTotal = result?.totalCount ?? result?.pagingMetadata?.total;
        const totalCount = Number.isFinite(reportedTotal) ? reportedTotal : offset + items.length;

        const builder = this;

        return {
            items,
            length: items.length,
            totalCount,

            hasNext: () =>
                offset + items.length < totalCount,

            next: async () => {
                if (items.length === 0) {
                    return builder._pageResult(
                        {
                            items: [],
                            totalCount,
                        },
                        offset,
                        consistency,
                    );
                }

                const nextOffset =
                    offset + items.length;

                const nextResult =
                    await builder._runPage(
                        nextOffset,
                        consistency,
                    );

                return builder._pageResult(
                    nextResult,
                    nextOffset,
                    consistency,
                );
            },
        };
    }

    count(options = {}) {
        const consistency = options.consistentRead === true
            ? CONSISTENCY.STRONG
            : this._consistency || undefined;

        return countItems(
            this._collection,
            this._filter(),
            consistency,
        );
    }
}

export function query(dataCollectionId) {
    return new QueryBuilder(dataCollectionId);
}

export async function queryItems({
    dataCollectionId,
    filter,
    sort,
    limit = 100,
    offset = 0,
    consistency,
}) {
    const pageLimit = normalizeLimit(limit);
    const pageOffset = normalizeOffset(offset);

    const result = await runQuery({
        dataCollectionId,
        filter,
        sort,
        limit: pageLimit,
        offset: pageOffset,
        consistency,
    });

    const items = result?.items || [];

    const reportedTotal = result?.totalCount ?? result?.pagingMetadata?.total;
    const totalCount = Number.isFinite(reportedTotal)
        ? reportedTotal
        : pageOffset + items.length;

    const hasNext =
        pageOffset + items.length < totalCount;

    return {
        items,
        totalCount,
        hasNext,

        next: hasNext
            ? () =>
                  queryItems({
                      dataCollectionId,
                      filter,
                      sort,
                      limit: pageLimit,
                      offset:
                          pageOffset + items.length,
                      consistency,
                  })
            : null,
    };
}

/*
=============================================================================
LECTURA Y ESCRITURA
=============================================================================
*/

export async function getItem(
    collection,
    id,
    consistency,
) {
    try {
        return await runGet({
            collection,
            id,
            consistency,
        });
    } catch (error) {
        if (
            String(error?.message || "").includes(
                "WDE0073",
            )
        ) {
            return null;
        }

        throw error;
    }
}

export async function countItems(
    collection,
    filter,
    consistency,
) {
    const count = await runCount({
        dataCollectionId: collection,
        filter,
        consistency,
    });

    return Number(count?.totalCount ?? count) || 0;
}

export function insertItem(collection, item) {
    return runInsert({
        collection,
        item,
    });
}

export function updateItem(collection, item) {
    return runUpdate({
        collection,
        item,
    });
}

export function saveItem(collection, item) {
    return runSave({
        collection,
        item,
    });
}

export async function removeById(
    collection,
    idOrItem,
) {
    const id =
        idOrItem && typeof idOrItem === "object"
            ? idOrItem._id || idOrItem.id
            : idOrItem;

    await runRemove({
        collection,
        id,
    });

    return {
        _id: id,
    };
}

