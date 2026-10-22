# @aclisp/dsagent-core

Reusable DSCode agent runtime for graphical clients, IDE integrations, and other headless hosts.

The package owns the same provider routing, tools, permissions, sessions, Skills, MCP, hooks,
checkpoints, and RPC behavior used by the `@aclisp/dsagent` terminal client. DeepSeek remains the
default; Codex, OpenAI, Anthropic, OpenRouter, Z.AI, Kimi, MiniMax, xAI, and OpenCode Zen Go are supported by the same
runtime.

The runtime uses Pi 1.4.0's native MCP, codemode, and tool-search extensions.
Default tools are `read`, `exec_command`, `write_stdin`, `apply_patch`, and `codemode`.
When network access and DeepSeek credentials are available, `web_search` and `web_fetch` are registered
as deferred tools for every chat provider. They are not active by default and do not add their
definitions to codemode's description. Discover them with codemode's `searchTools()` or
`describeTool()`, then call `tools.web_search()` or `tools.web_fetch()`. Native `tool_search` can
also load them as direct tools on demand. Both use the configured DeepSeek service and normal
tool permissions; `--tools` selects initially active tools without disabling deferred calls,
and `--no-tools` disables them.
Disabled network access hides both tools and blocks calls, including cached snapshot
reads. `--network`, full permissions, or a full-access sandbox enable network access.
Search returns five results by default and optionally saves full pages with
`need_content: true`. Fetch reads immutable, versioned Markdown snapshots by URL or
`snapshot_id`, with 1-based `offset`/`limit` pagination. `refresh: true` fetches a new
version without replacing historical snapshots. Snapshot files live in
`DSCODE_HOME/web-snapshots`; session entries contain only their metadata. Non-persistent
sessions keep snapshots in memory. Both tools return structured data to codemode.
Codemode's `searchTools()` and `describeTool()` discover MCP tools without changing
the model's active tool declarations. `tool_search` remains available through
`--tools` or server `exposure: "deferred"`, which activates it automatically.
Codemode runs in normal `on` mode with `models` disabled;
its nested tool calls retain DSCode permissions, sandboxing, and checkpoints.
Pi owns the MCP schema, discovery, OAuth, `/mcp`, and `dscode mcp` commands.
Global configuration is `DSCODE_HOME/mcp.json`; trusted projects use `.pi/mcp.json`.

The built-in extension reuses image uploads through DeepSeek's Files API for `deepseek-flash`
over `openai-responses` on the official endpoint. The session retains Pi's processed image bytes;
only outgoing image parts become `file_id` references. References live in session memory and files
expire after 24 hours. Upload failure/timeout falls back to Base64 with a warning and 60-second
cooldown. Requests during cooldown fall back silently; a failed upload retry can warn again.
The whole batch has a 15-second upload budget. No Web/API changes or extra commands are needed.

```ts
import { createDSCodeRpcClient } from "@aclisp/dsagent-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => console.log(event));
await client.prompt("Explain this repository");
```

Select another supported provider without changing the host integration:

```ts
const client = createDSCodeRpcClient({
  cwd: "/path/to/project",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
});
```

Configuration and sessions use the same `~/.dscode` home as the terminal client. Applications can
use the exported credential and settings functions to build their own login interface without
showing a terminal prompt.

Storage follows the same split used by the Codex desktop architecture: JSONL transcripts remain
the durable source of truth, while `state.sqlite` indexes thread metadata and pin/archive state.
Transcripts are date-partitioned under `sessions/YYYY/MM/DD`; flat hard links preserve compatibility
with the current terminal resume implementation. Credentials use an injectable `CredentialStore`
with `auto`, `keyring`, and owner-only `file` modes. The default `auto` mode uses the OS keyring in
desktop/interactive processes and falls back safely for headless processes.

For graphical authentication, use `saveProviderApiKey()` for API-key providers or pass UI callbacks
to `authenticateProvider()` for provider OAuth and API-key flows. No terminal rendering is required.

## Themes

The DSCode CLI defaults to `dscode-light/dscode-dark`, following the terminal's
appearance. These bundled themes preserve Pi 0.87.1's colors exactly; only their
names differ. The previous `light/dark` default migrates once to the DSCode pair.
Explicit single-theme and custom selections remain unchanged. Pi's current
`light`, `dark`, and `system` themes remain available in `/settings`.
