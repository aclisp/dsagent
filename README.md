<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

English | [简体中文](README.zh-CN.md)

DSCode is a DeepSeek V4 Flash coding agent built for local repositories. It combines Pi's mature TUI,
tree-structured sessions, and extension system with the V4 Flash Responses API, a 1M-token context
window, `max` reasoning, native `apply_patch`, and cost-effective parallel execution.

Version `0.3.0` is no longer a simple chat wrapper. It is a complete coding-agent runtime with:

- Multiline editing, input history, queued messages and interruption, collapsible tools and reasoning,
  live tool output, and a status bar;
- Automatic saves, resume, naming, fork, tree, compact, import, and export;
- Atomic multi-file patches, per-file approval, persistent checkpoints, conflict-safe `/undo`, and
  transcript diffs;
- `plan`, `ask`, `auto`, and `full` permission policies, plus an independent OS sandbox with network
  access blocked by default;
- `AGENTS.md`/`CLAUDE.md`, Agent Skills, hooks, MCP, and project trust;
- Reconnectable background commands, JSONL/CI, full RPC, a VS Code entry point, and language diagnostics;
- Explorer, implementer, reviewer, and tester agents with up to four concurrent tasks; implementers use
  isolated Git worktrees;
- Stateless DeepSeek Responses replay, a stable prompt designed for automatic prefix caching,
  `low/high/max` thinking, and server-side Web Search.

See the [Product Strategy](docs/PRODUCT_STRATEGY.md) for the complete product rationale and competitive
advantages. For a feature-by-feature comparison with Claude Code and Codex, see the
[comparison document](docs/COMPARISON.en.md) ([中文](docs/COMPARISON.md)).

## Installation

DSCode requires Node.js 22.19+ and `rg`. macOS uses the native Seatbelt sandbox. Isolated execution on
Linux and Windows requires Docker and a trusted image.

### Option 1: one-line curl install (dependencies included)

Install through a Claude Code-style curl pipeline. The script detects Node, prepares pnpm through
Corepack, installs ripgrep through Homebrew when needed, places the source in
`~/.local/share/dscode`, and installs the `dscode` command in `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/thinkany/dscode/main/scripts/install.sh | sh
```

Only Node.js 22.19+ and `git` must already be installed; the script also prepares pnpm and ripgrep.
To uninstall:

```bash
rm -rf ~/.local/share/dscode ~/.local/bin/dscode
```

### Option 2: global npm install

```bash
npm install -g @thinkany/dscode
dscode -C /path/to/project
```

### First launch and API key

On first launch, DSCode prompts for a DeepSeek API key. Input is masked with dots. DSCode validates the
key through the official `/models` endpoint, then stores it in `~/.dscode/agent/auth.json` with `0600`
permissions. You can also configure it in advance:

```bash
# Recommended: securely enter, validate online, and save the key
dscode login

# Or set it only for the current shell without writing it to disk
export DEEPSEEK_API_KEY="sk-..."
```

Inside the TUI, use `/login` (or `/login deepseek`) to replace the DeepSeek API key. DSCode does not show
Pi's other provider or account login options, and both input and submission history remain masked.
`dscode auth status` shows only the credential source, never the key. `dscode logout` removes the saved
credential.

For source development or local validation:

```bash
# Install dependencies and build for the first time
pnpm install
pnpm build

# Run the output from the latest build
pnpm start

# pnpm forwards arguments directly to DSCode; do not add a separate `--`
pnpm start -C /path/to/project

# Run the latest source directly; no build is required after code changes
pnpm dev -C /path/to/project

# Complete pre-release validation
pnpm check
```

## Common launch modes

```bash
# Start a new interactive session
dscode -C ./my-project

# Continue the most recent session in the current workspace
dscode -C ./my-project --continue

# Select, name, or fork a session
dscode -C ./my-project --resume
dscode -C ./my-project --name "fix auth race"
dscode -C ./my-project --fork <session-id>

# One-shot output / JSONL CI / IDE RPC
dscode -C ./my-project -p "Explain the authentication flow"
dscode -C ./my-project --mode json -p "Fix lint errors and run tests"
dscode -C ./my-project --mode rpc
```

The defaults are:

```text
model       deepseek-v4-flash
transport   responses
thinking    max
harness     minimal
permission  auto
sandbox     workspace-write
network     blocked
```

The `minimal` harness exposes only high-leverage tools to V4 Flash: sandboxed commands, background
process interaction, free-form patches, and parallel delegation. `--harness safe` also provides file
reading, file search, and automatic language diagnostics for stricter auditing requirements.

## Interactive experience

New sessions display a block-whale logo in DeepSeek blue (`#4E6BFE`) and a DSCode welcome card. The
terminal automatically uses a matching pixel-art outline. The input area uses a borderless panel and a
native blinking block cursor; when the input is empty, the cursor covers the first character of the
placeholder. The default status line shows only the model, thinking effort, and current directory. It
adds warnings only when permissions are elevated or context usage exceeds 70%. Cumulative tokens, cache
hit rate, and cost stay out of the way and remain available through `/status`.

