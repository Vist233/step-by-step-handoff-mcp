import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, it } from "node:test";
import { createHandoff } from "../src/lib.js";
import { findPackage } from "../src/store.js";
import { createWorkspace, FAIL, packageFiles, PASS, type Workspace } from "./helpers.js";

let ws: Workspace;
beforeEach(async () => {
  ws = await createWorkspace();
});

describe("library entry", () => {
  it("lets two agents in one process share a store with their own working directories and authors", async () => {
    // an environment variable of the process must not decide the author: that is the point of the entry
    process.env.HANDOFF_AGENT_ID = "from-the-environment";
    const alice = createHandoff({ storeRoot: ws.storeRoot, workDir: `${ws.workDir}/alice`, agentId: "alice" });
    const bob = createHandoff({ storeRoot: ws.storeRoot, workDir: `${ws.workDir}/bob`, agentId: "bob" });

    const published = await alice.publish(packageFiles({ id: "lemma/twelve", verify: { cmd: PASS } }));
    assert.equal(published.status, "accepted");
    assert.equal((await findPackage(ws.storeRoot, "lemma/twelve")).manifest.provenance.author, "alice");

    const found = await bob.search({ query: "type:lemma" });
    assert.deepEqual(found.results.map((hit) => hit.id), ["lemma/twelve"]);
    assert.equal((await bob.peek({ id: "lemma/twelve", path: "data.txt" })).content, "hello");

    const pulled = await bob.pull({ id: "lemma/twelve", verify: true });
    assert.equal(pulled.verified, true);
    assert.ok(pulled.path.startsWith(`${ws.workDir}/bob/`), pulled.path);
    assert.equal(await readFile(`${pulled.path}/data.txt`, "utf8"), "hello");
  });

  it("applies the hooks of the handle that was given them, and no others", async () => {
    const strict = createHandoff({
      storeRoot: ws.storeRoot,
      workDir: ws.workDir,
      hooks: { review: async () => ({ approved: false, reason: "not today" }) },
    });
    const plain = createHandoff({ storeRoot: ws.storeRoot, workDir: ws.workDir });
    const refused = await strict.publish(packageFiles({ id: "note/a", verify: { cmd: PASS } }));
    assert.deepEqual([refused.status, refused.reason], ["rejected", "not today"]);
    assert.equal((await plain.publish(packageFiles({ id: "note/a", verify: { cmd: PASS } }))).status, "accepted");
    assert.equal((await plain.publish(packageFiles({ id: "note/b", verify: { cmd: FAIL } }))).status, "rejected");
  });

  it("refuses relative paths instead of resolving them against the current directory", () => {
    assert.throws(() => createHandoff({ storeRoot: "store", workDir: ws.workDir }), /storeRoot must be an absolute path/);
    assert.throws(() => createHandoff({ storeRoot: ws.storeRoot, workDir: "work" }), /workDir must be an absolute path/);
  });

  it("is declared in the exports map next to the MCP server entry", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(manifest.exports["."].default, "./dist/server.js");
    assert.equal(manifest.exports["./core"].default, "./dist/lib.js");
    assert.equal(manifest.exports["./core"].types, "./dist/lib.d.ts");
  });
});
