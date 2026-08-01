# DSCode compared with Claude Code and Codex

[中文](COMPARISON.md)

## Positioning

Claude Code and Codex are broad, mature coding-agent products. DSCode is a smaller, opinionated runtime
built around DeepSeek V4 Flash by default, with optional OpenAI API and Codex subscription models.

The case for DSCode is not that competitors lack agents, worktrees, sandboxing, or extensions—they have
all of those. The difference is the design center:

> DSCode keeps a DeepSeek-optimized local runtime while allowing vision-capable OpenAI/Codex models when
> a task needs capabilities that DeepSeek V4 Flash does not provide.

## Current comparison

| Dimension | DSCode | Claude Code | Codex |
| --- | --- | --- | --- |
| Design center | Local repositories with DeepSeek defaults and provider choice | General-purpose Claude coding workflows | OpenAI coding workflows across CLI, IDE, app, and cloud |
| DeepSeek integration | Dedicated Responses adapter, stateless replay, effort mapping, payload cleanup, native free-form patch tool | DeepSeek exposes an Anthropic-compatible endpoint and documents Claude Code integration | General-purpose runtime; DSCode does not claim feature parity when using third-party providers |
| Model access and images | DeepSeek API key, OpenAI API key, or eligible ChatGPT plan; image input on models that advertise vision support | Claude account/API access with multimodal support | ChatGPT plan or OpenAI API access with multimodal support |
| Context and cost | 1M context; `/status` exposes DeepSeek cache hits, tokens, reasoning, and estimated cost | Product-specific context and usage reporting | Product-specific context and usage reporting |
| Parallel work | Four built-in roles, up to four concurrent tasks; implementers use isolated Git worktrees | Subagents, background agents, agent teams, and worktree isolation | Subagents plus worktrees in supported surfaces |
| Safety | Workspace sandbox and no command network by default; scoped per-command network/host approvals; durable patch checkpoints | Configurable permission and sandbox system with filesystem and network controls | OS sandbox, approvals, and no network by default for local commands |
| Runtime ownership | MIT-licensed runtime with a focused DeepSeek adapter | Full product runtime is proprietary; Anthropic publishes its sandbox runtime separately | Open-source CLI plus broader OpenAI product surfaces |
| Extensibility | `AGENTS.md`, `CLAUDE.md`, Skills, hooks, MCP, JSONL, RPC | Project instructions, skills, hooks, MCP, plugins | `AGENTS.md`, skills, hooks, MCP, plugins, SDK, app server |
| Product maturity | Early project; thin local VS Code integration | Mature CLI, IDE, desktop, multimodal, and team workflows | Mature CLI, IDE, desktop, cloud, multimodal, and automation workflows |

## Where DSCode is differentiated

### 1. A DeepSeek-specific Responses runtime

`src/deepseek.ts` is not a generic `base_url` switch. It removes unsupported OpenAI fields, maps
reasoning behavior, rewrites `apply_patch` as a native free-form custom tool, and optionally injects
server-side Web Search. Local tree-shaped JSONL sessions own the replay of stateless messages, reasoning
items, and tool results.

### 2. Cache and cost visibility

DeepSeek's disk prefix cache makes repeated prefixes cheaper and reports cache-hit tokens. DSCode models
the cache-read price directly and exposes current cache, token, reasoning, and cost information through
`/status`. We avoid hard-coding price claims here because provider pricing changes; use the official
[DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing/).

### 3. Opinionated parallelism

DSCode ships four roles instead of asking every project to invent them:

- `explorer`: read-only repository investigation
- `implementer`: candidate changes in an isolated worktree
- `reviewer`: independent read-only review
- `tester`: focused tests and failure diagnosis

Up to four tasks run concurrently, while the primary agent owns integration and final validation. Claude
Code and Codex also support parallel agents and worktrees; DSCode's distinction is the built-in role model
and its use of DeepSeek V4 Flash's cost and concurrency profile.

### 4. Local, inspectable control

DSCode keeps sessions locally, uses an OS-enforced command sandbox, blocks command network by default,
strips model-provider API keys from child-process environments, and creates a durable checkpoint after every
successful patch. Conflict-safe `/undo` refuses to overwrite files changed after the checkpoint.

### 5. A small, forkable runtime

The project is MIT-licensed and keeps provider-specific behavior in a focused adapter. Teams can inspect
and modify prompts, permissions, tools, sessions, MCP, hooks, and sandbox behavior without depending on a
hosted control plane.

## What we do not claim

- DSCode is not universally better than Claude Code or Codex.
- Parallel agents, worktrees, sandboxing, skills, hooks, and MCP are not unique to DSCode.
- Low API prices do not make parallel execution free.
- A 1M context window does not remove the need for search, focused reads, and compaction.
- DSCode supports image input on compatible models, but does not match competitor cloud, IDE,
  multimodal-workflow, or ecosystem maturity.

The right comparison is a shadow evaluation on the same repository tasks, measuring success rate, wall
time, cost, safety, unrelated diffs, and human intervention—not a feature checklist.

## Official references

- [DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424/)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Claude Code parallel agents](https://code.claude.com/docs/en/agents)
- [Claude Code subagents and worktrees](https://code.claude.com/docs/en/sub-agents)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex image inputs](https://learn.chatgpt.com/docs/image-inputs)
