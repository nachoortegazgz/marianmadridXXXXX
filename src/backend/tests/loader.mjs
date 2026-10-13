/*
=============================================================================
MODULE: backend/tests/loader.mjs
PURPOSE: Offline test harness. Registers ESM loader hooks that mock every
"wix-*" module and map "backend/<name>" specifiers to src/backend/<name>.js,
so the real backend code can be imported and exercised with `node --test`
without a Wix Velo runtime and without node_modules.
SCOPE: tests only. Never imported by production code. G10 ASCII strict.
=============================================================================
*/

import { pathToFileURL } from 'node:url';
import { fileURLToPath, pathToFileURL as p2u } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/backend/tests -> src/backend
export const BACKEND_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock registry (mutable so tests can seed data / inspect calls)
// ---------------------------------------------------------------------------

export const wixDataMock = {
  _store: new Map(),          // collectionName -> array of items
  _calls: [],                 // audit trail of operations
  _seed(collection, items) {
    // JSON round-trip would serialize Date instances to ISO strings and
    // break date comparisons in queries (.lt/_createdDate). Revive ISO
    // strings back into Date objects so seeded rows match live Velo types.
    const revived = JSON.parse(JSON.stringify(items), (key, value) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? value : d;
      }
      return value;
    });
    this._store.set(collection, revived);
  },
  _reset() {
    this._store.clear();
    this._calls.length = 0;
  },
  query(collection) {
    const rows = () => this._store.get(collection) || [];
    const state = { filters: [], limitN: 30 };
    const cmpValue = (v) => (v instanceof Date ? v.getTime() : v);
    // Real Velo semantics: filter methods (eq/in/lt...) return the same
    // WixDataQuery, so .eq(...).limit(1).count() chains legally. The mock
    // mirrors that by returning `q` from every builder method.
    const q = {};
    q.eq = (field, value) => { state.filters.push([field, value]); return q; };
    q.in = (field, values) => { state.filters.push([field, values]); return q; };
    q.ne = (field, value) => { state.filters.push(['!=', field, value]); return q; };
    q.lt = (field, value) => { state.filters.push(['<', field, value]); return q; };
    q.gt = (field, value) => { state.filters.push(['>', field, value]); return q; };
    q.le = (field, value) => { state.filters.push(['<=', field, value]); return q; };
    q.ge = (field, value) => { state.filters.push(['>=', field, value]); return q; };
    q.between = (field, low, high) => { state.filters.push(['range', field, low, high]); return q; };
    q.contains = (field, value) => { state.filters.push(['has', field, value]); return q; };
    q.hasSome = (field, values) => { state.filters.push(['some', field, values]); return q; };
    q.ascending = () => q;
    q.descending = () => q;
    q.limit = (n) => { state.limitN = n; return q; };
    const applyFilters = () => {
      let items = rows().slice();
      for (const f of state.filters) {
        if (f[0] === '!=') { items = items.filter((it) => it[f[1]] !== f[2]); }
        else if (f[0] === '<') { items = items.filter((it) => cmpValue(it[f[1]]) < cmpValue(f[2])); }
        else if (f[0] === '>') { items = items.filter((it) => cmpValue(it[f[1]]) > cmpValue(f[2])); }
        else if (f[0] === '<=') { items = items.filter((it) => cmpValue(it[f[1]]) <= cmpValue(f[2])); }
        else if (f[0] === '>=') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2])); }
        else if (f[0] === 'range') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2]) && cmpValue(it[f[1]]) <= cmpValue(f[3])); }
        else if (f[0] === 'has') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].includes(f[2])); }
        else if (f[0] === 'some') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].some((v) => f[2].includes(v))); }
        else if (Array.isArray(f[1])) { items = items.filter((it) => f[1].includes(it[f[0]])); }
        else { items = items.filter((it) => it[f[0]] === f[1]); }
      }
      return items;
    };
    q.count = async () => {
      this._calls.push({ op: 'query', collection });
      return applyFilters().length;
    };
    q.find = async () => {
      this._calls.push({ op: 'query', collection });
      const items = applyFilters().slice(0, state.limitN);
      return { items, total: items.length };
    };
    return q;
  },
  get: async (collection, id) => {
    wixDataMock._calls.push({ op: 'get', collection });
    const rows = wixDataMock._store.get(collection) || [];
    return rows.find((r) => r._id === id) || null;
  },
  queryReferencedItems: async (collection, itemId, field) => {
    wixDataMock._calls.push({ op: 'queryReferencedItems', collection });
    const source = (wixDataMock._store.get(collection) || []).find((row) => row._id === itemId);
    const ids = Array.isArray(source?.[field]) ? source[field] : [];
    return { items: ids.map((value) => typeof value === 'object' ? value : { _id: value }) };
  },
  insert: async (collection, item) => {
    wixDataMock._calls.push({ op: 'insert', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const saved = { _id: 'mock_' + (rows.length + 1), ...item };
    rows.push(saved);
    wixDataMock._store.set(collection, rows);
    return saved;
  },
  update: async (collection, item) => {
    wixDataMock._calls.push({ op: 'update', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    return item;
  },
  remove: async (collection, item) => {
    wixDataMock._calls.push({ op: 'remove', collection });
    // Real Velo semantics: remove() deletes the row (accepts _id or object).
    // Purge crons (cleanAuditLogs et al.) assert against store state after
    // running, so the mock must actually mutate it.
    const id = (item && typeof item === 'object') ? item._id : item;
    const rows = wixDataMock._store.get(collection) || [];
    wixDataMock._store.set(collection, rows.filter((r) => r._id !== id));
    return item;
  },
};

export const mocks = {
  wixData: wixDataMock,
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    _calls: [],
  },
};

const GENERIC_STUB_SOURCE = `
const fnProxy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'then') return undefined;
    return fnProxy;
  },
  apply: () => fnProxy,
});
export const webMethod = (...args) => {
  // Real Velo semantics: webMethod(perm..., handler) returns the handler
  // (optionally wrapped). Tests call the exported handlers directly, so the
  // last function argument must be returned as-is.
  const fns = args.filter((a) => typeof a === 'function');
  return fns.length ? fns[fns.length - 1] : (handlerFn) => handlerFn;
};
export const Permissions = { Admin: 'ADMIN', SiteMember: 'MEMBER', Public: 'PUBLIC', Anyone: 'ANYONE' };
export const currentMember = fnProxy;
export const locations = fnProxy;
export const bookingsBackend = fnProxy;
export const paymentsBackend = fnProxy;
export const transactions = fnProxy;
export const media = fnProxy;
export const crypto = fnProxy;
export const members = { getCurrentMember: async () => null };
export const secrets = { getSecretValue: async () => "mock-secret" };
// auth.elevate (@wix/essentials): identidad, igual que elevate (ver abajo).
export const auth = { elevate: (fn) => fn };
// Named SDK exports imported by backend code (offline stubs):
export const availabilityTimeSlots = fnProxy;
export const bookings = fnProxy;
export const checkout = fnProxy;
export const orders = fnProxy;
export const elevate = fnProxy;
export const createClient = () => fnProxy;
export const getSecret = async () => "mock-secret";
export function _namedExportFallback(name) { return fnProxy; }
const handler = { get: (t, p) => {
  if (p === 'then') return undefined;
  if (p === 'webMethod') return webMethod;
  if (p === 'Permissions') return Permissions;
  if (p === 'default') return fnProxy;
  if (!(p in t)) { t[p] = fnProxy; }
  return t[p];
} };
const mod = new Proxy({ default: fnProxy }, handler);
export default mod.default;
`;

/* LH-01 (fix derivado de tests 2026-10-13): dataAccess.js usa la API v2
   ({ query(dataCollectionId, { filter, sort }, opts) }) mientras el builder
   legacy usa la v1 (query(col).eq().find()). Ambos confluyen en el mismo
   store del mock. Este adaptador v2 traduce filtros MongoQL ($eq/$ne/$gt/
   $gte/$lt/$lte/$in/$nin/$hasSome/$startsWith y composicion $and) al motor
   de filtrado ya verificado del mock, para que los purga-crons (que van por
   dataLegacyAdapter -> dataAccess) operen offline con las mismas filas. */
const WIX_DATA_V2_SOURCE = `
import { wixDataMock as m } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\\\/g, '/'))};

const cmpValue = (v) => (v instanceof Date ? v.getTime() : v);
const startsWithStr = (s, p) => String(s ?? '').startsWith(String(p));

// LH-02 (fix derivado de tests 2026-10-13): el SDK v2 real admite BOTH filter
// shapes: (a) explicit operator object { $eq: {...}, $and: [...] } and (b) the
// shorthand field-centric form produced by dataAccess.wql.eq(field, value),
// which is literally { [field]: { $eq: value } } -- a bare fieldName key whose
// value is an operator map. The previous matcher only understood shape (a), so
// every .eq()/wql.eq() query threw "operador no soportado bookingId" and the
// DTO-whitelist webMethods failed. This mirrors official Wix Data API v2
// semantics (queryItems filter accepts field:{op:value} maps directly).
function matchOperators(it, ops) {
  return Object.entries(ops).every(([op, arg]) => {
    switch (op) {
      case '$eq': return it[op_field] === arg;
      case '$ne': return it[op_field] !== arg;
      case '$gt': return cmpValue(it[op_field]) > cmpValue(arg);
      case '$gte': return cmpValue(it[op_field]) >= cmpValue(arg);
      case '$lt': return cmpValue(it[op_field]) < cmpValue(arg);
      case '$lte': return cmpValue(it[op_field]) <= cmpValue(arg);
      case '$in': return Array.isArray(arg) && arg.includes(it[op_field]);
      case '$nin': return Array.isArray(arg) && !arg.includes(it[op_field]);
      // LH-05 (fix derivado de tests 2026-10-14, CRON-AUDIT-01): el SDK v2
      // real aplica $hasSome TAMBIEN a campos escalares (membresia del valor
      // en el conjunto de candidatos), no solo a arrays. El adapter legacy
      // traduce .in(field, values) a $hasSome para escalares; sin este
      // soporte escalar la query de purga devolvia 0 filas offline.
      case '$hasSome': return Array.isArray(it[op_field])
        ? (arg || []).some((x) => it[op_field].includes(x))
        : Array.isArray(arg) && arg.includes(it[op_field]);
      case '$startsWith': return startsWithStr(it[op_field], arg);
      default: throw new Error('loader mock v2: operador no soportado ' + op);
    }
  });
}

let op_field = null; // set by matchOne before delegating to matchOperators

function matchOne(it, clause) {
  if (!clause || typeof clause !== 'object') return true;
  return Object.entries(clause).every(([key, val]) => {
    if (key.startsWith('$')) {
      switch (key) {
        case '$and': return (val || []).every((c) => matchOne(it, c));
        case '$or': return (val || []).some((c) => matchOne(it, c));
        case '$eq': return Object.entries(val).every(([f, v]) => it[f] === v);
        case '$ne': return Object.entries(val).every(([f, v]) => it[f] !== v);
        case '$gt': return Object.entries(val).every(([f, v]) => cmpValue(it[f]) > cmpValue(v));
        case '$gte': return Object.entries(val).every(([f, v]) => cmpValue(it[f]) >= cmpValue(v));
        case '$lt': return Object.entries(val).every(([f, v]) => cmpValue(it[f]) < cmpValue(v));
        case '$lte': return Object.entries(val).every(([f, v]) => cmpValue(it[f]) <= cmpValue(v));
        case '$in': return Object.entries(val).every(([f, v]) => Array.isArray(v) && v.includes(it[f]));
        case '$nin': return Object.entries(val).every(([f, v]) => Array.isArray(v) && !v.includes(it[f]));
        // LH-05: misma semantica escalar/array que matchOperators.
        case '$hasSome': return Object.entries(val).every(([f, v]) => Array.isArray(it[f])
          ? (v || []).some((x) => it[f].includes(x))
          : Array.isArray(v) && v.includes(it[f]));
        case '$startsWith': return Object.entries(val).every(([f, v]) => startsWithStr(it[f], v));
        default: throw new Error('loader mock v2: operador no soportado ' + key);
      }
    }
    // Field-centric shorthand: { fieldName: { $op: value } }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      op_field = key;
      return matchOperators(it, val);
    }
    // Bare equality shorthand: { fieldName: value }
    return it[key] === val;
  });
}

function applyV2Filter(items, filter) {
  if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) return items;
  return items.filter((it) => matchOne(it, filter));
}

function applyV2Sort(items, sort) {
  if (!Array.isArray(sort) || sort.length === 0) return items;
  const copy = items.slice();
  copy.sort((a, b) => {
    for (const s of sort) {
      const dir = (s.direction === 'DESC' || s.direction === -1) ? -1 : 1;
      const av = cmpValue(a[s.field]), bv = cmpValue(b[s.field]);
      if (av < bv) return -dir;
      if (av > bv) return dir;
    }
    return 0;
  });
  return copy;
}

// LH-03 (fix derivado de tests 2026-10-13): regla R2/SSOT-14 de
// backend/dataAccess.js establece que los hooks de backend/data.js se
// ejecutan SIEMPRE (ni suppressHooks ni suppressAuth los eximen). El mock
// v2 debe replicar esa autoridad para que los purga-crons operen offline
// con la misma semantica que en produccion: un beforeRemove que lanza
// (p.ej. WEBHOOK_EVENT append-only, ADR-05) bloquea el borrado real.
// Se importa data.js de forma estatica: no hay ciclo porque data.js solo
// importa dataAccess (resuelto aqui por este modulo), nunca @wix/data.
import * as DATA_HOOKS from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'data.js')).href.replace(/\\\\/g, '/'))};

const COLLECTION_PLAIN = {
  ControlOperativo: 'ControlOperativo',
  MovimientosCaja: 'MovimientosCaja',
  CitasF2: 'CitasF2',
  HistoricoCierresZ: 'HistoricoCierresZ',
  RegistrosHorariosStaff: 'RegistrosHorariosStaff',
  CajaActual: 'CajaActual',
  LibroAsientosContablesDetalle: 'LibroAsientosContablesDetalle',
  MovimientosInventario: 'MovimientosInventario',
  InventarioStockVenta: 'InventarioStockVenta',
};

function _hookName(col, phase) {
  const plain = COLLECTION_PLAIN[col];
  return plain ? plain + '_' + phase : null;
}

async function _runHook(name, ...args) {
  if (!name) return;
  const fn = DATA_HOOKS[name];
  if (typeof fn === 'function') await fn(...args);
}

export const items = {
  get: (col, id) => m.get(col, id),
  async insert(col, entity) {
    await _runHook(_hookName(col, 'beforeInsert'), entity);
    return m.insert(col, entity);
  },
  async update(col, entity, originalEntity) {
    await _runHook(_hookName(col, 'beforeUpdate'), entity, { original: originalEntity });
    return m.update(col, entity);
  },
  save: (col, entity) => m.save ? m.save(col, entity) : m.update(col, entity),
  async remove(col, idOrObj) {
    const id = (idOrObj && typeof idOrObj === 'object') ? idOrObj._id : idOrObj;
    const existing = await m.get(col, id);
    // Cadenas legacy pasan el objeto completo; resolver del store da la
    // fila autoritativa (incluye controlType/status aunque el caller
    // pase solo el id o una copia parcial).
    const row = (idOrObj && typeof idOrObj === 'object') ? { ...existing, ...idOrObj } : existing;
    await _runHook(_hookName(col, 'beforeRemove'), row);
    return m.remove(col, idOrObj);
  },
  async query(col, request = {}, opts = {}) {
    m._calls.push({ op: 'query_v2', collection: col });
    let its = applyV2Filter(m._store.get(col) || [], request.filter);
    its = applyV2Sort(its, request.sort);
    const offset = Number(request.offset) || 0;
    const limit = Number(request.limit ?? opts.limit ?? 30);
    const page = its.slice(offset, offset + limit);
    return { items: page, pagingMetadata: { count: page.length, total: its.length, offset, hasNext: offset + page.length < its.length } };
  },
  queryReferencedItems: (col, id, field) => m.queryReferencedItems(col, id, field),
};
export default m;
`;

const WIX_DATA_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
export const items = wixDataMock;
export default wixDataMock;
`;

// ---------------------------------------------------------------------------
// resolve/load hooks (used when run WITH --experimental-loader)
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('wix-') || specifier.startsWith('@wix/')) {
    // Offline harness: every Wix SDK package resolves to the generic stub.
    // wix-data keeps its dedicated in-memory mock below.
    return { url: 'mock:' + specifier, shortCircuit: true };
  }
  // LH-06 (fix derivado de tests 2026-10-14): el alias Velo "backend/data"
  // colisionaba con el archivo real de tests loader.mjs bajo la convencion
  // backend/<name> -> src/backend/<name>.js (resolvia a .../tests/loader.js,
  // inexistente), rompiendo la importacion estatica de los hooks de data.js
  // dentro del mock v2 y dejando los beforeRemove sin ejecutar offline.
  // Se resuelve explicitamente al modulo real src/backend/data.js.
  if (specifier === 'backend/data' || specifier === 'backend/data.js') {
    const abs = path.join(BACKEND_DIR, 'data.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve backend/data -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  if (specifier.startsWith('backend/') || specifier.startsWith('public/')) {
    const rel = specifier.includes('/') ? specifier.slice(specifier.indexOf('/') + 1) : specifier;
    const rootDir = specifier.startsWith('public/') ? path.join(BACKEND_DIR, '..', 'public') : BACKEND_DIR;
    const abs = path.join(rootDir, rel.endsWith('.js') ? rel : rel + '.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve Velo alias specifier ' + specifier + ' -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('mock:wix-data') || url === 'mock:@wix/data') {
    // @wix/data (API v2, usado por dataAccess.js) -> adaptador v2 sobre el
    // mismo store del mock. 'wix-data' (builder legacy v1) -> mock clasico.
    if (url === 'mock:@wix/data') {
      return { format: 'module', source: WIX_DATA_V2_SOURCE, shortCircuit: true };
    }
    return { format: 'module', source: WIX_DATA_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:')) {
    return { format: 'module', source: GENERIC_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
