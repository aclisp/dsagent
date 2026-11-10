# ADR-0009: Scheduled tasks and IM in TUI-owned Web services

- Status: Accepted; implemented
- Date: 2026-11-10
- Supersedes the browser-only producer policy in ADR-0007, section 5
- Related: [ADR-0007](0007-tui-web-session-handoff.md), [ADR-0008](0008-wechat-channel.md)

## Scope

`/web` starts the workspace scheduler and configured WeCom/WeChat channels by default.
They belong to that TUI-owned service: `/tui` and TUI exit stop them together with HTTP.
There is no detached service. Existing runtime options, exact session/branch handoff,
network preferences, workspace URLs and browser approvals remain in use.

The TUI reminder remains advisory. Users may continue independently in the original
TUI; concurrent history can branch. Takeback loads the Web branch without merging
concurrent TUI work. Browser, IM and scheduled turns share the Web-side Session and
its busy boundary, separate from the original TUI runtime.

## Startup and faults

Startup loads WeCom from inherited `IM_WECOM_*` variables and WeChat from the same
`DSCODE_HOME` binding. It does not load a project `.env` or provide a new account editor.
An unconfigured channel remains disabled. The existing WeChat login command manages
binding; environment changes require relaunching the TUI, while a changed binding is
read on the next `/web` start.

The continuation factory restores the exact selected conversation before initializing
background services. It acquires resource ownership, prepares local Provider state,
and initializes a paused scheduler. HTTP admission and IM submission stay closed.
Built-in Providers prepare without connecting, polling, consuming inbox messages, or
emitting notices. After listening succeeds and Core rechecks TUI idleness, a synchronous
commit activates the services and opens admission. Failed startup closes the prepared
runtime and every component and releases resource ownership.

Any configured component's local initialization failure, invalid initial schedule,
or occupied resource fails the entire `/web` startup. First network authentication
is not a startup prerequisite. Initial output and `/web status` show connecting versus
connected states rather than treating initialization as proof of authentication.

After commit, authentication, connectivity and private-state faults stay isolated
to the affected channel. Existing reconnection and WeChat session-expiry pauses apply.
The TUI receives safe component notices; `/web status` reports Scheduler and IM state.
Loss of resource ownership closes the service to prevent competing consumers.
The independently deployed Server retains its Provider startup-isolation behavior,
while participating in the same ownership rules.

## Scheduling, delivery and permissions

All enabled tasks in the workspace's `.dscode/schedules.yaml` are loaded. Tasks belong
to the workspace rather than the conversation that created them, and execute in the
current Web-side Session. Overdue one-time tasks are skipped; cron resumes at its next
occurrence. Startup preparation crossing a deadline also does not trigger catch-up.
Timezone uses `TZ`, defaulting to `Asia/Shanghai`.

The existing scheduled-task guide is embedded in HTTP-hosted Agent instructions,
including installed Node and relocated standalone CLIs. Its text is checked against
the deployment skill. It preserves natural-language task management, YAML validation,
status verification, and Scheduler-owned source binding without rewriting user skills.

Browser-created tasks use `delivery: session`. IM-created tasks use `delivery: source`
and return to the originating IM conversation. There is no browser target picker.
Saved WeChat context remains subject to server acceptance and expiry.

Model, tools, permissions, sandbox and network policy come from the TUI snapshot.
Approval requests, including those originating in IM or scheduled work, wait for the
existing browser UI. No IM approval protocol is introduced.

Takeback retains ADR-0007's Agent/approval/job checks. Attachment preparation, outbound
delivery and scheduled submission retry are not new takeback blockers. Taking back
can abandon them; each Provider keeps its existing recovery semantics. No persistent
outbox or automatic replay of admitted work is added.

## Local ownership

New-version CLI and Server instances reserve the canonical scheduler workspace and
each configured IM account. Account keys do not contain credentials; lock filenames
are hashes. Coordination is independent of `DSCODE_HOME`, under a user-specific
`dscode-services-*` directory in the OS temporary directory. Processes must share
that directory for mutual exclusion, including the same temporary-directory setting.

Locks use atomic acquisition and a heartbeat (`proper-lockfile` from the existing
catalog). Live conflicts fail without stealing ownership. Normal shutdown releases
all locks; after a crash, abandoned locks become eligible for recovery after 30 seconds.
If a later acquisition fails, earlier acquisitions are released.

Different machines, users and isolated containers are separate deployments; there is
no distributed coordination. Older versions without this protocol do not participate.

## Verification

Tests cover deferred input, selected-branch restoration, strict startup rollback,
activation failure, runtime fault isolation, workspace aliases, partial-lock rollback,
cross-process exclusion, stale crash recovery, scheduling and missed occurrences.
Existing shared busy, source delivery, WeCom and WeChat recovery tests remain applicable.
The real PTY handoff smoke exercises occupied-port rollback, scheduling and embedded
instructions, the WeCom SDK against an offline protocol fixture, and exit cleanup.
Packed Node and relocated standalone verification use the same smoke.
The Bun 1.3.14 standalone adapter maps the WeChat store's small synchronous SQLite
API to `bun:sqlite`; Node continues to use `node:sqlite`. Schema and database files
remain shared. The adaptation is restricted to this consumer and the distributable
smoke initializes/reopens the store across repeated handoffs.
The pinned Bun runtime additionally reconciles schedule/status file metadata every
250 ms, supplementing directory notifications. Node retains its existing watcher.
