/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v2.5-FILTER-COMPAT
BASE: v2.4-ELEVATION-OFFICIAL + correccion de patron de elevacion y
compatibilidad de filtros con wix-data clasico.
RESPONSIBILITY: Capa unica de acceso elevado a colecciones CMS.
STANDARDS: G10 ASCII Strict. Sin suppressAuth. Sin imports directos de
wix-data fuera de esta capa, excepto backend/data.js para hooks.
FIX DA-V25-01 (P0): elevate(wixData.query) devuelve Promise, no Builder.
Se mantiene la operacion COMPLETA dentro del wrapper async elevado.
runQuery/runCount son funciones async envueltas por elevate() que
construyen y ejecutan la cadena wixData internamente.
FIX DA-V25-02 (P0): wql.eq() produce objetos WQL ({field:{$eq:v}}) pero
wixData.query().filter() espera un WixDataFilterBuilder construido con
wixData.filter(). Se anade buildWixDataFilter() como conversor.
FIX DA-V25-03 (P1): queryReferencedItems usa wixData.queryReferenced
(no queryReferencedItems). El parametro consistency se ignora porque
la API nativa no lo acepta.
CONTRATO PUBLICO: identico a v2.3/v2.4. Cero cambios en consumidores.
=============================================================================
*/
import wixData from "wix-data";
import { elevate } from "wix-auth";

// =============================================================================
// BLOQUE 1 - CONSISTENCIA Y WQL
// =============================================================================
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

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================
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

