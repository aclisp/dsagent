# ADR-0004: Remove structured planning and simplify child agents

- Status: Accepted; child-agent decision superseded by [ADR-0006](0006-cli-child-processes.md)
- Date: 2026-10-02
- Supersedes: The planning and role/worktree delegation portions of ADR-0002 and ADR-0003

## Decision

Daily DSCode use does not need a separate planning workflow or role-based parallel
agents. Remove the planning permission, command, tool, state, widgets, prompts, and
execution/refinement dialogs. Permissions remain `ask`, `auto`, and `full`; command
sandbox choices remain independent. No migration or historical-plan support is added.

Retain opt-in CLI `delegate` with a single required `task` string. Each call waits
for one child process in the current workspace. The child has a fresh conversation,
no saved session, and the parent's current model and thinking level. Its tools are
fixed to `read`, `grep`, `find`, and `ls`; MCP, commands, patches, and nested delegation
are unavailable. User extensions and command hooks are disabled in children. Roles,
task batches, concurrency queues, automatic worktrees, diff collection, and `/agents`
are removed. The parent owns edits and verification.

Children relaunch the CLI with Node or the standalone executable. Preserve model
credentials for this agent process, final assistant/provider-error extraction,
bounded output, cancellation, and a two-minute timeout. Cancelled or timed-out
children receive termination followed by forced termination if needed.

HTTP hosts do not register or permit selecting `delegate`; no process-wide depth
mutation is needed to disable it. Default tools remain
`read,exec_command,write_stdin,apply_patch`.

## Consequences

Independent source investigation remains available without write coordination,
checkpoint transfer, role routing, or background child-session management. Children
cannot run tests or commands; the parent performs those tasks. One child per call
keeps execution and result handling predictable.
