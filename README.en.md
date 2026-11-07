# Step by Step Handoff MCP

**English** | [简体中文](README.md)

> Let AI agents hand off **verified work** step by step, instead of sharing context.

**Step by Step Handoff MCP** is an MCP server for multi-agent swarms. One agent packs a
reusable result (a proven lemma, a skill, a dataset, a patch) and publishes it. Other agents
search for it, pull it into their own working directory, re-verify it locally, and build on
it, without ever reading the producer's context.

> **Status: v0.1 runs locally and passes its tests; not yet published to npm.** Interfaces may change.

## What is it?

Step by Step Handoff MCP is a Model Context Protocol (MCP) server written in TypeScript. It
exposes three tools, `search`, `pull` and `publish`, and turns agent-to-agent handoff into a
small, explicit interface: the **handoff package**.

A handoff package has four parts:

| Part | Purpose |
|---|---|
| **type** | Schema of the payload, e.g. `skill`, `lemma`, `dataset`, `patch`; user-definable |
| **payload** | The result itself, plus a description of how to use it |
| **contract** | A command that checks it locally, e.g. `lake build` for Lean 4 or a test command |
| **provenance** | Author, version, content hash, dependencies |

An optional **review hook** gates publishing. It is empty by default and can run a linter, a
secret scanner or an LLM judge.

## Why does this exist?

- **The problem.** When many AI agents work in parallel, they either repeat each other's work or flood each other's context windows with text that is mostly irrelevant to them. Sharing raw context does not scale: every extra agent makes every window noisier, more expensive and easier to mislead.
- **The idea.** Each agent keeps a few simple tools and its own working directory. Its large action space comes from composing those tools with results other agents already produced and proved. So agents should share *interfaces and verified results*, never context.
- **The mechanism.** An agent publishes a small package: the result, a short description of what it is and when to use it, and a check any other agent can re-run. A consumer searches by description, looks inside without installing if it wants, pulls it into its own working directory, and re-verifies it locally. It trusts the check, not the producer.
- **The relation to Agent Skills.** A skill is a small package an agent loads on demand. A handoff package is the same kind of carrier, except it is produced by a peer during the run, so it carries a check and passes a review before it is accepted. Skills are one package type among several (lemmas, datasets, patches, notes, anything you define).

## Tools

| Tool | Input | What it does |
|---|---|---|
| `search` | `query` (words plus `type:` and `tag:` filters), `limit` (default 20) | Best matches only, each with an id and a description cut to 250 characters, plus `total`. When there are more matches than shown it returns `refine` counts so the agent narrows the query instead of paging. |
| `pull` | `id` (`type/name` or `type/name@1.2.0`), `path`, `verify` | Without `path`: copies the package and its dependencies into `./.exchange/`. With `path`: installs nothing; `"."` returns the description and file list, a file name returns that file's text. Works for agents with no file tools. |
| `publish` | `from`: a directory path, or `{fileName: content}` | Runs the package's own check in a scratch workspace with dependencies installed, then the review function; stores it only if both pass. Published versions never change. |

## Quickstart

Requires Node.js 22.13 or newer. Until it is on npm, run it from source:

```bash
npm install && npm run build
claude mcp add step-by-step-handoff -- node /absolute/path/dist/index.js
```

After release this becomes `npx -y step-by-step-handoff-mcp` (on Windows, `npx` servers may
need a `cmd /c` wrapper). Add `.exchange/` to your `.gitignore`.

**Package format**: a directory containing `handoff.json` and any payload files.

```json
{
  "id": "lemma/12",
  "version": "1.0.0",
  "description": "What it is and when to use it (max 1024 characters, as in the Agent Skills spec)",
  "tags": ["group"],
  "deps": [{ "id": "lemma/3" }],
  "verify": { "cmd": ["lake", "build"], "cwd": "." }
}
```

Packages of type `skill` also need a `SKILL.md` whose frontmatter `name` equals the package name.

**Custom check and review**: both are functions in code, not environment variables. The review is
empty by default: every package that passes its check is accepted. To change that (lint, secret
scan, an agent as reviewer), pass your own function:

```ts
import { createServer } from "step-by-step-handoff-mcp";
import { createLlmReview } from "./examples/llm-review.js"; // example: an LLM reviews packages

// a complete entry point: examples/serve-with-llm-review.ts
createServer({ review: createLlmReview({ apiKey: process.env.DEEPSEEK_API_KEY! }) });
```

`verify` works the same way: by default it runs the command in `handoff.json`, but it can be any
function. A review only approves or rejects; there is no human queue. The only environment
variables are `HANDOFF_STORE` (store location), `HANDOFF_AGENT_ID` (author id) and
`HANDOFF_WORKDIR` (pull target).

## Example

**Lemma handoff (Lean 4)**
1. Agent A proves lemma 12 and calls `publish`. The package holds the `.lean` file, its
   dependencies and `verify: lake build`.
2. Agent B calls `search({query: "type:lemma subgroup"})`, looks first with
   `pull({id: "lemma/12", path: "."})`, then installs and re-verifies with
   `pull({id: "lemma/12", verify: true})`.
3. B sees `verified: true` and uses the lemma. It never read A's reasoning.

Math proofs are only one example. The same flow works for skills, datasets, patches and
research findings.

## Tested with agents

A DeepSeek-driven agent ran 24 scenarios, 3 runs each (72 runs), with and without file tools:
search, inspect, install, verify, publish, duplicate versions, failing checks, dependencies,
truncated descriptions and prompt injection inside a package. See [docs/EVAL.md](docs/EVAL.md).

## Where files live

| What | Where |
|---|---|
| Pulled packages (per agent) | `<cwd>/.exchange/` |
| Lockfile | `<cwd>/.exchange/exchange.lock` |
| Shared local store | Platform data dir, e.g. `~/.local/share/step-by-step-handoff-mcp` (override with `HANDOFF_STORE`) |
| Search index | `catalog.sqlite` in the store; safe to delete, rebuilt from the manifests |

Nothing is written to global agent configuration.

## FAQ

**How is this different from a skill registry?**
A skill registry distributes skills written in advance. This project lets agents reuse results
produced during a run, so it adds publishing, contract verification and review. Skills are one
supported package type.

**Does it depend on a framework's skill loader?**
No. The core is copying files into the agent's current working directory, which any agent
that can read files can use. An optional adapter can copy `skill` packages to `.agents/skills/`.

**Does it run untrusted code?**
Publishing runs the package's own check; pulling runs it only with `verify: true`. There is no
sandbox yet, so commands run with the permissions of the user running the server. Use a strict
review function on shared stores. Content returned by `pull` with `path` carries a notice that
it was written by another agent and is data, not instructions.

**Is it a message bus or an orchestrator?**
No. It does not schedule agents or relay messages. It packages, verifies, stores and serves
results.

## Security

Packages are untrusted input. Implemented: path traversal checks, symbolic links refused, file
count and size limits, hash checks on pull, dependency digest pins, immutable versions. Skills are
instructions to agents and a prompt-injection vector, so use a review function on shared stores.

## Docs

- [docs/PRODUCT.md](docs/PRODUCT.md): positioning, concepts, delivery layers
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): current contracts, layout, security model
- [docs/EVAL.md](docs/EVAL.md): how agents were tested and what changed because of it

## License

[MIT](LICENSE)

---

Keywords: MCP server, multi-agent, agent swarm, agent handoff, verified artifacts,
Model Context Protocol, Agent Skills, context sharing
