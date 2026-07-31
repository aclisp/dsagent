<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

<p align="center">
  A local-first coding agent designed around DeepSeek V4 Flash.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.en.md">Comparison</a>
</p>

DSCode is an opinionated coding-agent runtime for developers who want DeepSeek V4 Flash without giving
up a capable terminal workflow. It combines a DeepSeek-native Responses adapter with local sessions,
safe patching, parallel agents, OS sandboxing, and transparent cache and cost reporting.

It is not trying to out-feature every general-purpose agent. It is optimized for one thing: making
DeepSeek V4 Flash effective, inspectable, and economical on real repositories.

## Why DSCode

- **DeepSeek-native runtime.** DSCode handles stateless Responses replay, reasoning effort, unsupported
  OpenAI fields, native free-form `apply_patch`, and optional server-side Web Search.
- **Cost-aware by design.** DeepSeek's 1M context and disk prefix cache are reflected in the runtime;
  `/status` reports context, cache hits, tokens, reasoning, and estimated cost. See current
  [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).
- **Parallel work with clear ownership.** Run explorer, implementer, reviewer, and tester roles with up
  to four tasks in parallel. Implementers work in isolated Git worktrees; the primary agent owns
  integration and final validation.
- **Local control.** Sessions are stored as local tree-shaped JSONL. Commands run in an OS sandbox with
  network blocked by default, API keys are removed from child-process environments, and every successful
  patch creates a durable, conflict-safe checkpoint.
- **No workflow reset.** DSCode understands `AGENTS.md` and `CLAUDE.md`, and supports Agent Skills, MCP,
  hooks, project trust, background jobs, JSONL/CI, RPC, and a VS Code entry point.

For an evidence-based comparison with Claude Code and Codex, see
[DSCode compared](docs/COMPARISON.en.md). The short version: those products have broader and more mature
ecosystems; DSCode is narrower, DeepSeek-specific, locally controlled, and MIT-licensed.

## Quick start

Requirements: Node.js 22.19+ and Git. DSCode also uses `rg`; the installer prepares pnpm and installs
ripgrep through Homebrew when available.

Install from npm:

```bash
npm install -g dscode
```

Alternatively, install the latest source build:

```bash
curl -fsSL https://raw.githubusercontent.com/thinkany-ai/dscode/main/scripts/install.sh | sh
```

Make sure `~/.local/bin` is on your `PATH`, then authenticate and start:

```bash
dscode login
dscode -C /path/to/project
```

DSCode masks the API key, validates it through DeepSeek's `/models` endpoint, and stores it in
`~/.dscode/agent/auth.json` with `0600` permissions. To avoid storing a key:

```bash
export DEEPSEEK_API_KEY="sk-..."
dscode -C /path/to/project
```

## Default runtime

```text
model       deepseek-v4-flash
transport   responses
thinking    max
harness     minimal
permission  auto
sandbox     workspace-write
network     blocked
```

The default `minimal` harness exposes a small set of high-leverage tools: sandboxed commands,
background-process interaction, free-form patches, and parallel delegation. Use `--harness safe` to add
explicit file reading, file search, and automatic language diagnostics.

## Everyday commands

```bash
# Start a new session
dscode -C ./my-project

# Continue or select a previous session
dscode -C ./my-project --continue
dscode -C ./my-project --resume

# One-shot output, JSONL automation, or IDE RPC
dscode -C ./my-project -p "Explain the authentication flow"
dscode -C ./my-project --mode json -p "Fix lint errors and run tests"
dscode -C ./my-project --mode rpc
```

Inside the TUI:

| Command | Purpose |
| --- | --- |
| `/plan` | Enter or leave structured read-only planning |
| `/permissions` | Show or change `plan`, `ask`, `auto`, or `full` access |
| `/status` | Show model, context, cache hits, tokens, cost, and session details |
| `/diff` | Inspect the current patch transcript |
| `/checkpoints` / `/undo` | Inspect or restore durable patch checkpoints |
| `/resume` / `/fork` / `/tree` | Navigate tree-shaped local sessions |
| `/compact` | Compact older context while preserving current work |
| `/jobs` | Inspect reconnectable background commands |
| `/mcp` / `/agents` / `/doctor` | Inspect integrations, agents, and runtime health |
| `/effort low\|high\|max` | Change DeepSeek reasoning effort |

Type `/` for all commands and `/hotkeys` for keyboard shortcuts.

## Safety model

Permissions decide when DSCode asks. The sandbox decides what a command can actually access.

| Mode | Behavior |
| --- | --- |
| `plan` | Read-only exploration; write, delegation, and MCP tools are hidden |
| `ask` | Commands, writes, delegation, and MCP require approval |
| `auto` | Routine workspace work runs automatically; destructive commands, network, host access, and external MCP remain gated |
| `full` | Trusted mode with unrestricted host filesystem and network access |

The default command boundary is `workspace-write` with no network. When a command needs network or host
access, the TUI offers **Allow once**, **Allow this command for this session**, or **Deny**, then retries
an approved command with the smallest applicable access. Use `--network` to pre-authorize network for a
run; use `--permission full` only in a trusted workspace.

macOS uses Seatbelt. Linux and Windows use a configured Docker sandbox:

```bash
export DSCODE_SANDBOX_IMAGE="your-reviewed-image:tag"
dscode -C ./project --sandbox workspace-write
```

If no sandbox backend is available, DSCode fails closed rather than silently executing on the host.

## DeepSeek-specific behavior

- The Responses API is stateless; DSCode replays messages, reasoning items, and tool results from the
  local session tree.
- The adapter removes unsupported OpenAI storage, cache-retention, and include fields.
- Thinking mode removes sampling parameters that DeepSeek ignores and supports `low`, `high`, and `max`
  effort selection.
- `apply_patch` uses a native free-form custom tool to avoid JSON escaping for large diffs.
- Prompt and tool ordering remain stable so DeepSeek's automatic prefix cache has useful prefixes.
- `--web` adds DeepSeek server-side Web Search without replacing local repository search.

## Extensibility and automation

- Hierarchical `AGENTS.md` and `CLAUDE.md` project instructions
- User and project Agent Skills
- Trusted-project hooks and MCP servers
- Reconnectable background commands
- JSONL output for CI and a full stdin/stdout RPC mode
- VS Code extension in [editors/vscode](editors/vscode/README.md)
- Automatic TypeScript, Pyright, Rust, Go, and Swift diagnostics with the `safe` harness

## Build from source

```bash
git clone https://github.com/thinkany-ai/dscode.git
cd dscode
corepack enable
pnpm install
pnpm check
pnpm dev -C /path/to/project
```

Useful validation commands:

```bash
pnpm check             # typecheck, tests, and production build
pnpm smoke:live        # real DeepSeek edit-and-test smoke flow
pnpm acceptance:live   # complete real-API feature acceptance
```

Daily development happens on `dev`; releases are merged to `main` and published from a matching GitHub
Release tag. See [Releasing DSCode](docs/RELEASING.md).

## Current boundaries

- DeepSeek V4 Flash Responses currently accepts text input; image tasks need an external vision tool or
  MCP server.
- The VS Code extension is a local integration and is not published to the Marketplace yet.
- Linux and Windows isolation depends on the Docker image you configure.
- DSCode is an early project. Claude Code and Codex currently have broader IDE, cloud, multimodal, and
  ecosystem support.

We do not claim that a feature checklist makes DSCode universally better. The project is designed to be
measured on real repository tasks by success rate, time, cost, safety, and human intervention.

## License

[MIT](LICENSE)