Type `/` in the editor to see every command, or use `/hotkeys` for keyboard shortcuts. Common actions:

| Action | Behavior |
| --- | --- |
| `Enter` / `Alt+Enter` | Queue a steering or follow-up message while the agent is working |
| `Escape` | Interrupt the current run |
| `quit` / `exit` / `退出` / `/quit` / `Ctrl+D` | Exit DSCode safely without calling the model |
| `Ctrl+O` / `Ctrl+T` | Collapse tool output / reasoning |
| `Ctrl+G` | Edit a long prompt in an external editor |
| `Shift+Tab` | Change the thinking level |
| `/resume` `/name` `/fork` `/tree` | Resume, name, branch, and navigate session timelines |
| `/compact [prompt]` | Compact context manually |
| `/status` | Show model, permissions, context, cache hits, tokens, cost, and session details |
| `/session` | Show Pi's underlying session statistics and session file |
| `/plan` `/permissions` | Change structured planning mode or permission policy; `/plan show` displays the current plan |
| `/effort low\|high\|max` | Change DeepSeek thinking effort |
| `/diff` `/checkpoints` `/undo` | Inspect changes and checkpoints or perform a safe rollback |
| `/jobs` | Show background commands that are running or waiting for results |
| `/mcp` `/agents` `/doctor` | Inspect extensions, subagents, and runtime diagnostics |

Every successful `apply_patch` immediately creates a persistent checkpoint. `/undo` restores a file only
when it still matches the checkpoint's after snapshot. If the user changed it afterward, DSCode refuses
to overwrite it. Use `/undo --force` only when replacement is intentional.

`/plan` enters a genuinely read-only planning mode. After repository investigation, the model must call
`update_plan`. The TUI displays a card with `pending / in_progress / completed` steps and lets the user
choose whether to execute, remain in planning mode, or keep refining the plan. During execution, write
tools and the previous permission policy return, plan state follows validation results, and the plan is
persisted with the session. Use `/plan clear` to remove it.

## Permissions and sandboxing are different

Permissions decide whether an action needs human approval. The sandbox decides what a process can
actually access even after approval.

| Permission | Behavior |
| --- | --- |
| `plan` | Hides write, delegate, and MCP tools; commands are forced into a read-only sandbox |
| `ask` | Reads run automatically; commands, delegation, MCP, and writes require approval; patches are reviewed per file |
| `auto` | Workspace patches and sandboxed commands run automatically; external MCP calls still require approval |
| `full` | Disables approval prompts; it does not automatically disable the OS sandbox |

| Sandbox | Behavior |
| --- | --- |
| `read-only` | Commands cannot write files |
| `workspace-write` | Commands can write only to the workspace, system temporary directories, and required devices; this is the default |
| `danger-full-access` | Commands use the current user's host permissions; use only in trusted environments |

Commands and the `!` user shell have no network access by default; pass `--network` explicitly to enable
it. `DEEPSEEK_API_KEY` is removed from the default environment of commands, hooks, and MCP stdio child
processes. Model API calls and explicitly configured remote MCP transports are not subject to the command
sandbox's network policy.

macOS uses the system Seatbelt sandbox. On other platforms, configure the Docker backend:

```bash
export DSCODE_SANDBOX_IMAGE="your-reviewed-image:tag"
dscode -C ./project --sandbox workspace-write
```

If no supported backend is available, DSCode fails closed instead of silently running on the host.

## Project rules and Skills

Pi reads `AGENTS.md` or `CLAUDE.md` hierarchically from the current directory and its parents. DSCode also
requires the agent to discover and follow more specific nested rules before modifying deeper directories.

Skills can be stored in:

```text
~/.dscode/agent/skills/
~/.agents/skills/
<project>/.pi/skills/
<project>/.agents/skills/
```

Invoke a skill explicitly with `/skill:name`, or let the model load one based on its description. Project
skills, settings, extensions, hooks, and MCP should be enabled only after trusting the repository. Use
`/trust` in interactive mode or pass `--approve` explicitly in non-interactive mode.

## Hooks

Global configuration lives in `~/.dscode/hooks.json`; trusted-project configuration lives in
`.dscode/hooks.json` and is appended to the global configuration:

```json
{
  "hooks": {
    "sessionStart": [
      { "command": "node", "args": ["scripts/session-start.mjs", "{cwd}"] }
    ],
    "beforeTool": [
      { "command": "node", "args": ["scripts/policy.mjs", "{tool}", "{payload}"] }
    ],
    "afterTool": [],
    "agentEnd": []
  }
}
```

A non-zero `beforeTool` exit blocks the tool. Available placeholders are `{cwd}`, `{tool}`, and
`{payload}`. Hooks also run inside the selected OS sandbox and follow the `--network` setting.

## MCP

