/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v2.6-VERIFIED
BASE: v2.5-FILTER-COMPAT + correccion sintactica completa.
RESPONSIBILITY: Capa unica de acceso elevado a colecciones CMS.
STANDARDS: G10 ASCII Strict. Sin suppressAuth. Sin imports directos de
wix-data fuera de esta capa, excepto backend/data.js para hooks.
DA-V25-01: Operacion completa dentro de wrapper async elevado.
DA-V25-02: Conversor WQL a WixDataFilterBuilder.
DA-V26-01: Todas las propiedades de QueryBuilder usan prefijo _.
DA-V26-02: Comentarios correctamente cerrados.
DA-V26-03: Paginacion con operadores completos y sin truncar.
CONTRATO PUBLICO: identico a v2.3. Cero cambios en consumidores.
=============================================================================
*/
import wixData from "wix-data";
import { elevate } from "wix-auth";

export const CONSISTENCY = Object.freeze({
STRONG: "strong",
EVENTUAL: "eventual"
});

function fieldClause(field, operator, value) {
var result = {};
result[String(field)] = {};
result[String(field)][operator] = value;
return result;
}

function asArray(value) {
return Array.isArray(value) ? value : [value];
}

export const wql = Object.freeze({
eq: function (field, value) { return fieldClause(field, "$eq", value); },
ne: function (field, value) { return fieldClause(field, "$ne", value); },
gt: function (field, value) { return fieldClause(field, "$gt", value); },
gte: function (field, value) { return fieldClause(field, "$gte", value); },
lt: function (field, value) { return fieldClause(field, "$lt", value); },
lte: function (field, value) { return fieldClause(field, "$lte", value); },
in: function (field, values) { return fieldClause(field, "$in", asArray(values)); },
hasSome: function (field, values) { return fieldClause(field, "$hasSome", asArray(values)); },
startsWith: function (field, value) { return fieldClause(field, "$startsWith", value); },
and: function () {
var clauses = [];
for (var i = 0; i < arguments.length; i++) {
if (arguments[i]) clauses.push(arguments[i]);
}
return { $and: clauses };
},
or: function () {
var clauses = [];
for (var i = 0; i < arguments.length; i++) {
if (arguments[i]) clauses.push(arguments[i]);
}
return { $or: clauses };
}
});

export const order = Object.freeze({
asc: function (fieldName) { return [{ fieldName: fieldName, direction: "ASC" }]; },
desc: function (fieldName) { return [{ fieldName: fieldName, direction: "DESC" }]; }
});

function buildOptions(consistency) {
if (!consistency) return {};
return { consistencyMode: consistency };
}

function normalizeLimit(value) {
if (value === undefined || value === null) return 100;
var parsed = Number(value);
if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
return 100;
}

function normalizeOffset(value) {
var parsed = Number(value);
if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
return 0;
}

function applySort(queryBuilder, sort) {
if (!Array.isArray(sort) || sort.length === 0) return queryBuilder;
var ascending = [];
var descending = [];
for (var i = 0; i < sort.length; i++) {
var entry = sort[i];
if (typeof entry === "string") {
var parts = entry.trim().split(/\s+/);
var fieldName = parts[0];
var direction = (parts[1] || "ASC").toUpperCase();
if (!fieldName) continue;
if (direction === "DESC") {
descending.push(fieldName);
} else {
ascending.push(fieldName);
}
continue;
}
if (!entry || !entry.fieldName) continue;
var dir = String(entry.direction || "ASC").toUpperCase();
if (dir === "DESC") {
descending.push(entry.fieldName);
} else {
ascending.push(entry.fieldName);
}
}
var sorted = queryBuilder;
if (ascending.length > 0) sorted = sorted.ascending.apply(sorted, ascending);
if (descending.length > 0) sorted = sorted.descending.apply(sorted, descending);
return sorted;
}

