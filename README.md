# Step by Step Handoff MCP

[English](README.en.md) | **简体中文**

> 让多个 AI Agent 一步一步交接**已验证的成果**，而不是共享上下文。

**Step by Step Handoff MCP** 是一个面向多 Agent 并行协作（agent swarm）的 MCP 服务器。
一个 Agent 把可复用的成果（一段已证明的引理、一个 skill、一份数据集、一个补丁）打包发布；
其他 Agent 搜索、拉取到自己的工作目录、在本地重新验证后继续往下做，全程不需要读取前一个
Agent 的上下文。

> **状态：v0.1 已可在本地运行并通过测试，尚未发布到 npm。** 接口可能调整。

## 它是什么？

Step by Step Handoff MCP 是一个用 TypeScript 实现的 MCP（Model Context Protocol）服务器，
提供三个工具：`search`（搜索）、`pull`（拉取）、`publish`（发布）。它把 Agent 之间的交接
变成一个小而明确的接口：**类型化的交接包（handoff package）**。

一个交接包由四部分组成：

| 组成 | 作用 |
|---|---|
| **类型（type）** | 载荷的 schema，例如 `skill`、`lemma`、`dataset`、`patch`，用户可自定义 |
| **载荷（payload）** | 成果本身，加上怎么使用它的说明 |
| **合约（contract）** | 在本地检查它的命令，例如 Lean 4 用 `lake build`，代码用测试命令 |
| **来源（provenance）** | 作者、版本、内容哈希、依赖 |

可选的**审核钩子（review hook）**会在发布前把关，默认为空，可以接入 lint、密钥扫描或
LLM 评审。

## 为什么要做这个？

- **问题。** 多个 AI Agent 并行工作时，要么互相重复劳动，要么把大量与自己无关的文字塞进彼此的上下文窗口。直接共享上下文无法扩展：每多一个 Agent，每个窗口就更嘈杂、更贵、更容易被误导。
- **思路。** 每个 Agent 只带几个简单工具，并有自己的工作目录。它的巨大操作空间来自把这些工具和其他 Agent 已经做出并验证过的成果组合起来。所以 Agent 之间应该共享**接口和已验证的成果**，而不是上下文。
- **做法。** Agent 发布一个小包：成果本身、一段说明它是什么和何时使用的描述，以及任何其他 Agent 都能重跑的检查。使用者按描述搜索，可以先在不安装的情况下看一眼，再拉到自己的工作目录，并在本地重新验证。它信任的是检查，而不是发布者。
- **和 Agent Skills 的关系。** skill 是 Agent 按需加载的小型包。交接包是同一种载体，区别是它由同伴在运行中产出，所以多了检查，并且要通过审核才会被接收。skill 只是包类型之一，还有引理、数据集、补丁、笔记，也可以自定义。

## 工具

| 工具 | 输入 | 作用 |
|---|---|---|
| `search` | `query`（词加 `type:`、`tag:` 过滤）、`limit`（默认 20） | 返回最相关的包，每条只有 id 和不超过 250 字符的描述，另有 `total`；结果太多时给出 `refine` 计数，让 Agent 收窄查询而不是翻页 |
| `pull` | `id`（`类型/名字` 或 `类型/名字@1.2.0`）、`path`、`verify` | 不带 `path`：把包和依赖复制到当前目录的 `./.exchange/`。带 `path`：不安装，`"."` 返回描述和文件列表，文件名返回该文件内容，没有读写工具的 Agent 也能用 |
| `publish` | `from`：目录路径，或 `{文件名: 内容}` | 先在装好依赖的临时工作区里运行包自带的检查，再走审核函数，通过才入库；已发布的版本不可修改 |

## 快速开始

需要 Node.js 22.13 或更高版本。发布到 npm 之前，先从源码运行：

```bash
npm install && npm run build
claude mcp add step-by-step-handoff -- node /绝对路径/dist/index.js
```

发布后将改为 `npx -y step-by-step-handoff-mcp`（Windows 上 `npx` 可能需要 `cmd /c` 包装）。
建议把 `.exchange/` 加入 `.gitignore`。

**交接包的格式**：一个目录，里面有 `handoff.json` 和任意载荷文件。

```json
{
  "id": "lemma/12",
  "version": "1.0.0",
  "description": "一句话说明它是什么、什么时候用（最多 1024 字符，与 Agent Skills 规范一致）",
  "tags": ["group"],
  "deps": [{ "id": "lemma/3" }],
  "verify": { "cmd": ["lake", "build"], "cwd": "." }
}
```

