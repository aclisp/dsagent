# ADR-0006: Replace delegate with ordinary CLI child processes

- Status: Accepted
- Date: 2026-10-06
- Supersedes: The child-agent decision in ADR-0004

## Decision

Remove the dedicated `delegate` tool and investigation-only child mode. Launch normal
DSCode CLI processes through `exec_command`, using the trusted literal-command and
fixed-executable handling shared with `dscode-vision`. Preserve model credentials for
the fixed CLI executable; ordinary shell commands retain credential stripping.

Keep delegation instructions in the discoverable `dscode-delegate` skill, following the
`dscode-vision` skill pattern. Core tool prompts and the engineering contract retain their
original guidance. This feature must not add or change core system-prompt content,
including `promptSnippet`, `promptGuidelines`, and `engineeringInstructions`. Delegation
guidance belongs solely in the skill; Pi's existing skill-discovery behavior is unchanged.
Docker seeds the skill through the existing default-skills mechanism;
ordinary CLI and standalone users install the skill directory manually. RPC guidance is
loaded from a skill reference only when needed.

Children use their own CLI model, thinking, permission, sandbox, and network settings
and ordinary defaults. There is no parent permission ceiling or additional approval
flow. Model requests work independently of the parent's shell-network setting. The
parent's normal approval for launching a command still applies. External container
and OS restrictions continue to apply.
Classify DSCode agent launches as dangerous commands because child permissions are
independent. Parent `auto` mode requires its existing command approval; `full` mode
allows the launch. Standalone help and version commands are exempt.

Use the existing managed-process registry for output, cancellation, termination,
background execution, and session cleanup. `timeout_ms: 0` disables the deadline for
any managed process; omitted and positive values retain their existing semantics.
The parent yields immediately, performs independent work, and collects results before
concluding. Shared workspace edits need coordination; create worktrees explicitly.

Print-mode children read stdin until EOF. Send EOF immediately after launching a task;
stdin may carry additional context first. Print mode rejects approval-dependent
operations. RPC children keep stdin open and exchange existing JSONL prompt and UI
records. The parent obtains the user's decision and responds explicitly; no automatic
approval bridge is added. Collect final output after `agent_settled`, then close RPC
stdin. Recommend `--no-session` for disposable tasks without forcing it.

## Consequences

CLI and Web/HTTP use the same process tools. Children can edit, test, use MCP and
extensions where supported by the distribution, and run ordinary processes. Managed
DSCode children retain the original `delegate` depth limit of one: a root can launch
multiple children, but children cannot launch grandchildren through `exec_command`,
regardless of their permission flags. The trusted launch sets `DSCODE_SUBAGENT_DEPTH=1`;
the process manager checks this marker before launching another DSCode child. This is
a managed-launch limit, not an OS security boundary against arbitrary code that clears
the marker or invokes the CLI through a wrapper. There
is no agent-specific queue, role configuration, or automatic worktree
management. Hosts must ship a CLI entrypoint; standalone children relaunch the same
binary. The Docker image includes the bundled CLI.
