---
name: dscode-delegate
description: Delegate tasks to DSCode CLI child agents while continuing independent work. Use when the user requests delegation or substantial independent work benefits from a separate agent.
---

# DSCode Delegate

Launch children through `exec_command` and collect their results through `write_stdin`.
Give each child a self-contained task, relevant context, and a clear expected result;
it starts a fresh conversation. Children can edit files and run commands.

Invoke `dscode` directly with literal, quoted arguments. Do not use wrappers, pipes,
redirections, substitutions, or `cd ... && dscode ...`; these bypass the trusted launch
or are rejected. Use `dscode -C 'directory' ...` for another workspace.
Children share the workspace by default: coordinate file ownership or explicitly use
a Git worktree for overlapping edits.

CLI flags select the child's settings independently: `--provider`, `--model`, `--effort`,
`--permission`, `--sandbox`, and `--network`. Launches use the parent's existing command
approval flow. Child depth is limited to one: children cannot delegate further or bypass
that limit.

## Disposable tasks

Use print mode for tasks that need no follow-up interaction. For example, call
`exec_command` with:

```json
{"cmd":"dscode --no-session -p 'Inspect package.json and report the test command with file evidence'","yield_time_ms":0,"timeout_ms":0}
```

`timeout_ms: 0` removes the process deadline. **Print mode waits for stdin EOF before
processing the task.** Immediately call `write_stdin` with the returned `process_id`:

```json
{"process_id":"1","eof":true,"yield_time_ms":0}
```

The parent can now continue independent work. Poll with `write_stdin` using the same
ID and no `chars`; collect output regularly because the buffer is bounded. A running
process is unfinished work. Before concluding, collect all results, check exit status,
and inspect any changes. Report blocked operations or failures instead of assuming
success. Use `terminate: true` to stop an unneeded child; parent shutdown stops remaining
managed processes.

Print mode rejects operations requiring interactive approval. If the task needs approval
dialogs or follow-up interaction, read [RPC children](references/rpc.md) and use RPC mode.
