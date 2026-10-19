/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v2.4-ELEVATION-OFFICIAL
BASE: v2.3-ELEVATION-FIX + correccion del patron de elevacion.
RESPONSIBILITY: Capa unica de acceso elevado a colecciones CMS.
STANDARDS: G10 ASCII Strict. Sin suppressAuth. Sin imports directos de
wix-data fuera de esta capa, excepto backend/data.js para hooks.
FIX DA-ELEV-04 (P0):
- elevate() de wix-auth envuelve DIRECTAMENTE cada metodo de wix-data
(patron oficial Wix). El patron anterior elevaba funciones async
custom que invocaban wixData.query() en su interior: el contexto del
QueryBuilder se rompia y devolvia un objeto sin .filter(), causando
"cmsQuery.filter is not a function" en todas las consultas del sitio.
- elevate(wixData.query) devuelve una funcion que produce un
QueryBuilder elevado. Las operaciones encadenadas (.filter, .limit,
.skip, .find, .count) heredan la elevacion.
- runQuery/runCount son funciones async PLANAS (no elevadas) que
consumen el builder elevado.
CONTRATO PUBLICO: identico a v2.3. Cero cambios en consumidores.
=============================================================================
*/
import wixData from "wix-data";
import { elevate } from "wix-auth";

export const CONSISTENCY = Object.freeze({
STRONG: "strong",
EVENTUAL: "eventual",
});

function fieldClause(field, operator, value) {
return { [String(field)]: { [operator]: value } };
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
and: (...clauses) => ({ $and: clauses.filter(Boolean) }),
or: (...clauses) => ({ $or: clauses.filter(Boolean) }),
});

export const order = Object.freeze({
asc: (fieldName) => [{ fieldName, direction: "ASC" }],
desc: (fieldName) => [{ fieldName, direction: "DESC" }],
});

function buildOptions(consistency) {
return consistency ? { consistencyMode: consistency } : {};
}

function normalizeLimit(value) {
if (value === undefined || value === null) return 100;
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

function applySort(query, sort) {
if (!Array.isArray(sort) || sort.length === 0) return query;
const ascending = [];
const descending = [];
for (const entry of sort) {
if (typeof entry === "string") {
const [fieldName, direction = "ASC"] = entry.trim().split(/\s+/);
if (!fieldName) continue;
if (direction.toUpperCase() === "DESC") {
descending.push(fieldName);
} else {
ascending.push(fieldName);
}
continue;
}
if (!entry || !entry.fieldName) continue;
if (String(entry.direction || "ASC").toUpperCase() === "DESC") {
descending.push(entry.fieldName);
} else {
ascending.push(entry.fieldName);
}
}
let sorted = query;
if (ascending.length > 0) sorted = sorted.ascending(...ascending);
if (descending.length > 0) sorted = sorted.descending(...descending);
return sorted;
}

// =============================================================================
// DA-ELEV-04: ELEVACION DIRECTA DE METODOS wix-data (PATRON OFICIAL WIX)
// =============================================================================
/* elevate() envuelve el metodo del modulo, no una funcion custom.
* elevatedQuery(collection) devuelve un QueryBuilder elevado sobre el que
* se encadenan .filter/.eq/.limit/.skip/.find/.count con permisos de admin.
* Elevar wrappers async personalizados rompe el contexto interno del
* builder (error: "cmsQuery.filter is not a function"). */
const elevatedQuery = elevate(wixData.query);
const elevatedGet = elevate(wixData.get);
const elevatedInsert = elevate(wixData.insert);
const elevatedUpdate = elevate(wixData.update);
const elevatedRemove = elevate(wixData.remove);
const elevatedSave = elevate(wixData.save);
const elevatedBulkInsert = elevate(wixData.bulkInsert);
const elevatedBulkUpdate = elevate(wixData.bulkUpdate);
const elevatedBulkRemove = elevate(wixData.bulkRemove);
const elevatedQueryReferenced = elevate(wixData.queryReferencedItems);

// Funciones async planas que consumen el builder elevado.
async function runQuery({
dataCollectionId,
filter,
sort,
limit,
offset,
consistency,
}) {
let cmsQuery = elevatedQuery(dataCollectionId);
if (filter) cmsQuery = cmsQuery.filter(filter);
cmsQuery = applySort(cmsQuery, sort)
.limit(limit)
.skip(offset);
return cmsQuery.find(buildOptions(consistency));
}

async function runCount({ dataCollectionId, filter, consistency }) {
let cmsQuery = elevatedQuery(dataCollectionId);
if (filter) cmsQuery = cmsQuery.filter(filter);
return cmsQuery.count(buildOptions(consistency));
}

export async function queryReferencedItems(
collection,
id,
fieldName,
consistency
) {
const result = await elevatedQueryReferenced(
collection,
id,
fieldName,
buildOptions(consistency)
);
return Array.isArray(result) ? result : result?.items || [];
}

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
consistency = null
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
changes.limit !== undefined ? changes.limit : this._limit,
changes.offset !== undefined ? changes.offset : this._offset,
changes.consistency !== undefined
? changes.consistency
: this._consistency
);
}

