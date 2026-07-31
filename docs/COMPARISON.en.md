# DSCode vs Claude Code vs Codex

> For developers currently using Claude Code or Codex who are wondering whether
> to switch. We address the most common objection first, then show the evidence.

## 0. The sharpest question first: Codex can also use DeepSeek — why DSCode?

True. DeepSeek even publishes an official
[Codex integration guide](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/).
But "can run it" and "designed for it" are different things:

**Codex + DeepSeek is a compatibility layer. DSCode + DeepSeek is a native
implementation.**

- Codex's sandbox, approval flows, several tools, and usage accounting are tied
  to OpenAI models. Pointing it at a third-party model means downgrading or
  bypassing features; the official guide itself is a compromise path of "set a
  baseURL and disable incompatible features."
- DSCode's `src/deepseek.ts` was written for the DeepSeek Responses API from
  the first line: it strips OpenAI-only fields (`prompt_cache_key`,
  `prompt_cache_retention`, `include`) from requests, rewrites `apply_patch` as
  a native Responses freeform custom tool, removes sampling parameters that are
  ignored while thinking is enabled, and injects `web_search`. That is an
  adapter layer, not a hack.
- DSCode's pricing and caching model (`cacheRead` pricing in `src/model.ts`,
  per-turn cache-hit rate in `src/ui.ts`) is built around DeepSeek's **disk
  prefix cache** — cached input costs roughly 1/10 of normal input and persists
  across sessions. When Codex runs DeepSeek, neither its prompt structure nor
  its usage display is optimized for that economic model, and you never see
  cache-hit numbers.

In one sentence: **Codex with DeepSeek is "making someone else's runtime run
our model." DSCode is "runtime and model designed together."** The former saves
configuration time; the latter saves real money on long sessions and
parallelism.

## 1. Comparison table

| Dimension | DSCode | Claude Code | OpenAI Codex |
| --- | --- | --- | --- |
| Default model | DeepSeek V4 Flash (Responses API) | Claude Sonnet/Opus | gpt-5-codex / codex-mini |
| Third-party (DeepSeek) support | **Native**: payload cleanup, native `apply_patch` tool, reasoning-effort passthrough, `web_search` injection | Not supported (closed source) | Compatibility layer: baseURL config, degraded features |
| Prefix-cache exploitation | **Designed around disk cache**: stable prompt prefix, cache-aware compaction, per-turn hit rate | None exposed (model-side only) | None (invisible with third-party models) |
| Per-turn cost visibility | **Every turn**: `tokens in (x% cached) · out · reasoning · $` | End-of-session only (needs billing) | Usage display tied to OpenAI billing |
| Parallel agents | **Four roles**: explorer / implementer / reviewer / tester, up to 4 in parallel, **implementers in isolated Git worktrees** | Task subagents run in the main workspace at Opus prices | Newer subagent support, same main workspace |
| Cost model of parallelism | Low price + high concurrency → **parallelism is the default move** | Parallelism is a budget decision | Parallelism is a budget decision |
| Default network policy | **Blocked by default** (Seatbelt `(deny network*)`) | Online by default, deny rules opt-in | Online by default, opt-in config |
| Sandbox | Seatbelt / Docker, workspace-write by default | Permission system + sandbox | macOS Seatbelt / Linux Docker / Windows |
| Open source / auditable | MIT, forkable runtime, private extensions | Closed (minified JS) | Apache 2.0, but full features tied to OpenAI |
| Runtime replaceability | Clean DeepSeek adapter layer; swapping models or self-hosting is a designed path | Not replaceable | Swapping models is a workaround, not a design path |
| MCP / Skills / hooks / AGENTS.md | ✅ | ✅ | ✅ |
| Sessions | Tree-shaped JSONL, fork / resume / compact, transcript diff | resume / fork / compact | resume / continue / checkpoints |
| Chinese-repo optimization | **Dedicated**: Chinese symbols, build logs, error explanation | None | None |
| 1M context | ✅ | ✅ (Sonnet 4.5) | 400k |
| Multimodal | ❌ (V4 is text-only) | ✅ | ✅ |
| VS Code / IDE | Local thin integration + RPC + language diagnostics | Official extension (more mature) | Official extension + cloud tasks (more mature) |
| Ecosystem maturity | Early, small community | Most mature | Mature |

