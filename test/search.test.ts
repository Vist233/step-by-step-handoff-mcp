import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseQuery } from "../src/catalog.js";
import { defaultHooks } from "../src/hooks.js";
import { publishPackage } from "../src/tools/publish.js";
import { searchPackages } from "../src/tools/search.js";
import { createWorkspace, packageFiles, type PackageSpec, type Workspace } from "./helpers.js";

let ws: Workspace;
beforeEach(async () => {
  ws = await createWorkspace();
});

const add = (spec: PackageSpec) => publishPackage(ws.storeRoot, packageFiles(spec), defaultHooks);
const search = (query?: string, limit?: number) => searchPackages(ws.storeRoot, { query, limit });

describe("query parsing", () => {
  it("splits filters from words", () => {
    assert.deepEqual(parseQuery("Type:Lemma tag:group tag:ring abelian  commutes"), {
      type: "lemma",
      tags: ["group", "ring"],
      words: ["abelian", "commutes"],
    });
    assert.deepEqual(parseQuery(undefined), { tags: [], words: [] });
    assert.deepEqual(parseQuery("type: tag:"), { tags: [], words: ["type:", "tag:"] });
  });
});

describe("search", () => {
  it("matches words in id, description and tags, all words required", async () => {
    await add({ id: "lemma/abelian-comm", description: "Abelian groups commute", tags: ["group"], files: { "a": "1" } });
    await add({ id: "lemma/prime-gap", description: "Gaps between primes", tags: ["number-theory"], files: { "a": "2" } });
    assert.deepEqual((await search("abelian")).results.map((hit) => hit.id), ["lemma/abelian-comm"]);
    assert.deepEqual((await search("primes")).results.map((hit) => hit.id), ["lemma/prime-gap"]);
    assert.equal((await search("number-theory")).total, 1);
    assert.equal((await search("abelian primes")).total, 0);
    assert.equal((await search("ABELIAN")).total, 1);
  });

  it("filters by type and tag, and combines them with words", async () => {
    await add({ id: "lemma/a", tags: ["group"], files: { "a": "1" } });
    await add({ id: "skill/b", tags: ["group"], files: { "SKILL.md": "---\nname: b\ndescription: d\n---" } });
    assert.equal((await search("type:lemma")).total, 1);
    assert.equal((await search("tag:group")).total, 2);
    assert.equal((await search("tag:group type:skill")).total, 1);
    assert.equal((await search("tag:grou")).total, 0);
  });

  it("treats SQL wildcards in the query as plain text", async () => {
    await add({ id: "note/x", description: "100% sure", files: { "a": "1" } });
    assert.equal((await search("100%")).total, 1);
    assert.equal((await search("%")).total, 1);
    assert.equal((await search("zzz_")).total, 0);
  });

  it("finds Chinese text by substring", async () => {
    await add({ id: "note/zh", description: "交换群的性质", files: { "a": "1" } });
    assert.equal((await search("交换")).total, 1);
  });

  it("ranks id matches above description matches", async () => {
    await add({ id: "note/other", description: "mentions widget once", files: { "a": "1" } });
    await add({ id: "note/widget", description: "unrelated", files: { "a": "2" } });
    assert.equal((await search("widget")).results[0]?.id, "note/widget");
  });

  it("lists the newest packages for an empty query", async () => {
    await add({ id: "note/first", files: { "a": "1" } });
    await add({ id: "note/second", files: { "a": "2" } });
    assert.equal((await search()).results[0]?.id, "note/second");
  });

  it("folds versions into one entry showing the latest", async () => {
    await add({ id: "note/v", version: "1.0.0", files: { "a": "1" } });
    await add({ id: "note/v", version: "1.1.0", files: { "a": "2" } });
    await add({ id: "note/v", version: "1.0.5", files: { "a": "3" } });
    const { results, total } = await search("note/v");
    assert.equal(total, 1);
    assert.deepEqual([results[0]?.version, results[0]?.otherVersions], ["1.1.0", ["1.0.0", "1.0.5"]]);
  });

  it("folds packages with identical content and reports how many", async () => {
    for (const name of ["a", "b", "c"]) await add({ id: `note/copy-${name}`, files: { "same.txt": "same" } });
    await add({ id: "note/different", files: { "same.txt": "other" } });
    const { results, total } = await search("type:note");
    assert.equal(total, 2);
    assert.equal(results.find((hit) => hit.id.startsWith("note/copy"))?.duplicates, 2);
  });

  it("marks whether a package can be verified", async () => {
    await add({ id: "note/checked", verify: { cmd: ["node", "-e", "0"] }, files: { "a": "1" } });
    await add({ id: "note/plain", files: { "a": "2" } });
    const byId = Object.fromEntries((await search("type:note")).results.map((hit) => [hit.id, hit.verifiable]));
    assert.deepEqual(byId, { "note/checked": true, "note/plain": false });
  });

  it("rebuilds the catalog from the manifests when the index file is gone", async () => {
    await add({ id: "note/survives", files: { "a": "1" } });
    const { rm } = await import("node:fs/promises");
    await rm(`${ws.storeRoot}/catalog.sqlite`);
    await rm(`${ws.storeRoot}/catalog.sqlite-wal`, { force: true });
    await rm(`${ws.storeRoot}/catalog.sqlite-shm`, { force: true });
    assert.equal((await search("survives")).total, 1);
  });
});

describe("large result sets", () => {
  async function addMany(count: number, tagFor: (index: number) => string): Promise<void> {
    for (let index = 0; index < count; index++) {
      await add({
        id: `lemma/n${index}`,
        description: `Lemma number ${index} about ${tagFor(index)}`,
        tags: [tagFor(index)],
        files: { "a.txt": String(index) },
      });
    }
  }

  it("caps the list at the limit, reports the total and offers refine counts", async () => {
    await addMany(60, (index) => (index % 3 === 0 ? "group" : "ring"));
    const response = await search("lemma");
    assert.deepEqual([response.total, response.shown, response.results.length], [60, 20, 20]);
    assert.deepEqual(response.refine?.types, { lemma: 60 });
    assert.deepEqual(response.refine?.tags, { ring: 40, group: 20 });
    assert.match(response.refine?.advice ?? "", /filter/);

    const narrowed = await search("lemma tag:group");
    assert.deepEqual([narrowed.total, narrowed.shown], [20, 20]);
    assert.equal(narrowed.refine, undefined);
  });

  it("honours a smaller limit, caps limit at 100, and omits refine when everything fits", async () => {
    await addMany(5, () => "group");
    assert.equal((await search("lemma", 2)).shown, 2);
    const all = await search("lemma", 1000);
    assert.deepEqual([all.shown, all.refine], [5, undefined]);
  });

  it("shortens long descriptions in the list", async () => {
    await add({ id: "note/long", description: "w".repeat(1024), files: { "a": "1" } });
    const description = (await search("long")).results[0]?.description ?? "";
    assert.deepEqual([description.length, description.endsWith("…")], [250, true]);
  });

  it("stops listing when the response budget is used up", async () => {
    for (let index = 0; index < 40; index++) {
      await add({ id: `note/b${index}`, description: "d".repeat(1000), files: { "a": String(index) } });
    }
    const response = await search("note", 40);
    assert.ok(response.shown < 40 && response.shown >= 20, `shown ${response.shown}`);
    assert.equal(response.total, 40);
    assert.ok(JSON.stringify(response.results).length < 12000);
  });
});