/*
* DA-V25-02: Conversor WQL a WixDataFilterBuilder.
* wixData.query().filter() NO acepta objetos WQL planos. Requiere un
* WixDataFilterBuilder construido con wixData.filter(). Este bloque
* convierte recursivamente la estructura WQL producida por wql.* en
* llamadas encadenadas al builder nativo de wix-data.
*/
function applyFieldClause(filterBuilder, field, expression) {
if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
return filterBuilder.eq(field, expression);
}
var keys = Object.keys(expression);
for (var k = 0; k < keys.length; k++) {
var operator = keys[k];
var value = expression[operator];
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
filterBuilder = filterBuilder.hasSome(field, Array.isArray(value) ? value : [value]);
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
if (!clause || typeof clause !== "object") return null;

if (Array.isArray(clause.$and)) {
var andFilters = [];
for (var ai = 0; ai < clause.$and.length; ai++) {
var af = buildWixDataFilter(clause.$and[ai]);
if (af) andFilters.push(af);
}
if (andFilters.length === 0) return null;
var andResult = andFilters[0];
for (var aj = 1; aj < andFilters.length; aj++) {
andResult = andResult.and(andFilters[aj]);
}
return andResult;
}

if (Array.isArray(clause.$or)) {
var orFilters = [];
for (var oi = 0; oi < clause.$or.length; oi++) {
var of_ = buildWixDataFilter(clause.$or[oi]);
if (of_) orFilters.push(of_);
}
if (orFilters.length === 0) return null;
var orResult = orFilters[0];
for (var oj = 1; oj < orFilters.length; oj++) {
orResult = orResult.or(orFilters[oj]);
}
return orResult;
}

var result = wixData.filter();
var fields = Object.keys(clause);
for (var fi = 0; fi < fields.length; fi++) {
result = applyFieldClause(result, fields[fi], clause[fields[fi]]);
}
return result;
}

function applyFilter(queryBuilder, clause) {
var dataFilter = buildWixDataFilter(clause);
if (dataFilter) return queryBuilder.filter(dataFilter);
return queryBuilder;
}

/*
* DA-V25-01: La operacion completa vive DENTRO del wrapper async elevado.
* elevate() devuelve una funcion async. Si se elevara wixData.query
* directamente, el resultado seria una Promise y .filter() no existiria.
*/
var runQuery = elevate(async function (params) {
var cmsQuery = wixData.query(params.dataCollectionId);
cmsQuery = applyFilter(cmsQuery, params.filter);
cmsQuery = applySort(cmsQuery, params.sort)
.limit(params.limit)
.skip(params.offset);
return cmsQuery.find(buildOptions(params.consistency));
});

var runCount = elevate(async function (params) {
var cmsQuery = wixData.query(params.dataCollectionId);
cmsQuery = applyFilter(cmsQuery, params.filter);
return cmsQuery.count(buildOptions(params.consistency));
});

var elevatedGet = elevate(async function (collection, id, options) {
return wixData.get(collection, id, options);
});

var elevatedInsert = elevate(async function (collection, item) {
return wixData.insert(collection, item);
});

var elevatedUpdate = elevate(async function (collection, item) {
return wixData.update(collection, item);
});

var elevatedRemove = elevate(async function (collection, id) {
return wixData.remove(collection, id);
});

var elevatedSave = elevate(async function (collection, item) {
return wixData.save(collection, item);
});

var elevatedBulkInsert = elevate(async function (collection, items) {
return wixData.bulkInsert(collection, items);
});

var elevatedBulkUpdate = elevate(async function (collection, items) {
return wixData.bulkUpdate(collection, items);
});

var elevatedBulkRemove = elevate(async function (collection, ids) {
return wixData.bulkRemove(collection, ids);
});

var elevatedQueryReferenced = elevate(async function (collection, id, fieldName) {
return wixData.queryReferenced(collection, id, fieldName);
});

export async function queryReferencedItems(collection, id, fieldName, consistency) {
var result = await elevatedQueryReferenced(collection, id, fieldName);
return Array.isArray(result) ? result : (result && result.items) || [];
}

export async function queryFirstItem(params) {
var result = await runQuery({
dataCollectionId: params.dataCollectionId,
filter: params.filter,
limit: 1,
offset: 0,
consistency: params.consistency
});
return (result && result.items && result.items[0]) || null;
}