Global configuration lives in `~/.dscode/mcp.json`; trusted-project configuration lives in
`.dscode/mcp.json`:

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["./tools/mcp-server.mjs"],
      "env": { "TOKEN": "${MY_MCP_TOKEN}" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
    }
  }
}
```

Tools are registered as `mcp__<server>__<tool>`. Use `/mcp` to inspect connections and errors. Every
external MCP call requires approval in `auto` and `ask` modes. Headless automation that needs MCP should
explicitly use `full` in a trusted environment.

## Multiple agents and background tasks

The model can submit up to eight `delegate` tasks at once, with up to four running concurrently:

- `explorer`: read-only repository investigation;
- `reviewer`: independent read-only review;
- `tester`: sandboxed testing and failure diagnosis;
- `implementer`: creates a detached worktree from the current `HEAD` and returns a candidate diff.

The primary agent always owns integration and final validation. Implementer worktrees are preserved by
default, and their paths are included in the output so they are not deleted or merged before user review.

When `exec_command` is still running after 10 seconds, it returns a `process_id`. The model can poll,
write input, or terminate it with `write_stdin`; `/jobs` displays the current registry.

## IDE and automation

The VS Code extension lives in [editors/vscode](editors/vscode/README.md). It can open the integrated TUI,
send the current selection, and pass VS Code language diagnostics to the agent for fixes. The `safe`
harness's `language_diagnostics` tool also discovers locally installed TypeScript, Pyright, Rust, Go, and
Swift checkers automatically.

For deeper IDE integration, use:

```bash
dscode -C ./project --mode rpc
```

RPC uses JSONL over stdin/stdout and supports streaming events, status queries, prompts, steering,
follow-ups, session operations, model and thinking changes, and extension UI approvals. For regular CI,
use `--mode json --print --no-session`; add `--approve` when project resources are required.

## Validation

Run the release checks without spending model credits:

```bash
pnpm check
```

This runs type checking, the complete test suite, and a production build. Coverage includes a real Pi
JSONL launch, simulated DeepSeek Responses SSE, request-payload validation, Seatbelt write boundaries,
checkpoint conflict protection, and background-task reconnection.

Run the full “discover rules → modify → test → verify” flow against the real DeepSeek API:

```bash
export DEEPSEEK_API_KEY="sk-..."
pnpm smoke:live
```

On failure, the temporary fixture is preserved and its path is printed. It is removed after a successful
run by default. Set `DSCODE_KEEP_SMOKE=1` to preserve it every time.

The complete real-API pre-release acceptance suite also validates session naming and resume, model-driven
MCP, credential isolation, explorer + implementer parallel delegation, and isolated Git worktrees:

```bash
pnpm acceptance:live
```

Use `features:live` to run only those real feature checks. The complete TUI should still be inspected
manually in a PTY for input, streaming rendering, the status bar, approval dialogs, collapsed tools and
reasoning, and exit behavior.

For manual acceptance, use a clean Git repository and test these scenarios in order:

```text
1. After /plan, request a file change. Confirm that an Updated Plan card appears, write tools are unavailable, and select Execute the plan.
2. During execution, confirm that only one step is in_progress and steps become completed only after validation.
3. Use /diff, /checkpoints, and /undo; then edit a file manually and verify conflict protection.
4. Run a test longer than 10 seconds and inspect process_id, /jobs, and write_stdin.
5. Use /name, exit, --continue, /fork, /tree, and /compact.
6. Configure an MCP server and a hook, then test trusted and untrusted projects.
7. Let explorer, reviewer, tester, and implementer handle independent tasks concurrently.
8. Run CI with --mode json, then connect a minimal client with --mode rpc.
```

## Packaging and release

The package name and CLI entry point are configured as `@thinkany/dscode` and `dscode`. The release
account must have access to the npm `thinkany` scope. Then run:

```bash
pnpm check
npm pack --dry-run
npm publish --access public
```

`prepack` rebuilds `dist`, while `prepublishOnly` blocks releases when tests or type checking fail. After
publishing, verify `npm install -g @thinkany/dscode`, `dscode --version`, `dscode login`, and the first-run
flow in a clean directory.

## V4 Flash-specific adaptations

- Stateless Responses API: the complete session, reasoning items, and tool results are replayed from the
  local JSONL tree;
- The system prompt, tool order, and engineering conventions remain stable to maximize DeepSeek automatic
  prefix-cache hits;
- Invalid `temperature`/`top_p` parameters are removed when thinking is enabled; the default is `max`, with
  `low` and `high` also available;
- Unsupported OpenAI store, cache-retention, and include semantics are removed;
- `apply_patch` uses V4 Flash's free-form custom-tool format to avoid JSON escaping for large patches;
- The 1M-token context still follows “locate with rg, read only what matters, compact near the budget”
  instead of blindly loading the repository;
- `--web` enables DeepSeek server-side Web Search for tasks requiring current information; it does not
  replace local code search.

## Known limitations

- V4 Flash Responses currently accepts text input; image tasks require an external vision tool or MCP;
- `danger-full-access`, project extensions, and user-installed skills can execute arbitrary code by design;
- Tooling available in the Docker backend depends on the selected image;
- The VS Code extension is a local thin integration and has not been published to the Marketplace;
- “Perfect parity with Claude Code/Codex” can be demonstrated only through success rate, duration, cost,
  and human-intervention rate on real task suites—not through a feature checklist. The repository already
  provides the JSONL, isolation, and repeatable-session foundation required for that evaluation.
