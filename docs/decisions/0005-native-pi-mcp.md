# ADR-0005: Native Pi MCP, codemode, and tool-search

- Status: Accepted
- Date: 2026-10-02
- Supersedes: ADR-0002 section 2

DSCode uses Pi 1.0.4's public extension factories in CLI and HTTP sessions.
Pi owns MCP configuration, validation, discovery, server management, OAuth,
reconnection, tool naming, `/mcp`, and the `dscode mcp` CLI. DSCode's MCP manager,
configuration schema are removed. DSCode owns approval UI and session grants through
its existing tool-call hook, using Pi's public tool metadata.
There is no compatibility layer or migration.

Global MCP config is `DSCODE_HOME/mcp.json`. Trusted projects use `.pi/mcp.json`.
Pi exposes no public project MCP directory setting; DSCode does not override it.
Native configuration uses `enabled: false` and `exposure: codemode|deferred|direct|hidden`.
The default exposure is codemode.

Defaults are `read`, `exec_command`, `write_stdin`, `apply_patch`, and `codemode`.
Codemode's `searchTools()` and `describeTool()` discover tools without activating
additional model-facing declarations, preserving the request prefix during discovery.
The native tool-search extension remains registered; `tool_search` is opt-in through
`--tools` or server `exposure: "deferred"`, which activates it automatically.
Codemode runs in normal `on` mode with `models: false`. Nested tool
calls retain general DSCode approvals, command sandboxing, and patch checkpoints.
`apply_patch` uses its ordinary schema with an `input` string for every provider.
DeepSeek declares `supportsOpenAIGrammarTools: false`, so Pi automatically uses
function codemode with a `code` string. Other providers retain Pi's native sampling
behavior. No tool rewriting or model-change hooks are needed.
Server-defined MCP tools require approval in `ask`/`auto`. The dialog displays the
server namespace, tool, description, arguments, and the server's `readOnlyHint`
(true, false, or not provided). This unverified hint informs the decision; it never
grants permission automatically. Users may allow once, allow one tool for this
session, allow every tool from that server for this session, or deny. Session grants
cover future arguments and are keyed by Pi's tool names and namespace metadata,
including calls nested in codemode. Queued calls recheck newly granted scopes.
`/permissions` lists grants; `/permissions revoke-mcp <tool-or-server-namespace|all>`
revokes them. Revoking a server namespace also clears individual grants for its tools.
Grants are held in memory and reset on new/resumed/forked sessions, reload, and shutdown;
pending approvals cannot grant access after a reset or revocation. The standard
`list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` helpers
are read-only and skip approval in every mode. Approval dialogs
are serialized because scripts can launch concurrent calls. No-tools runs and
investigation children suppress native extensions before loading; no-MCP runs
suppress the MCP extension. Children remain limited to read/search tools.

The MCP CLI dispatches to Pi before DSCode's model parser and authentication.
A small, version-pinned guard on Pi's public StdioTransport start method removes
inherited model credentials and retains explicit server env values. This covers
both extension sessions and Pi's separate MCP CLI without copying its transport,
env resolver, or command parser. The guard resolves Pi's actual dependency instance
when npm installs a separate copy.

HTTP SSE retains nested parent IDs. History retains Pi's bounded nested-call records,
and session pruning retains script-store entries on the active branch. DSCode sets
the initial tool selection and restores Pi transcript declarations through public
APIs; tools discovered asynchronously are activated once registered. Reload keeps
Pi's current selection.

Node bundles emit Pi's codemode worker and resolve QuickJS from installed dependencies.
Standalone builds embed that worker and QuickJS WASM. Tests use isolated homes and
local mock providers/MCP servers, covering execution, approvals, checkpoints,
credential filtering, disabling, reload/resume, history, and relocated artifacts.
