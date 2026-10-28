/*
MODULE: src/backend/dataAccess.js
RESPONSIBILITY: CMS data-access boundary. Validates collection/item inputs, centralizes @wix/data operations and auth.elevate, compiles query filters, normalizes IDs and paging metadata.
DEPENDENCIES: @wix/data, @wix/essentials
PUBLIC EXPORTS: CONSISTENCY, wql, queryFirstItem, queryItems, getItem, countItems, insertItem, updateItem, saveItem, removeById
HISTORY: This header documents the current source contract only. Historical changes belong to Git commit history; no unverified version/changelog claims are retained here.
*/

import { items as wixDataItems } from "@wix/data";
import { auth } from "@wix/essentials";

// The site only requires explicit strong reads; do not expose unused modes.
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

function elevatedCall(operation, ...args) {
    if (typeof operation !== "function") {
        throw new TypeError("Wix Data operation is not callable");
    }

    // Wix SDK modules may expose lazy callable proxies. Elevate a plain
    // function so auth.elevate does not introspect the proxy before invocation.
    const elevatedOperation = auth.elevate(function (...runtimeArgs) {
        return operation(...runtimeArgs);
    });
    if (typeof elevatedOperation !== "function") {
        throw new TypeError("Elevated Wix Data operation is not callable");
    }
    return elevatedOperation(...args);
}

function normalizeSort(sort) {
    if (!Array.isArray(sort)) return [];
    return sort.flatMap((entry) => {
        if (typeof entry === "string") {
            const [fieldName, direction = "ASC"] = entry.trim().split(/\\s+/);
            return fieldName ? [{ fieldName, order: direction.toUpperCase() === "DESC" ? "DESC" : "ASC" }] : [];
        }
        if (!entry || !entry.fieldName) return [];
        return [{ fieldName: entry.fieldName, order: String(entry.order || entry.direction || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC" }];
    });
}

const runQuery = async ({
    dataCollectionId,
    filter,
    sort,
    limit,
    offset,
    consistency,
}) => {
    const queryRequest = {
        filter,
        sort: normalizeSort(sort),
        paging: {
            limit: normalizeLimit(limit),
            offset: normalizeOffset(offset),
        },
    };
    return elevatedCall(
        wixDataItems.query,
        dataCollectionId,
        queryRequest,
        {
            ...buildOptions(consistency),
            returnTotalCount: true,
        }
    );
};

const runCount = async ({
    dataCollectionId,
    filter,
    consistency,
}) => {
    return elevatedCall(
        wixDataItems.count,
        dataCollectionId,
        {
            filter,
            ...buildOptions(consistency),
        }
    );
};

const runGet = async ({
    collection,
    id,
    consistency,
}) =>
    elevatedCall(
        wixDataItems.get,
        collection,
        id,
        buildOptions(consistency)
    );

const runInsert = async ({ collection, item }) =>
    elevatedCall(wixDataItems.insert, collection, item);

const runUpdate = async ({ collection, item }) =>
    elevatedCall(wixDataItems.update, collection, item);

const runSave = async ({ collection, item }) =>
    elevatedCall(wixDataItems.save, collection, item);

// Keep the adapter surface limited to operations used by this site.
const runRemove = async ({ collection, id }) =>
    elevatedCall(wixDataItems.remove, collection, id);
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

