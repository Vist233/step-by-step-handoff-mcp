# Product definition (v2 framing)

This replaces an earlier "skill registry" framing. Skills are one artifact type,
not the product.

## Positioning (decided with the user; supersedes any "math first" reading)

Math proofs are only one example case, not the wedge. The wedge is the general problem:

- A swarm (say 100 agents) runs in parallel. Each agent has a minimal toolset; the large
  action space comes from composing those tools, not from adding more tools.
- Agents do not talk to each other, because sharing context bloats every window with
  mostly useless text. But without sharing, each agent re-learns what others already found.
- Step by Step Handoff MCP is the missing channel: agents share *work products packaged for reuse*
  (the result plus a description of how to use it plus a way to check it), never raw context.

A skill is the same thing in an older form: a carrier that is easy to distribute and
contains instructions. A handoff package is a skill that was *earned during the run*:
produced by a peer at runtime, with evidence attached, so it carries a contract and a
review step that hand-authored, pre-trusted skills do not need. Skill, lemma, dataset and
patch are all "explanation + evidence" packages with different schemas. The Lean case is
just the cleanest example, because its contract (a proof checker) is binary.

Pitch order for docs and launch: (1) the swarm problem, (2) share results not context,
(3) packages = distributable carrier, (4) verified and optionally reviewed, (5) examples
(a Lean lemma, a coding skill, a dataset). Never lead with a single domain.

Name: Step by Step Handoff MCP (decided by the user). Each agent's verified result is a
step the next agent builds on.

## The problem

A swarm of agents works on one large goal (example: prove a theorem that needs ~100 lemmas).
Two bad extremes:

1. Every agent re-derives everything alone: wasted work.
2. Agents share raw context: noise, token cost, contamination by wrong or irrelevant text.

Each agent should carry a few simple tools. The big action space comes from composing
those tools with *reusable units of work* produced by other agents. What is missing is a
cheap, trustworthy way to hand those units across agents.

## The idea

**Share interfaces, not context.** Agents exchange small, typed, verifiable packages.

A package = `type` + `payload` + `contract` + `provenance`.

