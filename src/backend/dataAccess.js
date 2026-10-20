/**
 * MODULE: backend/dataAccess.js
 * VERSION: v2.2-CONSISTENT-READ
 * APIS: wix-data, @wix/essentials (auth).
 * DOC: https://www.wix.com/velo/reference/wix-data
 *      https://www.wix.com/velo/reference/wix-data/query/find
 */
import wixData from "wix-data";
import { auth } from "@wix/essentials";

export const CONSISTENCY = Object.freeze({ STRONG: { consistentRead: true }, EVENTUAL: {} });

function fieldClause(field, operator, value) { return { [String(field)]: { [operator]: value } }; }
function asArray(value) { return Array.isArray(value) ? value : [value]; }
export const wql = Object.freeze({
    eq: (f, v) => fieldClause(f, "$eq", v), ne: (f, v) => fieldClause(f, "$ne", v),
    gt: (f, v) => fieldClause(f, "$gt", v), gte: (f, v) => fieldClause(f, "$gte", v),
    lt: (f, v) => fieldClause(f, "$lt", v), lte: (f, v) => fieldClause(f, "$lte", v),
    in: (f, v) => fieldClause(f, "$in", asArray(v)), hasSome: (f, v) => fieldClause(f, "$hasSome", asArray(v)),
    startsWith: (f, v) => fieldClause(f, "$startsWith", v),
    and: (...c) => ({ $and: c.filter(Boolean) }), or: (...c) => ({ $or: c.filter(Boolean) })
});
export const order = Object.freeze({
    asc: (f) => [{ fieldName: f, direction: "ASC" }],
    desc: (f) => [{ fieldName: f, direction: "DESC" }]
});

function buildOptions(consistency) {
    if (!consistency) return {};
    // wix-data espera { consistentRead: true } (no consistencyMode)
    return consistency;
}

/* ... (resto de funciones sin cambios, usando buildOptions correctamente) ... */