function applySort(queryBuilder, sort) {
if (!Array.isArray(sort) || sort.length === 0) return queryBuilder;
const ascending = [];
const descending = [];
for (const entry of sort) {
if (typeof entry === "string") {
const parts = entry.trim().split(/\s+/);
const fieldName = parts[0];
const direction = (parts[1] || "ASC").toUpperCase();
if (!fieldName) continue;
if (direction === "DESC") {
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
let sorted = queryBuilder;
if (ascending.length > 0) sorted = sorted.ascending(...ascending);
if (descending.length > 0) sorted = sorted.descending(...descending);
return sorted;
}

// =============================================================================
// BLOQUE 3 - CONVERSOR WQL -> WixDataFilterBuilder (DA-V25-02)
// =============================================================================
/* wixData.query().filter() NO acepta objetos WQL planos. Requiere un
* WixDataFilterBuilder construido con wixData.filter(). Este bloque
* convierte recursivamente la estructura WQL producida por wql.* en
* llamadas encadenadas al builder nativo de wix-data. */

function applyFieldClause(filterBuilder, field, expression) {
if (
!expression ||
typeof expression !== "object" ||
Array.isArray(expression)
) {
return filterBuilder.eq(field, expression);
}
const entries = Object.entries(expression);
for (const [operator, value] of entries) {
switch (operator) {
case "$eq":
filterBuilder = filterBuilder.eq(field, value);
break;
case "$ne":
filterBuilder = filterBuilder.ne(field, value);
break;
case "$gt":
filterBuilder = filterBuilder.gt(field, value);
break;
case "$gte":
filterBuilder = filterBuilder.ge(field, value);
break;
case "$lt":
filterBuilder = filterBuilder.lt(field, value);
break;
case "$lte":
filterBuilder = filterBuilder.le(field, value);
break;
case "$in":
case "$hasSome":
filterBuilder = filterBuilder.hasSome(
field,
Array.isArray(value) ? value : [value]
);
break;
case "$startsWith":
filterBuilder = filterBuilder.startsWith(field, value);
break;
default:
throw new Error("UNSUPPORTED_FILTER_OPERATOR:" + operator);
}
}
return filterBuilder;
}

function buildWixDataFilter(clause) {
if (!clause || typeof clause !== "object") {
return null;
}
if (Array.isArray(clause.$and)) {
const filters = clause.$and
.map(buildWixDataFilter)
.filter(Boolean);
if (filters.length === 0) return null;
return filters.reduce(
(combined, current) => combined ? combined.and(current) : current,
null
);
}
if (Array.isArray(clause.$or)) {
const filters = clause.$or
.map(buildWixDataFilter)
.filter(Boolean);
if (filters.length === 0) return null;
return filters.reduce(
(combined, current) => combined ? combined.or(current) : current,
null
);
}
let result = wixData.filter();
for (const [field, expression] of Object.entries(clause)) {
result = applyFieldClause(result, field, expression);
}
return result;
}

function applyFilter(queryBuilder, clause) {
const dataFilter = buildWixDataFilter(clause);
return dataFilter ? queryBuilder.filter(dataFilter) : queryBuilder;
}

// =============================================================================
// BLOQUE 4 - OPERACIONES ELEVADAS (DA-V25-01)
// =============================================================================
/* La operacion completa (query + filter + sort + limit + skip + find) vive
* DENTRO del wrapper async elevado. elevate() devuelve una funcion async;
* si se elevara wixData.query directamente, el resultado seria una Promise
* y .filter() no existiria sobre ella (error: cmsQuery.filter is not a
* function). El patron correcto es elevar la funcion propia que construye
* y ejecuta toda la cadena internamente. */

const runQuery = elevate(async ({
dataCollectionId,
filter,
sort,
limit,
offset,
consistency,
}) => {
let cmsQuery = wixData.query(dataCollectionId);
cmsQuery = applyFilter(cmsQuery, filter);
cmsQuery = applySort(cmsQuery, sort)
.limit(limit)
.skip(offset);
return cmsQuery.find(buildOptions(consistency));
});

const runCount = elevate(async ({
dataCollectionId,
filter,
consistency,
}) => {
let cmsQuery = wixData.query(dataCollectionId);
cmsQuery = applyFilter(cmsQuery, filter);
return cmsQuery.count(buildOptions(consistency));
});

const elevatedGet = elevate(async (collection, id, options) => {
return wixData.get(collection, id, options);
});

const elevatedInsert = elevate(async (collection, item) => {
return wixData.insert(collection, item);
});

const elevatedUpdate = elevate(async (collection, item) => {
return wixData.update(collection, item);
});

const elevatedRemove = elevate(async (collection, id) => {
return wixData.remove(collection, id);
});

const elevatedSave = elevate(async (collection, item) => {
return wixData.save(collection, item);
});

const elevatedBulkInsert = elevate(async (collection, items) => {
return wixData.bulkInsert(collection, items);
});

const elevatedBulkUpdate = elevate(async (collection, items) => {
return wixData.bulkUpdate(collection, items);
});

const elevatedBulkRemove = elevate(async (collection, ids) => {
return wixData.bulkRemove(collection, ids);
});

const elevatedQueryReferenced = elevate(async (collection, id, fieldName) => {
return wixData.queryReferenced(collection, id, fieldName);
});

// =============================================================================
// BLOQUE 5 - API PUBLICA
// =============================================================================
export async function queryReferencedItems(
collection,
id,
fieldName,
consistency
) {
/* Nota: wixData.queryReferenced() no acepta opciones de consistencia.
* El parametro consistency se ignora para compatibilidad con consumidores. */
const result = await elevatedQueryReferenced(
collection,
id,
fieldName
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
changes.clauses !== undefined ? changes.clauses : this._clauses,
changes.sort !== undefined ? changes.sort : this._sort,
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
sort: [...this._sort, ...fields.map((f) => f + " ASC")],
});
}

descending(...fields) {
return this._with({
sort: [...this._sort, ...fields.map((f) => f + " DESC")],
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
const itemsList = result?.items || [];
const totalCount = Number.isFinite(result?.totalCount)
? result.totalCount
: offset + itemsList.length;
const builder = this;
return {
items: itemsList,
length: itemsList.length,
totalCount,
hasNext: () => offset + itemsList.length < totalCount,
next: async () => {
if (itemsList.length === 0) {
return builder._pageResult(
{ items: [], totalCount },
offset,
consistency
);
}
const nextOffset = offset + itemsList.length;
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
const itemsList = result?.items || [];
const totalCount = Number.isFinite(result?.totalCount)
? result.totalCount
: pageOffset + itemsList.length;
const hasNext = pageOffset + itemsList.length < totalCount;
return {
items: itemsList,
totalCount,
hasNext,
next: hasNext
? () => queryItems({
dataCollectionId,
filter,
sort,
limit: pageLimit,
offset: pageOffset + itemsList.length,
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