- **type**: a schema. `skill`, `lemma`, `dataset`, `patch`, `finding`, ... Users define types.
- **payload**: the content, conforming to the schema (e.g. a lemma: statement, proof, deps).
- **contract**: how a consumer checks it locally without trusting the producer
  (e.g. run the proof checker, run the skill's eval, re-run the test).
- **provenance**: who made it, from what, which version, content hash.

Trust comes from verification and review, not from the producer's say-so. For lemmas the
verifier (a proof checker) makes trust nearly free; for skills it is lint, eval, or human
review. The product's job is to make that pipeline uniform.

## Lifecycle

```
produce -> pack -> validate(schema) -> verify(contract) -> review(hook) -> publish
search -> pull into workspace -> verify locally -> use / compose -> (publish derived work)
```

## Three agent-facing verbs (the whole MCP surface)

| Tool | Purpose |
|---|---|
| `search(type?, query?, deps?)` | Return summaries only (id, type, one-line claim, status). No bodies. |
| `pull(id, version?)` | Materialize the package and its dependencies into the current working directory; write a lockfile; optionally run the verifier. |
| `publish(path)` | Validate against the type schema, run the verifier, run the review hook, then store. Returns accepted / rejected + reason. |

Minimal surface on purpose: this is itself an instance of "few tools, large space."

## Architecture

```
Agent A ─┐                          ┌─ Type registry (schema + verifier cmd + review hook)
Agent B ─┼─ MCP server (3 tools) ───┼─ Store backend (dir | git | HTTP/S3), content-addressed
Agent C ─┘          │               └─ Index (metadata, dependency graph, status)
                    └─ Workspace materializer (cwd/.exchange/<type>/<id>/, lockfile)
```

Pluggable seams (each a small interface, default is trivial):

1. **Store**: list/get/put. Default: local directory (works for a swarm on one machine).
2. **Type definition**: JSON Schema + `verify` command + optional `review` hook.
3. **Verifier**: external command, stdin/stdout JSON, so it is language-neutral
   (Lean, pytest, anything). Runs in the consumer's workspace.
4. **Review hook**: a function, default none (auto-accept). Can be lint, LLM judge, human queue.

Dependencies: packages declare deps on other package ids+hashes (lemma 12 uses lemmas 3, 7).
`pull` resolves the closure. Hash pinning gives reproducibility.

Statuses: `pending`, `accepted`, `rejected`, `superseded`, and for claims `disputed`
(a later agent found a counterexample).

## Non-goals (v1)

- Not a message bus or chat channel between agents.
- Not an orchestrator or scheduler; it does not decide who works on what.
- Not a sandbox; verifiers run with the permissions of the caller (document this).
- No auth/multi-tenant hosting in v1.

## Closest analogies (from general knowledge, not researched here)

Blackboard architecture, package managers with lockfiles, content-addressed stores,
proof libraries with checkable artifacts. Positioning line:
"A package manager and blackboard for agent swarms: typed, verified, minimal-context handoff."

## Naming principle

Decided on 2026-11-07: **Step by Step Handoff MCP** (package `step-by-step-handoff-mcp`).
Earlier candidates (keystone, cairn, baton, ...) were dropped: `keystone` is heavily used on
npm, PyPI and GitHub, and a bare word carries no meaning. The chosen name says what it does
(agents hand work off step by step) and what it is (an MCP server), which also helps GEO.
npm and PyPI were free on 2026-11-07; GitHub was not checked.

## Implementation: TypeScript

Official MCP TypeScript SDK; distribute via `npx`. Verifiers and review hooks are external
commands so other-language ecosystems plug in without ports. Other-language servers can
follow because the surface is three tools plus a file layout.

## v0.1 scope

1. Local-directory store, content hashing, lockfile.
2. Types: `skill` (SKILL.md frontmatter schema) and one generic `note`.
3. Tools: search / pull / publish; verifier and review via external command.
4. Demo: two agents, the second pulls a lemma-like package and re-verifies it.
5. Then: dependency closure, `disputed` status, Git/HTTP store.

## Delivery: how packages reach an agent (layered, most universal first)

1. **File protocol (core).** `pull` materializes to `<workspace>/.exchange/<type>/<id>/`
   with a manifest and lockfile. Any agent that can read files can use it. Add the directory
   to .gitignore. Write atomically (temp dir then rename) so concurrent agents never see
   half-written packages.
2. **MCP tools.** search / pull / publish. Works in any MCP client. The `pull` result
   returns a short summary plus the path, so the agent can read the files directly even if
   its framework never "discovers" them.
3. **Native skill adapter (optional, `skill` type only).** Also place skill packages in the
   cross-tool `.agents/skills/` path (reported by secondary sources as read by Claude Code,
   Codex, Copilot, Gemini CLI, Cursor; verify per vendor) so the host's own loader gives
   progressive disclosure. Mid-session discovery of brand-new skill folders has been
   unreliable in some hosts; rely on layer 2's path fallback.
4. **MCP resources (`skill://`, SEP-2640).** Later, for hosts that support it.

Non-skill types (lemma, dataset, finding) are data, not instructions, so no host skill
loader applies to them. They are consumed through layers 1-2.

## Where the files live: copy, link, or mount

- The **store** is the source of truth, not any one workspace.
- Same machine: keep a content-addressed cache (e.g. `~/.cache/<name>/<hash>`) and
  symlink/hardlink into each workspace. Cheap, deduplicated, no daemon.
- Separate containers or machines: each agent `pull`s a copy (hash-verified). Works
  anywhere; costs a download.
- True mounts (shared volume, FUSE) are an infrastructure option, not a requirement.
  Do not make the design depend on them.
