import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { defaultHooks, type Hooks } from "../src/hooks.js";
import { blobPath } from "../src/store.js";
import { peekPackage, pullPackage } from "../src/tools/pull.js";
import { publishPackage } from "../src/tools/publish.js";
import { searchPackages } from "../src/tools/search.js";
import { createWorkspace, FAIL, packageFiles, PASS, writePackage, type Workspace } from "./helpers.js";

let ws: Workspace;
beforeEach(async () => {
  ws = await createWorkspace();
});

const publish = async (spec: Parameters<typeof writePackage>[1], hooks: Hooks = defaultHooks) =>
  publishPackage(ws.storeRoot, await writePackage(ws.sourceRoot, spec), hooks);
const pull = (request: Parameters<typeof pullPackage>[2], hooks: Hooks = defaultHooks) =>
  pullPackage(ws.storeRoot, ws.workDir, request, hooks);

describe("publish and pull", () => {
  it("hands a package with a dependency to another workspace and verifies it there", async () => {
    await publish({ id: "note/base", verify: { cmd: PASS } });
    const check = ["node", "-e", "require('fs').accessSync('../base/data.txt')"];
    const published = await publish({ id: "note/top", deps: [{ id: "note/base" }], verify: { cmd: check } });
    assert.equal(published.status, "accepted");

    const pulled = await pull({ id: "note/top", verify: true });
    assert.equal(pulled.verified, true);
    assert.deepEqual(pulled.pulled, ["note/base@1.0.0", "note/top@1.0.0"]);
    assert.equal(await readFile(join(ws.workDir, ".exchange/packages/note/base/data.txt"), "utf8"), "hello");
    const lock = JSON.parse(await readFile(join(ws.workDir, ".exchange/exchange.lock"), "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["note/base", "note/top"]);
  });

  it("reports verified as null when the package declares no check", async () => {
    await publish({ id: "note/plain" });
    assert.equal((await pull({ id: "note/plain", verify: true })).verified, null);
  });

  it("rejects a package whose check fails and stores nothing", async () => {
    const result = await publish({ id: "note/bad", verify: { cmd: FAIL } });
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /nope/);
    assert.equal((await searchPackages(ws.storeRoot, {})).total, 0);
  });

  it("surfaces the failing output when pull verification fails", async () => {
    await publish({ id: "note/ok" });
    const failing: Hooks = { ...defaultHooks, verify: async () => ({ ok: false, exitCode: 1, timedOut: false, outputTail: "boom" }) };
    const pulled = await pull({ id: "note/ok", verify: true }, failing);
    assert.deepEqual([pulled.verified, pulled.verifyOutput], [false, "boom"]);
  });

  it("refuses to overwrite an existing version", async () => {
    await publish({ id: "note/once" });
    await assert.rejects(publish({ id: "note/once" }), /already exists/);
  });

  it("detects a tampered blob when pulling", async () => {
    await publish({ id: "note/tamper" });
    await pull({ id: "note/tamper" });
    const manifest = JSON.parse(await readFile(join(ws.workDir, ".exchange/packages/note/tamper/handoff.json"), "utf8"));
    await writeFile(blobPath(ws.storeRoot, manifest.files[0].hash), "evil");
    await assert.rejects(pull({ id: "note/tamper" }), /Hash mismatch/);
  });

  it("picks the latest version, and a pinned one with id@version", async () => {
    await publish({ id: "note/v", version: "1.2.0" });
    await publish({ id: "note/v", version: "1.10.0" });
    assert.equal((await pull({ id: "note/v" })).version, "1.10.0");
    assert.equal((await pull({ id: "note/v@1.2.0" })).version, "1.2.0");
    await assert.rejects(pull({ id: "note/v@9.9.9" }), /not found/);
    await assert.rejects(pull({ id: "not-an-id" }), /Invalid package id/);
  });

  it("enforces a dependency digest pin", async () => {
    await publish({ id: "note/dep" });
    await assert.rejects(
      publish({ id: "note/pinned", deps: [{ id: "note/dep", digest: "0".repeat(64) }], verify: { cmd: PASS } }),
      /pinned digest/,
    );
  });
});

describe("publish sources", () => {
  it("accepts inline files for agents that cannot write files", async () => {
    const result = await publishPackage(ws.storeRoot, packageFiles({ id: "note/inline" }), defaultHooks);
    assert.equal(result.status, "accepted");
    assert.equal((await searchPackages(ws.storeRoot, { query: "inline" })).total, 1);
  });

  it("accepts handoff.json given as an object", async () => {
    const files = { ...packageFiles({ id: "note/obj" }), "handoff.json": { id: "note/obj", version: "1.0.0", description: "d" } };
    assert.equal((await publishPackage(ws.storeRoot, files, defaultHooks)).status, "accepted");
  });

  it("explains a missing handoff.json", async () => {
    await assert.rejects(publishPackage(ws.storeRoot, { "a.txt": "x" }, defaultHooks), /handoff\.json is missing/);
  });

  it("refuses inline file names that escape the package", async () => {
    const files = { ...packageFiles({ id: "note/esc" }), "../evil.txt": "x" };
    await assert.rejects(publishPackage(ws.storeRoot, files, defaultHooks), /escapes/);
  });

  it("validates handoff.json fields", async () => {
    await assert.rejects(publish({ id: "bad id" }), /./);
    await assert.rejects(publish({ id: "note/x", version: "1.0" }), /./);
    await assert.rejects(publish({ id: "note/x", description: "d".repeat(1025) }), /./);
    await assert.rejects(publish({ id: "note/x", tags: ["Has Space"] }), /./);
  });

  it("refuses a verify directory that escapes the package", async () => {
    await assert.rejects(publish({ id: "note/escape", verify: { cmd: PASS, cwd: "../.." } }), /escapes/);
  });

  it("publishes concurrently without losing packages", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => publish({ id: `note/c${index}`, files: { "data.txt": `c${index}` } })));
    assert.equal((await searchPackages(ws.storeRoot, { query: "type:note" })).total, 12);
  });
});

