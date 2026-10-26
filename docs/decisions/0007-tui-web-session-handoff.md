# ADR-0007: Manual session handoff between TUI and Web

- Status: Accepted; implementation pending
- Date: 2026-10-26
- Related: [ADR-0002](0002-web-ui-command-mcp-and-checkpoint-boundaries.md),
  [ADR-0003](0003-standalone-cli.md), and
  [ADR-0005](0005-native-pi-mcp.md)

## Context

A user working in the DSCode TUI needs to leave their MacBook, continue the same
work from a phone browser, and return to the TUI later. The TUI may run locally or
on a cloud host reached through SSH. The phone may connect over the local network
or through a public HTTPS endpoint.

This workflow needs sequential continuation of saved conversation history. It does
not require two interfaces to share a live AgentSession, streaming output, or
approval dialogs.

Prioritize a small, understandable, maintainable implementation for personal use.
Reuse existing runtime options, session-resume, and Web UI behavior for the normal
workflow. Handle unusual failures with clear errors and existing recovery commands.

The existing Web UI can resume a persisted workspace session. Its selection rule
prefers a session already active in the Web server; otherwise, it offers the most
recently modified persisted session. An active Web runtime does not continuously
reload changes written by a separate TUI runtime. The TUI has the same limitation.
Resuming the same file in two runtimes therefore preserves both sets of messages,
but continuing from stale in-memory history can create separate branches.

The handoff commands must explicitly load the intended session at each transition.
Choosing the workspace's most recently modified file is not a reliable substitute.

## Decision

### 1. Commands and ownership

Provide these TUI commands:

| Command | Behavior |
| --- | --- |
| `/web [--host <address>] [--port <port>] [--url <origin>]` | Start Web with the current TUI's runtime parameters and conversation. Display the private browser URL and a QR code. |
| `/tui` | Stop Web and resume its current conversation while keeping the TUI's own current runtime parameters. |
| `/web status` | Show whether the service is running and, when running, its browser URL. |

Use `/web` and `/tui` rather than `/handoff`, which is easily confused with the
existing `/skill:handoff` command. These commands control the TUI-launched service;
they are not a new standalone deployment-management interface.

The TUI process owns one Web continuation service at a time. The service runs on
the same host and uses the same workspace directory, DSCode home, and session
storage as the TUI. It uses a separate agent runtime that resumes persisted
history, rather than sharing the TUI's live AgentSession.

The service's lifetime ends with the owning TUI process. There is no detached
daemon or mechanism for a newly started TUI to adopt an orphaned service. For SSH
use, keep the TUI process alive through a persistent terminal session such as
`tmux`. Disconnecting SSH is acceptable if the TUI process survives.

Closing or backgrounding the phone browser does not take the session back into
the TUI. The user explicitly runs `/tui` when ready to return.

### 2. Handoff eligibility and session identity

Both directions require the affected agent runtimes to be idle. Active model
generation, tool execution, pending approval, retry, compaction, branch summary,
or queued continuation prevents handoff. Running managed background commands,
including commands still marked running by `/jobs`, also prevent handoff.

Reject a busy handoff immediately with an explanation. Do not automatically wait,
queue the handoff, interrupt a turn, or terminate background commands. The user
finishes or manually stops that work and retries the command. MCP transport
processes and the Web service itself are not managed background command jobs for
this check.

On `/web`, for a conversation that has been saved, capture its session identity
and branch position (`sessionId` and `leafId`, including a null root position).
Resume that exact position in Web. Do not select a different session or branch just because it was
written more recently. A TUI session that is actually non-persistent cannot be
handed off; report this without silently creating a transcript or changing the
user's history policy.

Web retains its existing conversation commands. In particular, `/clear` may
create a new session and `/reload` may rebuild the current Web runtime. On normal
`/tui`, read the running Web service's current session identity and branch position
and resume that position, even if its session ID differs from the original TUI
session. Capture positions at handoff boundaries; no continuous recovery record
is required.

