# CLI & Runtime Reference

## Terminal app

Requirements: Node.js 22.19+ and Git. DSCode also uses `rg`.

Start DSCode from a local source checkout:

```bash
dscode -C /path/to/project
```

On a fresh installation, enter `/login` in the TUI and choose a provider. DSCode completes
authentication and selects that provider's default model. DeepSeek remains the default for
non-interactive commands and explicit provider-free configuration.

| Provider | ID | Authentication |
| --- | --- | --- |
| DeepSeek | `deepseek` | API key |
| OpenAI Codex | `openai-codex` | Eligible ChatGPT plan (legacy provider) |
| OpenAI | `openai` | ChatGPT account or API key |
| Anthropic | `anthropic` | Claude account or API key |
| OpenRouter | `openrouter` | OpenRouter account or API key |
| Z.AI Coding Plan | `zai` | API key |
| Kimi For Coding | `kimi-coding` | Kimi Code account or API key |
| MiniMax | `minimax` | API key |
| xAI / Grok | `xai` | Grok/X account or API key |
| OpenCode Zen Go | `opencode-go` | API key |

The aliases `kimi` and `grok` are accepted by `/login` and `--provider`.

When configuring DeepSeek, DSCode masks the API key, then offers an optional API base URL. Press Enter to use
`https://api.deepseek.com`, or enter a DeepSeek/OpenAI-compatible gateway URL. By default, credentials
use the operating system keyring; `~/.dscode/auth.json` is the owner-only fallback for headless hosts
or unavailable keyring services. The endpoint is stored in `~/.dscode/config.json` with `0600`
permissions. Resolution order is `--base-url`, `DEEPSEEK_BASE_URL`, saved config, then the official
DeepSeek URL. To avoid storing a key:

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
dscode -C /path/to/project
```

You can also authenticate before opening the TUI:

```bash
dscode login deepseek      # DeepSeek API key
dscode login openai-codex  # browser OAuth; ChatGPT plan limits (legacy provider)
dscode login openai        # ChatGPT account (browser OAuth) or OpenAI API key
dscode login anthropic     # Claude account or Anthropic API key
dscode login openrouter    # OpenRouter account or API key
dscode login opencode-go   # OpenCode Zen Go API key
```

The selected provider and model are saved for later runs. Override them at any time:

```bash
dscode --provider openai-codex --model gpt-5.6-sol -C /path/to/project
dscode --provider deepseek --model deepseek-flash -C /path/to/project
```

DSCode keeps all of its global state under `~/.dscode`:

```text
~/.dscode/settings.json    TUI and runtime preferences
~/.dscode/config.json      DSCode storage policy and DeepSeek endpoint
~/.dscode/auth.json        Owner-only credential fallback
~/.dscode/credential-metadata.json  Non-secret keyring index
~/.dscode/state.sqlite     Thread metadata and desktop runtime state
~/.dscode/skills/          Global skills
~/.dscode/extensions/      Global extensions
~/.dscode/mcp.json         Global MCP servers
~/.dscode/hooks.json       Global hooks
~/.dscode/sessions/YYYY/MM/DD/  JSONL session transcripts
~/.dscode/archived_sessions/   Archived transcripts
```

The flat `sessions/*.jsonl` names are hard-link compatibility entries for the current terminal
runtime; each points to the same inode as its date-partitioned transcript and does not duplicate
content. JSONL is the transcript source of truth. SQLite contains only searchable thread metadata,
pin/archive state, and file fingerprints.

Credential and history behavior can be configured in `~/.dscode/config.json`:

```json
{
  "cli_auth_credentials_store": "auto",
  "history": { "persistence": "save-all" }
}
```

Credential modes are `auto`, `keyring`, and `file`. Set history persistence to `none` to run new
sessions without writing transcripts. `DSCODE_SQLITE_HOME` relocates only SQLite state.

DSCode fills missing preferences in `~/.dscode/settings.json` on startup and preserves
existing explicit values. TUI defaults are `hideThinkingBlock: true`, `tuiMode: "fullscreen"`,
`fullscreenExitOutput: "transcript"`, and `fullscreenScrollbar: "hidden"`. Change them in
`/settings` or the settings file; an explicit `--tui-mode` selection takes precedence.

Cache warming defaults to `off` to avoid additional model requests after an upgrade. To opt in,
set `"cacheWarming": "streaming"` (during runs) or `"cacheWarming": "idle"` (also between runs)
in `~/.dscode/settings.json`. `/status` includes cache-warming usage and estimated cost.

Set `DSCODE_HOME` to relocate the directory, or `DSCODE_SESSIONS_DIR` to relocate only session
history. DSCode does not inherit `PI_CODING_AGENT_DIR`. Existing files under `~/.dscode/agent` are
copied into the new layout on first launch without deleting or overwriting anything. Project skills
should use the portable `.agents/skills/` convention.

## Default runtime

Fresh installations use:

```text
model       deepseek-flash
transport   responses
thinking    max
permission  auto
sandbox     workspace-write
network     blocked
```

CLI and Web use the same default tools: `read,exec_command,write_stdin,apply_patch,codemode`.
CLI and Web/HTTP agents can start ordinary DSCode CLI children through `exec_command`
and collect their output with `write_stdin`. Direct `dscode ...` invocations use a fixed
installed CLI entrypoint with model credentials preserved; they do not use PATH lookup
or the parent's command sandbox. The child controls its own model, thinking level,
permissions, command sandbox, and command-network access through normal CLI flags and
defaults. No parent permission ceiling or extra approval flow is added. Provider calls
work even when the parent's shell-command network access is blocked. Container and
other external OS restrictions still apply.
Launching `dscode` is classified as a dangerous command and uses the parent's existing
command approval flow (`auto` requires approval; `full` allows it). Standalone help and
version invocations are exempt.

### Background CLI children

The [dscode-delegate skill](../deploy/default-skills/dscode-delegate/SKILL.md) provides
on-demand delegation guidance. Docker seeds it alongside `dscode-vision`. For ordinary
CLI and standalone installations, manually copy the entire `dscode-delegate` directory
from `deploy/default-skills/` into `~/.dscode/skills/` (or `$DSCODE_HOME/skills/`). The skill
is discoverable automatically; launch instructions are not included in the core prompts.

Give each child a self-contained task: it starts a fresh conversation unless you select
an existing session. Children can edit, run commands and tests, and use MCP/extensions.
The managed DSCode child depth limit is one, matching the original `delegate`: a parent
can launch multiple children, but children cannot launch another DSCode child through
`exec_command`, even with full permissions. The default working directory is shared with the parent;
coordinate edits or explicitly create a Git worktree for overlapping work. Model and
thinking choices use `--provider`, `--model`, and `--effort`. Specify permission and
sandbox flags explicitly when reproducibility matters. `--no-session` is recommended
for disposable children.

Launch through the existing tool:

```json
{"cmd":"dscode --no-session --permission auto --sandbox workspace-write -p 'Implement and verify the assigned task'","yield_time_ms":0,"timeout_ms":0}
```

The tool returns a `process_id`. **Print mode reads piped stdin until EOF**, so immediately
start the task with the returned ID:

```json
{"process_id":"1","eof":true,"yield_time_ms":0}
```

Optional `chars` can supply additional task context before EOF. The parent can then do
independent work and call `write_stdin` without `chars` to collect new output. Collect
all child results and inspect their changes before concluding. Print mode rejects
operations requiring an interactive approval UI; a child should report unfinished work
and the blocked operation rather than silently treating it as complete.

`timeout_ms: 0` disables the process deadline for any managed command. Omission keeps
the 120000 ms default; positive deadlines are 1000–600000 ms. `yield_time_ms` only controls
how long a tool call waits (up to 30000 ms), independently of the process lifetime.
Use `write_stdin` with `terminate: true` to stop a child. Session shutdown terminates
remaining managed processes; print-mode parents must collect results before exiting.

### RPC children and approvals

Use `dscode --mode rpc --no-session` for follow-up interaction and approval dialogs.
Leave stdin open and send one JSON record per line through `write_stdin`:

```json
{"type":"prompt","message":"Implement and verify the assigned task"}
```

Append an actual newline to each stdin record. Poll output for `extension_ui_request`
records. Obtain the user's decision, then reply with the matching request ID:

```json
{"type":"extension_ui_response","id":"request-id","confirmed":true}
```

For `select` requests, send `value` with the selected option; cancellation uses
`cancelled: true`. Do not automatically approve requests. A successful `prompt` response
only acknowledges acceptance: consume the final assistant result and wait for
`agent_settled` before concluding, then send EOF to close the RPC child. RPC processes
remain alive between tasks, and output is bounded, so poll regularly. The parent handles
protocol requests explicitly; child dialogs are not automatically forwarded into the
Web UI's native approval dialogs.


MCP uses Pi 1.0.4's native implementation and schema. Global configuration is
`DSCODE_HOME/mcp.json` (default `~/.dscode/mcp.json`); trusted projects use `.pi/mcp.json`.
Disable a server with `enabled: false`. The default `exposure: "codemode"` makes tools
callable from scripts. Codemode's `searchTools()` and `describeTool()` discover tools
without changing the model's active tool declarations. `tool_search` is optional:
include it in `--tools` or use server `exposure: "deferred"`, which activates it
automatically and loads matches for direct model calls. `exposure: "direct"` advertises
every server tool. `--tools` selects the initial active set; `--no-mcp` skips MCP,
and `--no-tools` disables all tools.

Pi supplies `/mcp` and `dscode mcp add|remove|list|login|logout`, including native OAuth
and reconnection controls. CLI MCP management needs no model login. Use `-l` with
`dscode mcp add` or `remove` for project `.pi/mcp.json`. For example:

```bash
dscode mcp add local -l -- node /path/to/server.mjs
dscode mcp list --json
```

Server-defined MCP tools require approval in `auto`/`ask`; `full` permits
them without confirmation. The dialog shows the server namespace, tool, description,
arguments, and `readOnlyHint` as true, false, or not provided. This hint comes from
the server and does not automatically grant approval. Choose **Allow once**,
**Allow this tool for this session**, **Allow all tools from this server for this session**,
or **Deny**. Tool and server grants cover future calls with any arguments, including
calls nested in codemode. `/permissions` lists grants. Use
`/permissions revoke-mcp <tool-or-server-namespace>` to revoke a listed grant, or
`/permissions revoke-mcp all` to clear them all. Revoking a server namespace also
clears individual grants for its tools. Grants reset when starting, resuming, or
forking a session, and on reload or exit.
The standard `list_mcp_resources`, `list_mcp_resource_templates`,
and `read_mcp_resource` helpers are read-only and run without approval in every mode.
Calls requiring approval are rejected without an interactive UI.
Codemode's nested calls pass through the same permissions; `exec_command` keeps its
sandbox and `apply_patch` keeps checkpoints and `/undo`. Codemode runs in normal
`on` mode with direct model/classifier/image APIs (`models`) disabled.

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

# Inspect a screenshot with a vision-capable model
dscode --provider openai-codex @screenshot.png "Explain this error"
```

Inside the TUI, paste a PNG, JPEG, GIF, or WebP image and add your question. DSCode immediately replaces
the terminal's local path with an `[Image #N]` marker, attaches the image bytes to the message, and
supports up to eight images of 20 MB each per turn.

Inside the TUI:

| Command | Purpose |
| --- | --- |
| `/permissions` | Show or change `ask`, `auto`, or `full` access; list MCP session grants |
| `/permissions revoke-mcp <tool-or-server-namespace\|all>` | Revoke MCP session grants |
| `/status` | Show model, context, cache hits, tokens, cost, and session details |
| `/diff` | Inspect the current patch transcript |
| `/checkpoints` / `/undo` | Inspect or restore durable patch checkpoints |
| `/new` / `/clear` | Clear the current context and start a new session (aliases) |
| `/resume` / `/fork` / `/tree` | Navigate tree-shaped local sessions |
| `/compact` | Compact older context while preserving current work |
| `/jobs` | Inspect reconnectable background commands |
| `/mcp` / `/doctor` | Inspect integrations and runtime health |
| `/login [provider]` | Choose and authenticate a supported model provider |
| `/model` | Select a configured model; the choice is saved |
| `/effort ...` | Change the active model's reasoning effort |

Type `/` for all commands and `/hotkeys` for keyboard shortcuts.

Completed managed processes are removed as soon as `exec_command` or `write_stdin`
returns their final result. Background processes that finish between reads retain
their output and exit status until the next `write_stdin` call. Each CLI or Web
session retains at most 100 such unread completed records. When that
limit is exceeded, the earliest-completed record is removed, including any unread
output; later `write_stdin` calls for that ID return `Unknown process`. Running
processes are never evicted by this limit. `/jobs` keeps showing both running and
retained completed records.

## Safety model

Permissions decide when DSCode asks. The sandbox decides what a command can actually access.

| Mode | Behavior |
| --- | --- |
| `ask` | Commands, writes, delegation, and MCP require approval |
| `auto` | Routine workspace work runs automatically; destructive commands, network, host access, and external MCP remain gated |
| `full` | Trusted mode with unrestricted host filesystem and network access |

The default command boundary is `workspace-write` with no network. When a command needs network or host
access, the TUI offers **Allow once**, **Allow this command for this session**, or **Deny**, then retries
an approved command with the smallest applicable access. Use `--network` to pre-authorize network for a
run; use `--permission full` only in a trusted workspace. `dscode -y` is the explicit YOLO shortcut: it
trusts project resources for that run, skips tool approvals, disables the sandbox, and enables network.

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
- Sampling parameters are preserved: DeepSeek uses `top_p` in thinking mode and `temperature` otherwise.
  Thinking supports `low`, `high`, and `max` effort selection.
- `apply_patch` uses a schema-based function tool with an `input` string for every provider.
- Prompt and tool ordering remain stable so DeepSeek's automatic prefix cache has useful prefixes.

These transformations run only when the active provider is `deepseek`; other providers use their
native runtime implementations. Provider API keys are stripped from commands, hooks, and stdio MCP
server environments. Explicit MCP server `env` values can supply credentials.

## Extensibility and automation

- Hierarchical `AGENTS.md` and `CLAUDE.md` project instructions
- User and project Agent Skills
- Trusted-project hooks and MCP servers
- Reconnectable background commands
- JSONL output for CI and a full stdin/stdout RPC mode
- Reusable `@aclisp/dsagent-core` package with a bundled headless RPC worker
- VS Code extension in [editors/vscode](../editors/vscode/README.md)
- Run project compiler and language checks through `exec_command`

### Input hooks

The built-in hook runner supports `hooks.input` in `~/.dscode/hooks.json` and trusted-project
`.dscode/hooks.json`, including in the standalone CLI. Global hooks run before project hooks.
For example, configure a project-local script:

```json
{
  "hooks": {
    "input": [
      {
        "command": "node",
        "args": ["{cwd}/append-input.cjs", "{payload}"]
      }
    ]
  }
}
```

Create `append-input.cjs` in the project directory:

```js
const input = JSON.parse(process.argv[2]);
process.stdout.write(`${input.text}\n\nPlease respond in Chinese.`);
```

`{payload}` contains only `event: "input"` and `text`. Write the complete replacement message as
plain text to stdout; empty or whitespace-only output leaves the text unchanged. Nonempty output
is preserved exactly, including whitespace, and later hooks receive the updated text. Write
diagnostics to stderr.

DSCode applies these hooks to human input from the CLI and RPC, including queued messages, before
skill/template expansion. Extension-generated input and commands handled directly by extensions
bypass them. Attachments and delivery behavior remain controlled by DSCode/Pi; hooks can only
replace text. Failed, timed-out, or truncated responses raise an extension error; Pi continues
with the input received by this handler, without applying partial replacements.
Hooks use the current sandbox/network access and require an external executable even in standalone
builds. Restart the session after editing hook configuration.

### UI prompt hooks

Configure `hooks.uiPromptStart` to run a notification command when the session starts waiting
for a blocking UI prompt, and `hooks.uiPromptEnd` to clean up when it stops waiting.
For example, play a sound on macOS:

```json
{
  "hooks": {
    "uiPromptStart": [
      {
        "command": "/usr/bin/afplay",
        "args": ["/System/Library/Sounds/Glass.aiff"]
      }
    ]
  }
}
```

Use `~/.dscode/hooks.json` or a trusted project's `.dscode/hooks.json`. This works in the
standalone CLI without user extensions. Configuration loads at `session_start`; earlier
project-trust dialogs are not covered. Restart the session after changing the configuration.

`{payload}` contains `event: "uiPromptStart"` or `"uiPromptEnd"`, `promptId`, `kind` (`confirm`, `select`, `input`, `editor`,
or `custom`), `mode` (`tui`, `rpc`, `json`, or `print`), and an optional `title`. Custom dialogs
have no title metadata. Pi groups overlapping prompts into one waiting period. Commands
run on the agent host, including for RPC/HTTP clients, using current sandbox/network access;
they do not play sound on a remote client. A script can inspect `mode` to restrict notifications
to the terminal UI. Global hooks run before trusted-project hooks. Hook output does not answer
the dialog; failures are reported as extension errors and do not block or deny it. Subprocess
stdin waits and other waits outside Pi's UI prompt API do not trigger these hooks.

For persistent reminders, key each reminder by `promptId` from `{payload}`. DSCode generates a
UUID for each waiting period and includes the same ID in its start/end payloads. Different
sessions in the same workspace and later prompts with the same title receive different IDs.
All configured commands for that waiting period share the ID. Pi groups overlapping dialogs
within one session, so those dialogs share a single waiting period rather than separate IDs.
Unmatched or duplicate end events are ignored. Use `{cwd}` to display the project, not as the
reminder identity. For example, connect your own reminder script to both hooks:

```json
{
  "hooks": {
    "uiPromptStart": [
      { "command": "/path/to/reminder", "args": ["show", "{cwd}", "{payload}"] }
    ],
    "uiPromptEnd": [
      { "command": "/path/to/reminder", "args": ["clear", "{cwd}", "{payload}"] }
    ]
  }
}
```

End means the waiting period ended (answered, cancelled, timed out, or rejected), not that the
user approved the action. Start/end commands are serialized within each session, even if a hook
fails, so cleanup cannot overtake creation. They remain subject to hook timeouts but are not
cancelled with the agent turn, allowing cleanup after a cancelled prompt. They are not guaranteed
to finish if the process exits or crashes. Make reminder operations idempotent; this is a
notification lifecycle, not an approval-result API.

Graphical clients and IDE integrations can use the private workspace package `@aclisp/dsagent-core`
after completing the developer setup above. It exposes credential and settings APIs plus a typed RPC
client backed by the exact same Agent, tools, permissions, and local session format as the terminal client:

```ts
import { createDSCodeRpcClient } from "@aclisp/dsagent-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => render(event));
await client.prompt("Review this repository");
```

The normal `@aclisp/dsagent` build embeds its matching Core build. npm publication is currently disabled;
developers should use the workspace setup above.

## Build from source

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
corepack enable
pnpm install
pnpm check
pnpm dev -C /path/to/project
```

The root package exposes a small set of primary commands:

- `pnpm build` builds the workspace packages and all production artifacts, including the CLI, web
  server, and vision CLI.
- `pnpm test` runs the full Vitest suite from the repository root, including tests under `packages/`.
- `pnpm typecheck` type-checks package, test, and root TypeScript. It may build workspace packages
  first because cross-package type entrypoints are generated under `dist/`.
- `pnpm check` is the CI/release gate: it builds production artifacts, checks test types, runs the
  full test suite, and performs package smoke checks.
- `pnpm dev` runs the CLI from source; `pnpm start` runs the bundled CLI at
  `dist/bundle/cli.js`, also used by the installed `dscode` command.

The original unbundled CLI is retained at `dist/cli.js`. Run it with
`pnpm start:unbundled` or `node dist/cli.js` for debugging or comparison.
Both variants use the same settings, credentials, sessions, and runtime behavior.
The CLI bundle includes pi's JavaScript dependencies for faster interactive startup;
native modules and assets remain installed dependencies. See [CLI bundling](CLI_BUNDLING.md).

Additional validation commands:

```bash
pnpm smoke:live        # real DeepSeek edit-and-test smoke flow
pnpm acceptance:live   # complete real-API feature acceptance
```

Daily development happens on `dev`. A versioned merge to `main` automatically creates the matching
GitHub Release and publishes the full and lean Docker Hub images after CI passes. See
[Releasing DSCode](RELEASING.md).

## Current boundaries

- DeepSeek Flash accepts image input; DeepSeek V4 Pro remains text-only.
- ChatGPT-plan access follows the models, limits, and workspace permissions available to the signed-in
  account; OpenAI API-key usage is billed separately by the API platform.
- The VS Code extension is a local integration and is not published to the Marketplace yet.
- Linux and Windows isolation depends on the Docker image you configure.
- DSCode is an early project. Claude Code and Codex currently have broader IDE, cloud, multimodal, and
  ecosystem support.

We do not claim that a feature checklist makes DSCode universally better. The project is designed to be
measured on real repository tasks by success rate, time, cost, safety, and human intervention.
