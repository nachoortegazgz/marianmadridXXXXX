import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { wixDataMock } from "./loader.mjs";

const dataAccess = await import("backend/dataAccess.js");
const COLLECTION = "DataAccessWixQueryContract";

function seed() {
  wixDataMock._reset();
  wixDataMock._seed(COLLECTION, [
    { _id: "svc-1", slug: "corte-clasico", active: true, category: "HOMBRE", price: 25 },
    { _id: "svc-2", slug: "corte-mujer", active: true, category: "MUJER", price: 40 },
    { _id: "svc-3", slug: "color", active: false, category: "COLOR", price: 80 },
  ]);
}

test("CMS query builder compiles simple, compound, and range filters without WixDataQuery.filter", async () => {
  seed();

  const simple = await dataAccess.query(COLLECTION)
    .eq("slug", "corte-clasico")
    .find({ consistentRead: true });
  assert.deepEqual(simple.items.map((item) => item._id), ["svc-1"]);

  const compound = await dataAccess.query(COLLECTION)
    .eq("active", true)
    .eq("category", "HOMBRE")
    .find();
  assert.deepEqual(compound.items.map((item) => item._id), ["svc-1"]);

  const range = await dataAccess.query(COLLECTION)
    .gte("price", 40)
    .lte("price", 80)
    .find();
  assert.deepEqual(range.items.map((item) => item._id), ["svc-2", "svc-3"]);

  assert.equal(wixDataMock._filterCalls, 0, "plain WQL objects must not be passed to WixDataQuery.filter()");
});

test("CMS query compiler preserves WQL OR and IN semantics", async () => {
  seed();

  const result = await dataAccess.queryItems({
    dataCollectionId: COLLECTION,
    filter: dataAccess.wql.or(
      dataAccess.wql.eq("slug", "corte-clasico"),
      dataAccess.wql.eq("slug", "corte-mujer"),
    ),
  });
  assert.deepEqual(result.items.map((item) => item._id).sort(), ["svc-1", "svc-2"]);

  const inResult = await dataAccess.queryItems({
    dataCollectionId: COLLECTION,
    filter: dataAccess.wql.in("category", ["HOMBRE", "MUJER"]),
  });
  assert.deepEqual(inResult.items.map((item) => item._id).sort(), ["svc-1", "svc-2"]);
  assert.equal(wixDataMock._filterCalls, 0);
});

test("data access uses the Wix Data query builder and elevates execution", () => {
  const source = readFileSync(new URL("../dataAccess.js", import.meta.url), "utf8");
  assert.match(source, /wixDataItems\.query\(dataCollectionId\)/);
  assert.match(source, /auth\.elevate\(function \(runtimeOptions\)\s*\{\s*return method\.call\(query, runtimeOptions\);/);
  assert.match(source, /query = query\.limit\(normalizeLimit\(limit\)\)\.skip\(normalizeOffset\(offset\)\)/);
  assert.doesNotMatch(source, /wixDataItems\.count/);
  assert.doesNotMatch(source, /elevatedCall\(\s*wixDataItems\.query/);
  assert.doesNotMatch(source, /auth\.elevate\(function\s*\(\.\.\.runtimeArgs\)/);
  assert.doesNotMatch(source, /auth\.elevate\(method\.bind\(query\)\)\(options\)/);
  for (const operation of ["get", "insert", "update", "save", "remove"]) {
    assert.ok(source.includes("elevatedCall(wixDataItems." + operation), "missing direct elevation for " + operation);
  }
});

test("data access exposes only used operations and canonical consistency options", () => {
  for (const removedExport of [
    "bulkInsert",
    "bulkUpdate",
    "bulkRemove",
    "queryReferencedItems",
    "order",
  ]) {
    assert.equal(removedExport in dataAccess, false, `unexpected unused export: ${removedExport}`);
  }

  assert.equal("EVENTUAL" in dataAccess.CONSISTENCY, false);
  const source = readFileSync(new URL("../dataAccess.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /consistencyMode/);
  assert.doesNotMatch(source, /typeof consistency === "string"/);
});