class QueryBuilder {
constructor(dataCollectionId, clauses, sort, limit, offset, consistency) {
this._collection = dataCollectionId;
this._clauses = clauses || [];
this._sort = sort || [];
this._limit = limit;
this._offset = offset || 0;
this._consistency = consistency || null;
}

_with(changes) {
return new QueryBuilder(
this._collection,
changes.clauses !== undefined ? changes.clauses : this._clauses,
changes.sort !== undefined ? changes.sort : this._sort,
changes.limit !== undefined ? changes.limit : this._limit,
changes.offset !== undefined ? changes.offset : this._offset,
changes.consistency !== undefined ? changes.consistency : this._consistency
);
}

_add(clause) {
var newClauses = this._clauses.slice();
newClauses.push(clause);
return this._with({ clauses: newClauses });
}

_filter() {
if (this._clauses.length === 0) return undefined;
if (this._clauses.length === 1) return this._clauses[0];
return wql.and.apply(wql, this._clauses);
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
startsWith(field, value) { return this._add(wql.startsWith(field, value)); }

contains(field, value) {
if (/Ids?$/.test(String(field))) {
return this.hasSome(field, [value]);
}
return this.startsWith(field, value);
}

ascending() {
var fields = [];
for (var i = 0; i < arguments.length; i++) {
fields.push(arguments[i] + " ASC");
}
var newSort = this._sort.slice();
for (var j = 0; j < fields.length; j++) {
newSort.push(fields[j]);
}
return this._with({ sort: newSort });
}

descending() {
var fields = [];
for (var i = 0; i < arguments.length; i++) {
fields.push(arguments[i] + " DESC");
}
var newSort = this._sort.slice();
for (var j = 0; j < fields.length; j++) {
newSort.push(fields[j]);
}
return this._with({ sort: newSort });
}

limit(value) { return this._with({ limit: value }); }
skip(value) { return this._with({ offset: value }); }

get(id) { return getItem(this._collection, id, this._consistency); }
insert(item) { return insertItem(this._collection, item); }
update(item) { return updateItem(this._collection, item); }
save(item) { return saveItem(this._collection, item); }
remove(idOrItem) { return removeById(this._collection, idOrItem); }

async find(options) {
var opts = options || {};
var consistency = opts.consistencyMode || this._consistency || undefined;
var offset = normalizeOffset(this._offset);
var result = await this._runPage(offset, consistency);
return this._pageResult(result, offset, consistency);
}

_runPage(offset, consistency) {
return queryItems({
dataCollectionId: this._collection,
filter: this._filter(),
sort: this._sort,
limit: this._limit,
offset: offset,
consistency: consistency
});
}

_pageResult(result, offset, consistency) {
var itemsList = (result && result.items) || [];
var totalCount = Number.isFinite(result && result.totalCount)
? result.totalCount
: offset + itemsList.length;
var builder = this;
return {
items: itemsList,
length: itemsList.length,
totalCount: totalCount,
hasNext: function () {
return offset + itemsList.length < totalCount;
},
next: async function () {
if (itemsList.length === 0) {
return builder._pageResult(
{ items: [], totalCount: totalCount },
offset,
consistency
);
}
var nextOffset = offset + itemsList.length;
var nextResult = await builder._runPage(nextOffset, consistency);
return builder._pageResult(nextResult, nextOffset, consistency);
}
};
}

count(options) {
var opts = options || {};
return countItems(
this._collection,
this._filter(),
opts.consistencyMode || this._consistency || undefined
);
}
}

export function query(dataCollectionId) {
return new QueryBuilder(dataCollectionId);
}

export async function queryItems(params) {
var pageLimit = normalizeLimit(params.limit != null ? params.limit : 100);
var pageOffset = normalizeOffset(params.offset);
var result = await runQuery({
dataCollectionId: params.dataCollectionId,
filter: params.filter,
sort: params.sort,
limit: pageLimit,
offset: pageOffset,
consistency: params.consistency
});
var itemsList = (result && result.items) || [];
var totalCount = Number.isFinite(result && result.totalCount)
? result.totalCount
: pageOffset + itemsList.length;
var hasNext = pageOffset + itemsList.length < totalCount;
return {
items: itemsList,
totalCount: totalCount,
hasNext: hasNext,
next: hasNext
? function () {
return queryItems({
dataCollectionId: params.dataCollectionId,
filter: params.filter,
sort: params.sort,
limit: pageLimit,
offset: pageOffset + itemsList.length,
consistency: params.consistency
});
}
: null
};
}

export async function getItem(collection, id, consistency) {
try {
return await elevatedGet(collection, id, buildOptions(consistency));
} catch (error) {
if (String((error && error.message) || "").indexOf("WDE0073") >= 0) return null;
throw error;
}
}

export async function countItems(collection, filter, consistency) {
var count = await runCount({
dataCollectionId: collection,
filter: filter,
consistency: consistency
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
var id;
if (idOrItem && typeof idOrItem === "object") {
id = idOrItem._id || idOrItem.id;
} else {
id = idOrItem;
}
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