_add(clause) {
return this._with({ clauses: [...this._clauses, clause] });
}

_filter() {
if (this._clauses.length === 0) return undefined;
if (this._clauses.length === 1) return this._clauses[0];
return wql.and(...this._clauses);
}

consistent() {
return this._with({ consistency: CONSISTENCY.STRONG });
}

eq(field, value) { return this._add(wql.eq(field, value)); }
ne(field, value) { return this._add(wql.ne(field, value)); }
gt(field, value) { return this._add(wql.gt(field, value)); }
gte(field, value) { return this._add(wql.gte(field, value)); }
lt(field, value) { return this._add(wql.lt(field, value)); }
lte(field, value) { return this._add(wql.lte(field, value)); }
hasSome(field, values) { return this._add(wql.hasSome(field, values)); }
in(field, values) { return this._add(wql.in(field, values)); }
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
sort: [...this._sort, ...fields.map((field) => `${field} ASC`)],
});
}

descending(...fields) {
return this._with({
sort: [...this._sort, ...fields.map((field) => `${field} DESC`)],
});
}

limit(value) { return this._with({ limit: value }); }
skip(value) { return this._with({ offset: value }); }

get(id) { return getItem(this._collection, id, this._consistency); }
insert(item) { return insertItem(this._collection, item); }
update(item) { return updateItem(this._collection, item); }
save(item) { return saveItem(this._collection, item); }
remove(idOrItem) { return removeById(this._collection, idOrItem); }

async find(options = {}) {
const consistency =
options.consistencyMode || this._consistency || undefined;
const offset = normalizeOffset(this._offset);
const result = await this._runPage(offset, consistency);
return this._pageResult(result, offset, consistency);
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
const totalCount = Number.isFinite(result?.totalCount)
? result.totalCount
: offset + items.length;
const builder = this;
return {
items,
length: items.length,
totalCount,
hasNext: () => offset + items.length < totalCount,
next: async () => {
if (items.length === 0) {
return builder._pageResult(
{ items: [], totalCount },
offset,
consistency
);
}
const nextOffset = offset + items.length;
const nextResult = await builder._runPage(
nextOffset,
consistency
);
return builder._pageResult(
nextResult,
nextOffset,
consistency
);
},
};
}

count(options = {}) {
return countItems(
this._collection,
this._filter(),
options.consistencyMode || this._consistency || undefined
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
const totalCount = Number.isFinite(result?.totalCount)
? result.totalCount
: pageOffset + items.length;
const hasNext = pageOffset + items.length < totalCount;
return {
items,
totalCount,
hasNext,
next: hasNext
? () => queryItems({
dataCollectionId,
filter,
sort,
limit: pageLimit,
offset: pageOffset + items.length,
consistency,
})
: null,
};
}

export async function getItem(collection, id, consistency) {
try {
return await elevatedGet(
collection,
id,
buildOptions(consistency)
);
} catch (error) {
if (String(error?.message || "").includes("WDE0073")) return null;
throw error;
}
}

export async function countItems(collection, filter, consistency) {
const count = await runCount({
dataCollectionId: collection,
filter,
consistency,
});
return Number(count) || 0;
}

export function insertItem(collection, item) {
return elevatedInsert(collection, item);
}

export function updateItem(collection, item) {
return elevatedUpdate(collection, item);
}

export async function removeItem(collection, id) {
await elevatedRemove(collection, id);
}

export function saveItem(collection, item) {
return elevatedSave(collection, item);
}

export async function removeById(collection, idOrItem) {
const id = idOrItem && typeof idOrItem === "object"
? idOrItem._id || idOrItem.id
: idOrItem;
await elevatedRemove(collection, id);
return { _id: id };
}

export function bulkInsert(collection, items) {
return elevatedBulkInsert(collection, items);
}

export function bulkUpdate(collection, items) {
return elevatedBulkUpdate(collection, items);
}

export function bulkRemove(collection, ids) {
return elevatedBulkRemove(collection, ids);
}
