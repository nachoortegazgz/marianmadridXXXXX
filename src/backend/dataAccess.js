/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v2.5-VELO-DATA-OPTIONS
RESPONSIBILITY: Capa unica de acceso a colecciones CMS con opciones Velo.
STANDARDS: G10 ASCII Strict. La elevacion de permisos de wix-data Velo se
declara mediante opciones de operacion; SDK permission wrapper se reserva al SDK Wix.
=============================================================================
*/

import wixData from "wix-data";

export const CONSISTENCY = Object.freeze({
    STRONG: Object.freeze({ consistentRead: true }),
    EVENTUAL: Object.freeze({}),
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

export const order = Object.freeze({
    asc: (fieldName) => [
        {
            fieldName,
            direction: "ASC",
        },
    ],
    desc: (fieldName) => [
        {
            fieldName,
            direction: "DESC",
        },
    ],
});

function buildOptions(consistency) {
    const options = { suppressAuth: true };

    if (
        consistency === CONSISTENCY.STRONG ||
        consistency?.consistentRead === true
    ) {
        options.consistentRead = true;
    } else if (typeof consistency === "string") {
        if (consistency.toLowerCase() === "strong") {
            options.consistentRead = true;
        }
    } else if (
        String(consistency?.consistencyMode || "").toLowerCase() === "strong"
    ) {
        options.consistentRead = true;
    }

    return options;
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

function applySort(queryObject, sort) {
    if (!Array.isArray(sort) || sort.length === 0) {
        return queryObject;
    }

    const ascending = [];
    const descending = [];

    for (const entry of sort) {
        if (typeof entry === "string") {
            const [fieldName, direction = "ASC"] = entry
                .trim()
                .split(/\s+/);

            if (!fieldName) {
                continue;
            }

            if (direction.toUpperCase() === "DESC") {
                descending.push(fieldName);
            } else {
                ascending.push(fieldName);
            }

            continue;
        }

        if (!entry || !entry.fieldName) {
            continue;
        }

        if (
            String(entry.direction || "ASC").toUpperCase() ===
            "DESC"
        ) {
            descending.push(entry.fieldName);
        } else {
            ascending.push(entry.fieldName);
        }
    }

    let sorted = queryObject;

    if (ascending.length > 0) {
        sorted = sorted.ascending(...ascending);
    }

    if (descending.length > 0) {
        sorted = sorted.descending(...descending);
    }

    return sorted;
}

/*
=============================================================================
ACCESO CMS VELO

wix-data es una API Velo, no un metodo del SDK Wix elevable con elevacion SDK.
Cada operacion recibe suppressAuth en sus opciones; las lecturas pueden
anadir consistentRead mediante buildOptions(). Mantener esta capa como unico
punto de acceso CMS y no pasar opciones de identidad desde los consumidores.
=============================================================================
*/

const runQuery = async ({
        dataCollectionId,
        filter,
        sort,
        limit,
        offset,
        consistency,
    }) => {
        let cmsQuery = wixData.query(dataCollectionId);

        if (filter) {
            cmsQuery = cmsQuery.filter(filter);
        }

        cmsQuery = applySort(cmsQuery, sort)
            .limit(normalizeLimit(limit))
            .skip(normalizeOffset(offset));

        return cmsQuery.find(buildOptions(consistency));
};

const runCount = async ({
        dataCollectionId,
        filter,
        consistency,
    }) => {
        let cmsQuery = wixData.query(dataCollectionId);

        if (filter) {
            cmsQuery = cmsQuery.filter(filter);
        }

        return cmsQuery.count(buildOptions(consistency));
};

const runGet = async ({
        collection,
        id,
        consistency,
    }) => {
        return wixData.get(
            collection,
            id,
            buildOptions(consistency),
        );
};

const runInsert = async ({
        collection,
        item,
    }) => {
        return wixData.insert(collection, item, buildOptions());
};

const runUpdate = async ({
        collection,
        item,
    }) => {
        return wixData.update(collection, item, buildOptions());
};

const runSave = async ({
        collection,
        item,
    }) => {
        return wixData.save(collection, item, buildOptions());
};

const runRemove = async ({
        collection,
        id,
    }) => {
        return wixData.remove(collection, id, buildOptions());
};

const runBulkInsert = async ({
        collection,
        items,
    }) => {
        return wixData.bulkInsert(collection, items, buildOptions());
};

const runBulkUpdate = async ({
        collection,
        items,
    }) => {
        return wixData.bulkUpdate(collection, items, buildOptions());
};

const runBulkRemove = async ({
        collection,
        ids,
    }) => {
        return wixData.bulkRemove(collection, ids, buildOptions());
};

const runQueryReferencedItems = async ({
        collection,
        id,
        fieldName,
        consistency,
    }) => {
        return wixData.queryReferenced(
            collection,
            id,
            fieldName,
            buildOptions(consistency),
        );
};

/*
=============================================================================
REFERENCIAS
=============================================================================
*/

export async function queryReferencedItems(
    collection,
    id,
    fieldName,
    consistency,
) {
    const result = await runQueryReferencedItems({
        collection,
        id,
        fieldName,
        consistency,
    });

    return Array.isArray(result)
        ? result
        : result?.items || [];
}

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
        const consistency =
            options.consistentRead === true
                ? CONSISTENCY.STRONG
                : options.consistencyMode ||
                    this._consistency ||
                    undefined;

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

        const totalCount = Number.isFinite(
            result?.totalCount,
        )
            ? result.totalCount
            : offset + items.length;

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
        const consistency =
            options.consistentRead === true
                ? CONSISTENCY.STRONG
                : options.consistencyMode ||
                    this._consistency ||
                    undefined;

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

    const totalCount = Number.isFinite(
        result?.totalCount,
    )
        ? result.totalCount
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

    return Number(count) || 0;
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

/*
=============================================================================
OPERACIONES MASIVAS
=============================================================================
*/

export function bulkInsert(collection, items) {
    return runBulkInsert({
        collection,
        items,
    });
}

export function bulkUpdate(collection, items) {
    return runBulkUpdate({
        collection,
        items,
    });
}

export function bulkRemove(collection, ids) {
    return runBulkRemove({
        collection,
        ids,
    });
}