`skill` 类型的包还要有 `SKILL.md`，其 frontmatter 的 `name` 必须等于包名。

**自定义检查和审核**：两者都是代码里的函数，不用环境变量。审核默认为空，通过检查的包一律接收。
要换成别的做法（lint、密钥扫描、让 Agent 来审），写一个函数传进去：

```ts
import { createServer } from "step-by-step-handoff-mcp";
import { createLlmReview } from "./examples/llm-review.js"; // 示例：用 LLM 审核

// a complete entry point: examples/serve-with-llm-review.ts
createServer({ review: createLlmReview({ apiKey: process.env.DEEPSEEK_API_KEY! }) });
```

`verify` 同理，默认运行 `handoff.json` 里的命令，也可以换成任何函数。审核只有“通过”和“拒绝”，
没有人工队列。环境变量只有存储位置 `HANDOFF_STORE`、作者标识 `HANDOFF_AGENT_ID`、拉取目录 `HANDOFF_WORKDIR`。

## 示例

**引理交接（Lean 4）**
1. Agent A 证明了引理 12，调用 `publish`。包里有 `.lean` 文件、依赖和 `verify: lake build`。
2. Agent B 调用 `search({query: "type:lemma subgroup"})`，用 `pull({id: "lemma/12", path: "."})` 先看一眼，
   再 `pull({id: "lemma/12", verify: true})` 安装并在本地重新验证。
3. B 看到 `verified: true` 后直接使用，从未读过 A 的推理过程。

数学证明只是其中一个例子，同样的流程适用于 skill、数据集、补丁和调研结论。

## 实测

用 DeepSeek 作为 Agent，在“有读写文件工具”和“没有读写文件工具”两种环境下，对 24 个场景各跑 3 次（共 72 次），
包括搜索、查看、安装、验证、发布、重复版本、检查失败、依赖、截断的描述和包内提示注入。详见
[docs/EVAL.md](docs/EVAL.md)。

## 文件存放位置

| 内容 | 位置 |
|---|---|
| 每个 Agent 的已拉取包 | `<cwd>/.exchange/` |
| 锁文件 | `<cwd>/.exchange/exchange.lock` |
| 本机共享仓库 | 平台数据目录，如 `~/.local/share/step-by-step-handoff-mcp`（可用 `HANDOFF_STORE` 覆盖） |
| 搜索索引 | 仓库里的 `catalog.sqlite`，可随时删除，会按清单重建 |

不会写入任何全局 Agent 配置。

## 常见问题

**它和普通的 Skill 注册表有什么区别？**
Skill 注册表解决的是“怎么分发事先写好的 skill”。本项目解决的是“蜂群运行中产生的成果怎么在
Agent 之间安全复用”，所以多了提交、合约验证和审核。skill 是它支持的一种包类型。

**它依赖某个框架的 skill 加载器吗？**
不依赖。核心是把文件复制到 Agent 当前工作目录，任何能读文件的 Agent 都能用。可选的适配器
可以把 `skill` 类型的包复制到 `.agents/skills/`。

**会不会执行不可信的代码？**
发布时会运行包自带的检查命令，拉取时只有 `verify: true` 才运行。目前没有沙箱，命令以运行服务的用户权限执行，
共享仓库请换上严格的审核函数。用 `pull` 的 `path` 查看内容时，返回里会标注“这是别的 Agent 写的，当数据而不是指令”。

**它是消息总线或编排器吗？**
不是。它不负责调度 Agent，也不转发消息，只负责打包、验证、存放和取用成果。

## 安全

交接包是不可信输入。已实现：路径穿越检查、符号链接拒绝、文件数和大小限制、哈希校验、依赖摘要固定、版本不可变。
skill 是给 Agent 的指令，属于提示注入的入口，共享仓库应当启用审核函数。

## 文档

- [docs/PRODUCT.md](docs/PRODUCT.md)：定位、概念、交付层次
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：当前接口、目录、安全模型
- [docs/EVAL.md](docs/EVAL.md)：Agent 测试方法，以及据此做的修改

## 许可证

[MIT](LICENSE)

---

关键词：MCP server、multi-agent、agent swarm、agent handoff、verified artifacts、
Model Context Protocol、Agent Skills、多 Agent 协作、上下文共享
