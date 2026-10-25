---
name: dscode-delegate
description: Delegate tasks to DSCode CLI child agents while continuing independent work. Use when the user requests delegation or substantial independent work benefits from a separate agent.
---

# DSCode Delegate

Start DSCode CLI child agents with `exec_command` and collect their output with
`write_stdin`. Each child starts a fresh conversation, so provide its task, relevant
context, and expected result. Children can edit files and run commands.

Use print mode for a single task. For approval dialogs or follow-up prompts, read
[RPC children](references/rpc.md) and use RPC mode.

Keep `cmd` a direct `dscode ...` invocation with literal, quoted arguments. Use
`dscode -C 'directory' ...` to select another workspace. Children share the parent's
workspace by default; coordinate file ownership or use Git worktrees for overlapping
edits. Managed delegation supports one child level.

Children use their own CLI settings. Select the provider, model, effort, permissions,
sandbox, and network access with `--provider`, `--model`, `--effort`, `--permission`,
`--sandbox`, and `--network`. The parent's command approval flow applies to the launch.

## Launch a task

For a disposable task, call `exec_command` with:

```json
{"cmd":"dscode --no-session -p 'Inspect package.json and report the test command with file evidence'","yield_time_ms":0,"timeout_ms":0}
```

`yield_time_ms: 0` returns control promptly so the parent can continue other work.
`timeout_ms: 0` lets the task run until it finishes or is stopped.

To supply additional context through stdin, set `stdin_open: true` at launch, send
`chars` through `write_stdin`, then send `eof: true` to finish input and start the task.

## Collect results

If `exec_command` reports that the child is still running, use the `process_id` from
its result to poll. For example, if the returned ID is `1`, call `write_stdin` with
these arguments:

```json
{"process_id":"1"}
```

Poll regularly to drain the bounded output buffer. Collect the final output, check the
exit status, and inspect changes before completing the parent task; parent shutdown
terminates remaining children. Use `write_stdin` with `terminate: true` to stop an
unneeded child.
