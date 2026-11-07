# Architecture (decisions)

Companion to [PRODUCT.md](PRODUCT.md). Name: `step-by-step-handoff-mcp`.

## Current contracts (v0.2, authoritative)

The sections below are the original design and are kept as history. Where they differ from this
section (external review command, `pending` and `incoming/`, `summary`, separate `version`
argument, `type` argument on search), this section wins.

- **Manifest** `handoff.json`: `id` (`type/name`, each part up to 64 chars), `version` (x.y.z), `description` (up to 1024 chars, same as the Agent Skills spec), `tags` (up to 10), `deps` (`id`, optional `version`, optional `digest` pin), `verify` (`cmd` argv, `cwd`). The store adds `type`, `files` (path, size, sha256) and `provenance`.
- **Store**: `blobs/<sha256>`, `packages/<type>/<name>/<version>.json` (source of truth), `catalog.sqlite` (derived search index, WAL mode, rebuilt from the manifests when empty). No `incoming/`: a review either accepts or rejects.
- **search(query?, limit?)**: filters live inside `query` (`type:`, `tag:`) so there are no extra parameters. Words are case-insensitive substrings matched against id, tags and description (works for Chinese). Ranking: id match 3, tag 2, description 1, then newest. Packages with identical content are folded into one hit (`duplicates`), versions are folded into one hit (`otherVersions`). Output: `total`, `shown`, `results`, and `refine` (counts by type and tag) only when results were cut. Descriptions are cut to 250 characters and the whole list to 8000 characters. Limits are modelled on skill listings: the Agent Skills spec allows 1024 characters per description and about 100 tokens of metadata per skill; Claude Code reportedly shows 250 to 1536 characters per entry within a shared budget of about 1 percent of the context window (8000 characters as a fallback). Sources disagree on the exact numbers, so these are tunable constants in `src/constants.ts`.
- **pull(id, path?, verify?)**: `id` may be `type/name@x.y.z`. Without `path`, installs the dependency closure into `<cwd>/.exchange/packages/...` via a staging directory with hash checks, updates `exchange.lock`, returns the folder, file list and `verified` (`null` when the package declares no check). With `path`, nothing is written: `"."` lists, a file name returns text (20000 chars max, binary files reported as binary). File names are looked up in the manifest, so path traversal is impossible.
- **publish(from)**: `from` is a directory or `{fileName: content}` (written to a temporary directory). Steps: validate manifest and payload, hash files, refuse an existing version, verify in a scratch workspace with dependencies installed, run the review, store blobs and manifest, update the catalog.
- **Hooks** (`src/hooks.ts`): `verify(context)` and `review(context)` are plain functions with defaults; override them with `createServer({ verify, review })`. The default review accepts everything. `examples/llm-review.ts` shows an LLM reviewer.
- **Concurrency**: blobs and manifests are written to a temporary file and renamed; the catalog uses SQLite WAL with a busy timeout. Covered by a test that publishes 12 packages at once.
- **Requires** Node.js 22.13 or newer (`node:sqlite`, still marked experimental by Node).

## Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | One agent, one working directory. Packages are materialized into `<cwd>/.exchange/`, never into global agent config. | Isolation per agent; no cross-agent contamination; easy cleanup. |
| 2 | Shared source of truth is a **store**, outside any workspace. | Many agents with different cwds must see the same packages. |
| 3 | Types are packages too. A `lemma` package declares `requires: skill lean4@<hash>`. | The Lean 4 skill carries the Lean project template, so verification is reproducible. |
| 4 | Verification and review are external commands (stdin/stdout JSON). | Language-neutral; Lean, pytest, an LLM judge all plug in. |
| 5 | Review is optional; default is none (auto-accept). | Keeps v0.1 simple; strict teams enable it. |
| 6 | TypeScript, official MCP SDK, stdio transport, `npx` distribution. | Matches common MCP install idiom. |

## The Lean 4 case

The Lean 4 *skill* is an Agent Skills directory (spec: `SKILL.md` plus optional `scripts/`,
`references/`, `assets/`; keep `SKILL.md` short, reference files one level deep). Its
`assets/` holds a Lake project template (`lakefile`, `lean-toolchain`, pinned
`lake-manifest.json`). Mathlib pinning matters: the toolchain must match the Mathlib
version, and a mismatched template is a known failure mode; Mathlib binaries come from
`lake exe cache get`. So:

