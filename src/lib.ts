/**
 * The library entry (import from "step-by-step-handoff-mcp/core").
 *
 * The MCP server (the package's main entry) reads its store, working directory and author from environment
 * variables, which is right for one agent per process. A program that runs many agents in one process needs
 * those three things per agent, as plain arguments. `createHandoff` takes them explicitly and never reads the
 * environment: one handle per agent, all handles may share one store.
 */
import { isAbsolute } from "node:path";
import { defaultHooks, type Hooks } from "./hooks.js";
import { peekPackage, pullPackage, type PeekResult, type PullRequest, type PullResult } from "./tools/pull.js";
import { publishPackage, type PublishResult, type PublishSource } from "./tools/publish.js";
import { searchPackages, type SearchRequest, type SearchResponse } from "./tools/search.js";

export type { Hooks, HookContext, ReviewFn, VerifyFn, ReviewDecision } from "./hooks.js";
export { defaultHooks } from "./hooks.js";
export type { VerifyOutcome } from "./verify.js";
export type { PeekResult, PullRequest, PullResult } from "./tools/pull.js";
export type { PublishResult, PublishSource } from "./tools/publish.js";
export type { SearchRequest, SearchResponse } from "./tools/search.js";
export { resolveStoreRoot } from "./store.js";

export interface HandoffOptions {
  /** Where the shared store lives (absolute path). Many handles, and many processes, may use the same store. */
  storeRoot: string;
  /** Where this agent's pulled packages are installed, under `.exchange/` (absolute path). */
  workDir: string;
  /** Recorded as the author of what this handle publishes. Default "unknown". */
  agentId?: string;
  /** Replace the check or the review; the defaults run the package's own check and accept what passes. */
  hooks?: Partial<Hooks>;
}

export interface Handoff {
  readonly storeRoot: string;
  readonly workDir: string;
  readonly agentId: string;
  search(request: SearchRequest): Promise<SearchResponse>;
  /** Reads from the store without installing: path "." lists the package, a file name returns that file. */
  peek(request: { id: string; path: string }): Promise<PeekResult>;
  /** Installs the package and its dependencies into `<workDir>/.exchange/`; `verify` re-runs its check there. */
  pull(request: PullRequest): Promise<PullResult>;
  publish(source: PublishSource): Promise<PublishResult>;
}

function requireAbsolute(name: string, value: string): void {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
}

export function createHandoff(options: HandoffOptions): Handoff {
  requireAbsolute("storeRoot", options.storeRoot);
  requireAbsolute("workDir", options.workDir);
  const { storeRoot, workDir } = options;
  const agentId = options.agentId ?? "unknown";
  const hooks: Hooks = { ...defaultHooks, ...options.hooks };
  return {
    storeRoot,
    workDir,
    agentId,
    search: (request) => searchPackages(storeRoot, request),
    peek: (request) => peekPackage(storeRoot, request),
    pull: (request) => pullPackage(storeRoot, workDir, request, hooks),
    publish: (source) => publishPackage(storeRoot, source, hooks, { author: agentId }),
  };
}
