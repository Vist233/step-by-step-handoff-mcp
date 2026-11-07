import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultHooks, type Hooks } from "./hooks.js";
import { peekPackage, pullPackage } from "./tools/pull.js";
import { publishPackage } from "./tools/publish.js";
import { searchPackages } from "./tools/search.js";
import { resolveStoreRoot } from "./store.js";

export type { Hooks, HookContext, ReviewFn, VerifyFn, ReviewDecision } from "./hooks.js";
export { defaultHooks } from "./hooks.js";

type ToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

async function respond(work: () => Promise<unknown>): Promise<ToolResponse> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const SEARCH_DESCRIPTION = `Search packages that other agents published: skills, lemmas, datasets, patches, notes.
query: plain words, plus optional filters type:<type> and tag:<tag> (e.g. "type:lemma tag:group abelian"). Leave empty to list the newest.
Returns up to limit (default 20) best matches with short descriptions, plus "total". If total is larger than the list, the response has "refine" counts: narrow the query with more words or filters instead of asking for more results.`;

const PULL_DESCRIPTION = `Get a package by id: "type/name", or "type/name@1.2.0" for a specific version (default: latest).
Without path: installs the package and its dependencies into ./.exchange/ in your working directory and returns the folder. You need file access to read it.
With path: installs nothing. path "." returns the package's description and file list; path "SKILL.md" (any file name from that list) returns that file's text. Use it to inspect a package before installing, or when you cannot read files.
verify: true re-runs the package's own check after installing (not allowed together with path).`;

const PUBLISH_DESCRIPTION = `Publish a package so other agents can find and pull it.
from: either a directory path that holds handoff.json plus the payload files, or an object mapping file names to file contents (it must include "handoff.json") when you cannot write files.
handoff.json: {"id":"type/name","version":"1.0.0","description":"what it is and when to use it","tags":["topic"],"deps":[{"id":"type/other"}],"verify":{"cmd":["program","arg"]}}. tags, deps and verify are optional; version is x.y.z.
The package is stored only if its check (verify.cmd, run with the dependencies installed) and the review pass; the result says accepted or rejected and why. Published versions never change: publish a new version to update.
For type "skill", SKILL.md must start with frontmatter: ---\nname: <the name part of the id>\ndescription: <what it does and when to use it>\n---`;

export function createServer(hookOverrides: Partial<Hooks> = {}): McpServer {
  const hooks: Hooks = { ...defaultHooks, ...hookOverrides };
  const server = new McpServer({ name: "step-by-step-handoff-mcp", version: "0.2.0" });
  const storeRoot = resolveStoreRoot();
  const workDir = process.env.HANDOFF_WORKDIR ?? process.cwd();

  server.registerTool(
    "search",
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().optional().describe('Words and filters, e.g. "type:skill tag:lean4 proof"'),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
      },
    },
    (args) => respond(() => searchPackages(storeRoot, args)),
  );

  server.registerTool(
    "pull",
    {
      description: PULL_DESCRIPTION,
      inputSchema: {
        id: z.string().describe('Package id, e.g. "lemma/abelian-comm" or "lemma/abelian-comm@1.0.0"'),
        path: z.string().optional().describe('"." to list files, or a file name to read it. Omit to install.'),
        verify: z.boolean().optional().describe("Re-run the package's check after installing"),
      },
    },
    ({ id, path, verify }) =>
      respond(async () => {
        if (path === undefined) return pullPackage(storeRoot, workDir, { id, verify }, hooks);
        if (verify) throw new Error("verify needs an installed package; omit path to install and verify");
        return peekPackage(storeRoot, { id, path });
      }),
  );

  server.registerTool(
    "publish",
    {
      description: PUBLISH_DESCRIPTION,
      inputSchema: {
        from: z
          .union([z.string(), z.record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())]))])
          .describe("Directory path, or {fileName: content} including handoff.json"),
      },
    },
    ({ from }) => respond(() => publishPackage(storeRoot, from, hooks)),
  );

  return server;
}