If an empty persistent session has no saved conversation, use the receiving
runtime's existing new-session flow. Its empty-session ID need not be preserved.
This applies in either direction, including taking back immediately after Web
`/clear` and before sending a message.

For saved conversations, use the source runtime's actual session and branch,
rather than the workspace's newest file or the transcript's last-written entry.
Those may have been changed by another TUI runtime.

### 3. Advisory reminders, without locking the TUI

After a successful `/web`, keep a visible reminder above the TUI editor or in its
status area. Its meaning is:

> Web continuation is active. Run /tui before continuing here.

The reminder is advisory. Keep ordinary TUI input and commands available; do not
block submissions, automatically take back the session, or silently discard input.
The user is responsible for using `/tui` before continuing work in the TUI.

Consequently, this feature does not enforce exclusive access or promise a single
linear conversation if the user continues in both runtimes. Messages submitted in
the old TUI can follow its stale branch. Returning through `/tui` loads the Web
session at its recorded branch position; it does not merge concurrent branches
or work done in another TUI session. Existing tree navigation remains available
for inspecting those histories.

### 4. Copy current runtime parameters to Web only

When `/web` starts a service, read the TUI's current runtime parameters and pass
them to Web through DSCode's existing runtime-option structure. This includes
the selected provider/model, Thinking level, API endpoint and transport,
permission mode, sandbox configuration, network policy, and active tools and
restrictions such as no-tools and no-MCP. Use values currently in effect,
including changes made after TUI startup, rather than blindly reusing startup
arguments or the standalone Web Server's defaults. Explicitly supplied current
values take precedence over settings restored from the conversation.

This is a one-time copy when starting Web. Each runtime can subsequently change
its own settings. There is no live settings synchronization.

On `/tui`, load the Web conversation and branch while preserving the TUI's own
current runtime parameters. Web-side settings changes are not imported back.
If the existing resume/new-session flow rebuilds the TUI runtime, carry its
current parameters across that replacement: saved model, Thinking, or tool
metadata in Web history must not overwrite them. Changes explicitly made in the
TUI while Web is active remain the TUI's own current settings; do not revert them
to the values used when Web started.

Keep this implementation to a copy of the runtime parameters DSCode already
supports. Reuse existing session-resume/new-session flows with those parameters;
do not clone agent internals, record a settings-change log, or roll back global
configuration. Use normal credential resolution. Temporary command and MCP
approval grants retain their existing lifetime/reset rules and are not copied
as runtime parameters.

### 5. Browser continuation mode

Reuse the existing Web chat, browser approval UI, file uploads, and file previews.
The TUI-launched service runs in a continuation mode with scheduled-task execution
and IM/WeCom bindings disabled. Their configuration must not implicitly start
those producers when the user runs `/web`.

The existing independently deployed Web Server retains its current behavior and
configuration. This ADR adds a distinct startup mode for TUI continuation; it does
not remove scheduled tasks or provider bindings from normal server deployments.

### 6. Networking and persistent preferences

For a fresh user configuration, default to `127.0.0.1:8899`. An external listen
address, including `0.0.0.0` or an address assigned to a host interface, requires
explicit configuration. Do not change the default merely because SSH is detected.

Keep the bind address separate from the browser-facing origin. A cloud public IP
may be mapped to a private interface, and an HTTPS reverse proxy may listen on a
different host or port. `--host` and `--port` control the HTTP listener; `--url`
specifies the origin used to construct the browser link and QR code. It does not
configure a proxy, certificate, firewall, or cloud security group.

Examples below are alternative setups, not commands to run successively:

```text
# Fresh configuration: browser on the same host
/web

# Phone on the same LAN; replace the example address with the Mac's LAN address
/web --host 0.0.0.0 --port 8899 --url http://192.168.1.20:8899

# Cloud TUI with a separately configured HTTPS reverse proxy on the same host
/web --host 127.0.0.1 --port 8899 --url https://agent.example.com
```

Use the explicit or saved `url` as the browser origin. If no `url` is configured,
construct an HTTP origin from a concrete bind address and port. Wildcard bind
addresses such as `0.0.0.0` and `::` require an explicit or saved `url`; report a
missing origin before starting the service. Do not enumerate network interfaces
or try to discover a public address.