1. Agent pulls skill `lean4` (instructions + template).
2. Agent pulls `lemma/12` (statement, proof `.lean`, deps, `verify` command).
3. `pull` copies the template once into `.exchange/work/lean4/`, drops lemma files in,
   and `verify` runs `lake build` there. Pass = trusted locally.

Lean build artifacts and Mathlib cache stay in Lake's own directories; this tool does not
manage them. Verification of heavy toolchains is the consumer's responsibility.

## Directory layout

Workspace (per agent, add to .gitignore):

```
<cwd>/.exchange/
  packages/<type>/<id>/        # materialized package files (read-only by convention)
  work/                        # scratch for verifiers (e.g. lean4 project)
  exchange.lock                # id, version, content hash, source, verified-at
  .tmp/                        # atomic writes: write here, then rename
```

Optional skill adapter: for `skill`-type packages, also place at `<cwd>/.agents/skills/<name>/`
(configurable) so a host's native loader can use it. Not global, still per-workspace.

Local store and cache (user-level, shared by all agents on the machine):

- **Store (persistent, source of truth in local mode):** the platform *data* dir.
  Linux `$XDG_DATA_HOME/step-by-step-handoff-mcp` (default `~/.local/share/step-by-step-handoff-mcp`); macOS
  `~/Library/Application Support/step-by-step-handoff-mcp`; Windows `%LOCALAPPDATA%\step-by-step-handoff-mcp`.
- **Cache (deletable, content-addressed blobs):** the platform *cache* dir
  (`$XDG_CACHE_HOME`, `~/Library/Caches`, `%LOCALAPPDATA%`), symlinked or hardlinked
  into workspaces on the same machine, copied otherwise.
- **State (logs, review queue progress):** platform *state* dir.
- Policy: honor `XDG_*` variables when set, else native paths (env-paths style).
  Override everything with `HANDOFF_STORE`, `HANDOFF_CACHE`. Document the policy; tools
  disagree about XDG on macOS/Windows, so pick one and state it.

Store internals:

```
store/
  blobs/<sha256>             # immutable content
  packages/<type>/<id>/<version>.json   # manifest -> blob hashes, deps, provenance
  incoming/                  # submitted, awaiting review
  index.json                 # search metadata (rebuildable)
```

## Package manifest

```json
{
  "id": "lemma/12",
  "type": "lemma",
  "version": "1.0.0",
  "summary": "One-line claim, shown in search results",
  "requires": [{ "id": "skill/lean4", "hash": "sha256:..." }],
  "deps": [{ "id": "lemma/3", "hash": "sha256:..." }],
  "files": [{ "path": "Lemma12.lean", "hash": "sha256:..." }],
  "verify": { "cmd": ["lake", "build"], "cwd": "work/lean4" },
  "provenance": { "author": "agent-id", "created": "ISO-8601", "parent": null }
}
```

## Tools

- `search({ type?, query?, limit? })` -> `[{ id, type, version, summary, status }]` (no bodies).
- `pull({ id, version?, verify?: boolean })` -> `{ path, files, deps_pulled, verified?, summary }`.
  Resolves the dependency closure, verifies hashes, writes atomically, updates the lockfile.
- `publish({ path })` -> `{ status: "accepted" | "pending" | "rejected", reason? }`.
  Steps: schema validate -> size/extension limits -> run `verify` -> run `review` hook -> store.

## Review hook contract

`review` command receives the manifest and package path as JSON on stdin and prints
`{"approved": boolean, "reason": string}`. Unset = auto-accept. A hook may return
`{"approved": null}` to leave the package in `incoming/` for a human queue.

## Security model

- Packages are untrusted input: path traversal check, size limits, no execution on pull
  unless `verify: true`, and verifiers run with the caller's permissions (no sandbox in v1).
- Hash pinning in the lockfile; provenance recorded; `disputed` status for retractions.
- Skill text is a prompt-injection vector; recommend enabling review for shared stores.