## 2. What we actually have that they don't (the point)

### 2.1 Disk prefix cache = pricing model (structural advantage)

DeepSeek's KV cache is a platform-level feature: **written to disk, persists
across sessions, cached input at roughly 1/10 the price**. DSCode is built
around it, and you can verify it in the code:

- `src/model.ts`: cacheRead pricing enters the cost calculation;
- `src/ui.ts`: per-turn status bar shows `tokens in (x% cached) · $`;
- `src/compaction.ts` + `src/prompt.ts`: system prompt / tool definitions /
  project rules keep a stable prefix; compaction timing is cache-aware.

The result: **the marginal cost of long sessions and parallel agents
approaches zero.** Claude Code's and Codex's caching is implicit model-side
behavior — not exposed, not designed around. This advantage is bound to
DeepSeek's pricing structure; copying the UI won't copy it. Even a Codex user
pointing at DeepSeek doesn't get this cache-aware design.

### 2.2 Four-role worktree swarm (a usage difference, not a feature difference)

`src/subagents.ts`: explorer (read-only evidence) / implementer (isolated
worktree writes) / reviewer (diff review) / tester (failure diagnosis), up to 4
in parallel. Implementer candidate changes are write-isolated from other
agents; the main agent owns integration.

Claude Code and Codex both have a "subagents" button, but they run in the main
workspace at flagship-model prices — **parallelism is a budget decision**.
DSCode's low unit price and high concurrency make **parallelism the default
move**: main agent implements + reviewer checks the diff + tester diagnoses +
two cheap candidate solutions compete. At V4 Flash prices that's free. This is
a usage difference created by cost structure.

### 2.3 Network blocked by default (a defaults difference)

`src/sandbox.ts`: the default Seatbelt profile emits `(deny network*)`.
Claude Code / Codex are online by default; safety requires configuration.
DSCode is safe out of the box — a real difference for finance, government, and
any team whose code must not leave the network.

### 2.4 Per-turn cost transparency

Claude Code reports a session total only at the end; Codex's usage display is
tied to OpenAI billing (and breaks with third-party models). DSCode shows
tokens / cache-hit rate / reasoning / dollars every turn (`src/ui.ts`), so
cost-sensitive teams can monitor in real time.

### 2.5 Replaceable runtime

Claude Code is closed; Codex is open but its full feature set is tied to
OpenAI. DSCode: MIT-licensed, `src/deepseek.ts` is a clean adapter layer, and
self-hosting or private extension is a designed path — not a workaround.

### 2.6 Chinese-repo optimization

Dedicated handling for Chinese symbols, build logs, and error explanation —
neither competitor targets this market — and DeepSeek's native Chinese strength
comes with the model.

## 3. Honest boundaries (what we don't have yet)

- **Multimodal**: V4 is text-only; Claude Code and Codex handle images;
- **Ecosystem maturity**: their IDE extensions, cloud tasks, and community
  docs are more mature;
- **Domain-level network allowlist**: on the roadmap, not implemented;
- **Experience claims**: until real-repo evals consistently win, we do not
  claim to be "better" overall — see the shadow-eval methodology in
  `PRODUCT_STRATEGY.md` (same task on all three tools, measuring success rate ×
  time × cost × safety).

## 4. The one-liner

> You don't need to change your workflow — you change your cost structure:
> cached input at a 90% discount, persistent across sessions; four-way parallel
> agents as the default move instead of a luxury; network off by default; every
> dollar accounted for every turn. These aren't features, they're an economic
> structure — we're bound to a model that makes long sessions and parallelism
> approach zero marginal cost, while Codex + DeepSeek is "making it run," not
> "designing for it."

## 5. Migration path

```bash
pnpm install && pnpm check
export DEEPSEEK_API_KEY="sk-..."
dscode -C /path/to/project
```

- Existing `CLAUDE.md` / `AGENTS.md` files are honored as-is — no rewriting;
- Interaction habits carry over: TUI, plan/ask/auto/full permissions,
  per-file diff approval, `/undo`;
- `--continue` resumes your last session; `--fork <session-id>` branches an
  experiment.