Persist the last successfully activated `host`, `port`, and optional `url` in
DSCode's user configuration, using the existing `getDSCodeSettingsPath()`
resolution: `DSCODE_CONFIG_PATH`, or `DSCODE_HOME/config.json` by default. Add a
`web` namespace, for example:

```json
{
  "web": {
    "host": "127.0.0.1",
    "port": 8899,
    "url": "https://agent.example.com"
  }
}
```

Explicit command arguments override saved preferences; saved preferences override
fresh defaults. A previously saved external bind address is therefore reused by
`/web` on later TUI starts. Update only these preferences, preserving unrelated
configuration through the existing atomic settings-write approach. Validate the
configuration before startup, then attempt to save preferences after the service
starts successfully. If saving fails, keep the service running and show a warning
that these preferences were not saved. Preference persistence is not a condition
for successful handoff.

Persist only the browser origin, not a generated private chat URL or access
credential. Runtime settings are not network preferences and must not be written
into this namespace.

### 7. HTTPS and access credentials

This feature is a temporary browser entry for one person's own workspace. Reuse
the existing Web UI workspace-secret URL scheme and access behavior.

For each handoff, generate a random workspace ID and display its private URL and
QR code after startup succeeds. Keep the ID in memory. `/tui` closes the listener
and active browser connections; the next handoff uses a new workspace ID. Keep
generated private URLs out of persistent preferences and model history.

The service provides HTTP. Any HTTPS endpoint is supplied by an externally
configured reverse proxy, with its origin passed through `--url`.

Access protection stays at the existing Web UI level. Rotating the page URL does
not promise revocation of known session IDs across later handoffs.

### 8. Transition and failure behavior

`/web` succeeds after preflight, session activation, and listener startup. Resume
the selected session/branch or use the normal new-session flow for an empty
conversation, as described above. On startup failure, clean up partial service
resources, leave the TUI usable, and show the error. Do not display a successful
handoff reminder or QR code for a failed start.

Repeating `/web` while its service is running displays the existing private URL
and running state without creating a second runtime, rotating its workspace ID,
or synchronizing later TUI settings changes.
Changing an active service's network parameters requires taking it back with
`/tui` first. A port collision is an error, not a
reason to attach to an unrelated server or silently choose another port.
Status queries and a repeated `/web` that only displays an active service remain
available while work is running; idle checks apply to actual handoff transitions.

For `/tui`, serialize the transition with Web request admission so another Web
turn cannot start between the idle check and shutdown. If either affected runtime
is busy or has managed jobs, reject the command without stopping the service.
Otherwise, capture the current Web session identity and branch position, stop
the service, finish its normal cleanup and transcript writes, then resume that
conversation through the normal TUI session-resume flow, preserving the TUI's own
current runtime parameters as described in section 4. For an empty conversation,
use the normal new-session flow with those same parameters. Clear the reminder
after successful takeback.

If the service stops unexpectedly while the TUI remains alive, clear its active
reminder, report that it has stopped, and direct the user to `/resume` to recover
saved work. Do not automatically reload the TUI or maintain a dedicated
crash-recovery target or settings snapshot. Failed resumption during takeback
uses the existing session-resume error handling and recovery workflow. With no
running service, `/tui` reports that Web is not running.

Normal TUI shutdown also shuts down its service. Process termination uses ordinary
abort and cleanup behavior; it is not a successful graceful takeback. The idle-only
handoff rule must not prevent the user from exiting the TUI.

Honor existing operating-system power settings. DSCode does not change sleep
policy or install a sleep inhibitor. When the host sleeps, browser access can be
interrupted; waking and reconnecting must not by itself replay a submitted turn.

### 9. Distribution coverage

Ship the feature in both the Node CLI and the existing supported standalone
distributions. Include the HTTP dependencies, Web pages, scripts, styles, and QR
code support in the appropriate artifacts. Installation must not depend on a
source checkout or a separately installed Web UI package.