describe("review and verify hooks", () => {
  it("accepts by default because the review is empty", async () => {
    assert.equal((await publish({ id: "note/open" })).status, "accepted");
  });

  it("lets a custom review reject and records the reason", async () => {
    const strict: Hooks = { ...defaultHooks, review: async () => ({ approved: false, reason: "secret found" }) };
    const result = await publish({ id: "note/no" }, strict);
    assert.deepEqual([result.status, result.reason], ["rejected", "secret found"]);
    assert.equal((await searchPackages(ws.storeRoot, {})).total, 0);
  });

  it("hands the review the manifest and the files", async () => {
    let seen = "";
    const spy: Hooks = {
      ...defaultHooks,
      review: async ({ manifest, packageDir }) => {
        seen = `${manifest.id}:${(await stat(join(packageDir, "data.txt"))).size}`;
        return { approved: true, reason: "" };
      },
    };
    await publish({ id: "note/spy" }, spy);
    assert.equal(seen, "note/spy:5");
  });

  it("lets a custom verify function replace the command", async () => {
    const never: Hooks = { ...defaultHooks, verify: async () => ({ ok: false, exitCode: 9, timedOut: false, outputTail: "agent says no" }) };
    const result = await publish({ id: "note/judged", verify: { cmd: PASS } }, never);
    assert.match(result.reason, /agent says no/);
  });
});

describe("skill packages", () => {
  const skill = (name: string, front: string) => ({ id: `skill/${name}`, files: { "SKILL.md": `---\n${front}\n---\nbody` } });

  it("requires SKILL.md with a matching name and a description", async () => {
    await assert.rejects(publish({ id: "skill/none", files: { "readme.txt": "x" } }), /SKILL\.md/);
    await assert.rejects(publish(skill("half", "name: half")), /description/);
    await assert.rejects(publish(skill("other", "name: wrong\ndescription: d")), /must equal/);
    assert.equal((await publish(skill("ok", "name: ok\ndescription: Does a thing"))).status, "accepted");
  });
});

describe("peek (pull with path)", () => {
  beforeEach(async () => {
    await publish({
      id: "note/peek",
      description: "A peekable note",
      tags: ["demo"],
      files: { "a.txt": "alpha", "dir/b.txt": "beta", "bin.dat": "\u0000\u0001binary" },
      verify: { cmd: PASS },
    });
  });

  it('lists files and metadata for path "." and writes nothing to the workspace', async () => {
    const listing = await peekPackage(ws.storeRoot, { id: "note/peek", path: "." });
    assert.deepEqual(listing.files?.map((file) => file.path), ["a.txt", "bin.dat", "dir/b.txt"]);
    assert.equal(listing.description, "A peekable note");
    assert.match(listing.notice, /another agent/);
    await assert.rejects(stat(join(ws.workDir, ".exchange")));
  });

  it("treats empty path and ./ prefixes like the root and the file", async () => {
    assert.ok((await peekPackage(ws.storeRoot, { id: "note/peek", path: "" })).files);
    assert.equal((await peekPackage(ws.storeRoot, { id: "note/peek", path: "./a.txt" })).content, "alpha");
    assert.equal((await peekPackage(ws.storeRoot, { id: "note/peek", path: "dir/b.txt" })).content, "beta");
  });

  it("does not return binary content", async () => {
    const result = await peekPackage(ws.storeRoot, { id: "note/peek", path: "bin.dat" });
    assert.deepEqual([result.binary, result.content], [true, undefined]);
  });

  it("refuses files that are not in the package, including traversal attempts", async () => {
    await assert.rejects(peekPackage(ws.storeRoot, { id: "note/peek", path: "nope.txt" }), /has no file/);
    await assert.rejects(peekPackage(ws.storeRoot, { id: "note/peek", path: "../../etc/passwd" }), /has no file/);
  });

  it("truncates very large files", async () => {
    await publish({ id: "note/big", files: { "big.txt": "x".repeat(30000) } });
    const result = await peekPackage(ws.storeRoot, { id: "note/big", path: "big.txt" });
    assert.deepEqual([result.content?.length, result.truncated], [20000, true]);
  });
});