Standalone delivery continues to follow ADR-0003's embedded-asset and
single-executable requirements. Loading this feature should be deferred until it
is used so ordinary TUI startup does not eagerly initialize an HTTP server.

## Implementation boundaries

| Area | Responsibility |
| --- | --- |
| `packages/core/src/cli-runtime.ts` and TUI command registration | Own the service controller across session replacements, implement commands and reminders, read current runtime parameters for Web, and preserve the TUI's own parameters when resuming Web history. |
| `packages/core/src/managed-process.ts` | Expose the existing running-job state for handoff preflight. Keep service ownership separate from agent command jobs. |
| `packages/core/src/settings.ts` | Validate and persist the `web` preferences through the existing user configuration path; report save failures as warnings. |
| `packages/http-adapter` | Resume explicit session/branch positions with supplied runtime parameters, expose busy/job state and the actual active position, and serialize takeback with request admission. |
| `packages/web-ui` | Provide continuation-mode composition with browser chat, approvals, and files, while skipping scheduler and IM startup. Reuse existing workspace-secret URLs and browser access behavior. |
| CLI bundles and `standalone/` | Package dependencies and assets, retain lazy startup, and verify installed/relocated execution. |

Keep dependency direction explicit: Web and HTTP packages already depend on Core.
Compose or inject the service implementation at the CLI host boundary rather than
adding a Core-to-Web package dependency cycle. Prefer Pi's public command and
session-replacement APIs, referring to the pinned source in `../pi` during
implementation. Sharing a live TUI AgentSession or adding a dual-UI approval broker
is not required by this decision.

## Acceptance criteria

1. TUI history, Web messages and tool results, and resumed TUI history form one
   continued branch when the user follows the handoff workflow, including after
   navigating to an earlier branch before `/web`. Neither a workspace's latest
   session nor a transcript's last-written entry overrides the tracked position.
2. Actual handoff transitions reject active turns, approvals, retries/compaction,
   queued work, and running managed commands without interrupting work. A rejected
   takeback leaves the Web service usable; read-only status operations still work.
3. The TUI reminder persists while Web is active, but ordinary TUI submissions and
   commands remain available. Concurrent use may branch; the implementation must
   not claim to merge or synchronize those in-memory histories.
4. Changes to the TUI's model, Thinking, permission, sandbox/network policy, and
   tool selection made after startup are reflected when `/web` starts. After
   Web-side changes, `/tui` resumes the conversation while retaining the TUI's
   own current parameters, including any changes made locally in the TUI. Saved
   Web settings metadata must not override them. Transient approvals retain their
   existing lifetime/reset semantics.
5. After Web `/reload` or `/clear`, normal takeback uses Web's actual current
   conversation. A newly cleared, unsaved conversation uses the receiving runtime's
   normal new-session flow; preserving its empty-session ID is not required.
6. Continuation mode provides browser approvals and files without starting the
   scheduler or IM providers. Normal server deployments retain those features.
7. Network defaults, explicit overrides, saved preferences, and browser origins
   work as documented. Wildcard bind addresses require `url`. Unrelated keys
   survive configuration updates; a failed preference save produces a warning
   while the running service remains usable.
8. Each handoff generates a fresh private workspace URL. Taking back closes the
   listener and active browser connections. Private URLs are kept out of user
   configuration and model history; access follows existing Web UI behavior.
9. Repeated `/web` is idempotent; status shows running/stopped and the browser URL.
   Startup failures leave the TUI usable. Service crashes or failed resumption
   produce clear errors and point to `/resume` for manual recovery. Browser
   disconnect/reconnect does not resubmit a turn.
10. TUI exit closes the owned listener. SSH disconnection with a surviving TUI does
    not stop it. Non-persistent sessions are rejected without creating history.
11. Installed Node artifacts and relocated standalone executables can start and
    stop continuation, serve their embedded/packaged assets, and resume sessions
    without the source tree. Use isolated homes and local mock providers for
    automated verification.

These criteria describe required implementation validation. This ADR itself does
not indicate that the commands have been implemented or that those checks have
already passed.
