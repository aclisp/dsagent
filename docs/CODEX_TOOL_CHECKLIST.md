# Codex tools comparison and DSCode improvement checklist

Recorded on 2026-10-14. This is a discussion checklist; accepted changes are recorded per item.

The goal is to understand each difference with an illustrated explanation, decide whether a change
benefits DSCode, and then implement selected improvements individually. Matching Codex is not itself
the acceptance criterion; retaining a simpler or different DSCode behavior is a valid decision.

## Source baseline

- DSCode: `/Users/homerh/Code/dscode`, commit `0f7edea` (`release: v1.3.6`).
- Codex: `/Users/homerh/Code/codex-shallow`, shallow checkout at
  `5670b1c18e861e5f89bafaff768b86ed579edd81` (2026-10-14).
- The comparison used source inspection only. Neither project was built and no tests were run.
- The Codex checkout is not established as the exact source of the installed desktop app's bundled
  `0.162.0-alpha.17.2` CLI. Claims below concern the inspected checkout.
- Codex exposes some arguments and behavior conditionally, depending on features, policy, and
  execution environment. The normal resumable command path is distinguished from its completion-only
  fallback below.

## How to work through this checklist

Every checkbox starts unchecked. Check it when its explanation and decision have been recorded,
including a decision to keep the existing behavior. Checking an item does not mean it was implemented.

For each item, use this sequence:

1. Explain the concept in plain language with a small diagram or interactive illustration.
2. Walk through the same example in Codex and DSCode, including what the user sees.
3. Explain the benefit, tradeoff, and affected CLI/Web/HTTP workflows.
4. Record the decision: **keep**, **change**, **investigate**, or **defer**, with a reason.
5. For an accepted change, record scope and acceptance checks before implementation. Record the
   implementation and validation separately after it is done.

**AP-05** (patch anchors), **EX-07** (output truncation), the failure-reporting scope of **AP-08**,
and the checkpoint-listing scope of **AP-09** have been discussed and implemented.
**EX-06** has been discussed; retain the existing 120-second default deadline.
**EX-12** has been discussed and implemented: a 64-running-job admission limit per session.
The Windows discovery and preparation scope of **EX-03** has been discussed and implemented.
Other decisions remain pending.

Decision record template:

```text
Item:
Explanation / illustration:
Decision: keep | change | investigate | defer
Reason:
Accepted scope and acceptance checks, if any:
Implementation reference and validation, if completed:
```

## apply_patch — changing files

### Execution path

```text
Codex
  ApplyPatchHandler
    -> parse and verify against the selected environment's filesystem
    -> execute_verified_patch / permission assessment
    -> ToolOrchestrator -> ApplyPatchRuntime
    -> codex_apply_patch -> executor filesystem
    -> report committed changes, including changes before a later failure

DSCode
  tool_call approval hook -> registerPatchTool.execute
    -> Workspace.initialize
    -> capturePatchCheckpoint: capture before snapshots
    -> applyWorkspacePatch: validate and calculate edits, then write files
    -> capture after snapshots -> append checkpoint to Pi session
```

- [ ] **AP-01 — How the model submits a patch.** Codex advertises a freeform tool with a Lark grammar;
  DSCode registers a function tool with an `input` string inside JSON. Both use the familiar
  `*** Begin Patch` format. Explain a raw patch versus `{ "input": "..." }`. Decide whether any
  protocol change would help DSCode's supported providers; provider support must be checked first.

- [ ] **AP-02 — Which file paths are allowed.** Codex accepts relative and absolute paths, with access
  governed by filesystem permissions. DSCode accepts only workspace-relative patch paths and checks
  lexical traversal and real paths, including symlinks. Illustrate `src/app.ts`, an absolute path,
  `../other-project/app.ts`, and a symlink pointing outside the workspace. Decide whether to retain
  confinement, improve error messages, or introduce an explicit broader scope.

- [ ] **AP-03 — Adding or moving onto an existing file.** Codex can overwrite an existing add target
  or move destination. DSCode rejects both collisions. Illustrate creating `notes.txt` when it already
  contains the user's notes. Decide whether strict collision rejection is desirable.

- [ ] **AP-04 — How forgiving line matching should be.** Codex tries exact matching, ignores trailing
  whitespace, then leading/trailing whitespace, then normalizes selected Unicode punctuation.
  DSCode tries exact matching and trailing-whitespace tolerance. Illustrate indentation, trailing
  spaces, and straight versus curly quotes. Decide which tolerance is useful and which could select
  unintended text.

- [x] **AP-05 — Function/class anchors and repeated code.** Codex uses textual `@@` anchors to advance
  to a named context before matching the old lines. At the comparison baseline, DSCode used numeric
  line hints but ignored textual anchors for hunks containing old lines. Illustrate two functions
  containing the same `return 1;` and a patch anchored to the second function. Decide whether to add
  textual-anchor matching, including behavior when an anchor is absent or ambiguous.

  **Decision (2026-10-14): change; implemented and validated.** Add textual
  anchors without changing tool descriptions, prompt guidelines, parameters, or provider protocols.
  For replacement/deletion hunks, a textual anchor must match a complete line at or after the current
  hunk cursor, ignoring only trailing whitespace. The following hunk searches strictly after that
  anchor, without fallback before it. Missing or ambiguous anchors fail before workspace writes.
  Ambiguity is checked within the remaining search region, including trailing-whitespace variants;
  EOF replacements follow the same rule. Numeric hints retain their existing fallback behavior.
  Insertion-only hunks preserve their original behavior: substring headers use the first match,
  missing headers fall back to the current cursor, and EOF insertions append regardless of the header.

  **Illustration:** with `return 1;` in both `first()` and `second()`, `@@ function second() {`
  now selects the second function. `@@ -6` still starts at line six; a header such as
  `@@ -6,1 +6,1 @@` also supplies that same numeric hint. Old/new counts and any descriptive text
  after a numeric header are not interpreted. Full standard unified diff files with `---`/`+++`
  headers remain unsupported.

  **Pi reference:** inspected `/Users/homerh/Code/pi` at `7d75a0e3e`, specifically
  [edit execution](../../pi/packages/coding-agent/src/core/tools/edit.ts) and
  [matching and duplicate rejection](../../pi/packages/coding-agent/src/core/tools/edit-diff.ts).
  Pi rejects ambiguous old-text matches and validates all replacements before writing. The new
  textual-anchor ambiguity check adopts that safeguard; existing whole-hunk matching is unchanged.
  Pi's broader Unicode normalization, mutation queue, and original-file multi-edit semantics are
  outside this change.

  **Acceptance checks and validation:** repeated code, comment/substring lookalikes, missing and
  duplicate anchors, trailing-whitespace ambiguity, indentation preservation, multiple hunks with
  changed line counts, insertion, EOF constraints, numeric/unified-style header compatibility and
  numeric fallback are covered in `test/patch.test.ts`. Four focused suites passed (104 tests):
  `patch`, `workspace`, `checkpoint`, and `checkpoint-extension`. Core `tsc --noEmit` passed.
  No build was run. Implementation: `packages/core/src/patch.ts`.

  **Compatibility review (2026-10-14):** the initial anchor enhancement unintentionally tightened
  insertion-only patches. A follow-up restores their original substring, duplicate, missing-header,
  and EOF behavior while retaining strict anchors for replacement/deletion hunks. Seven insertion
  regression cases cover those existing forms. A temporary before/after comparison against
  `0f7edea` confirmed identical file contents and result metadata for 42 legacy patch cases, covering
  bare/numeric/unified-style headers, fallback, insertion, EOF, multiple hunks, moves, additions,
  LF/CRLF, BOM, and absent final newlines. Newly interpreted replacement anchors intentionally differ
  from the former behavior that ignored them.

- [ ] **AP-06 — Line endings and final newlines.** Codex retains individual unchanged line endings,
  including mixed LF/CRLF/CR, and its update path adds a final newline to nonempty resulting lines.
  DSCode reconstructs the edited file using its first newline convention and preserves whether the
  file ended with a newline; it explicitly preserves a UTF-8 BOM. Illustrate a tiny edit in a file
  with mixed endings and a file with no final newline. Decide which unrelated formatting changes to
  avoid and which conventions to preserve.

- [ ] **AP-07 — Validation and multiple operations on one file.** Both tool paths verify patches
  before executing writes. DSCode calculates edits in a virtual staged map, allowing later operations
  to see earlier planned edits. Codex verification rejects multiple operations with the same resolved
  source path. Illustrate adding a file and then updating it inside one patch, plus a bad hunk in a
  later file. Decide whether this flexibility is useful or should be restricted.

- [x] **AP-08 — What “atomic” means when a later write fails.** DSCode validates all operations before
  writing and uses temporary-file renames for individual writes, but its multi-file write loop has no
  rollback. An I/O failure can leave earlier edits applied, and checkpoint capture does not complete
  on that failure. Codex also allows partial application, but retains a committed-change delta and
  reports it through its execution events. Illustrate file A succeeding and file B failing because
  the disk is full. Decide among accurate failure reporting, recovery records, rollback, and narrower
  wording for the existing guarantee. Include move failures and checkpoint-persistence failures.

  **Decision (2026-10-14): improve accurate failure reporting; implemented and validated.**
  Keep the existing write order, per-file writes, checkpoint flow, successful result
  format, and pre-write validation errors. During application, record each write/delete operation
  only after it completes. An application error identifies the failed operation, preserves the
  original error as its cause, lists confirmed completed operations, and states that they were not
  rolled back and later operations were not attempted. The failed operation's state is explicitly
  unverified; the report does not assume that an operation throwing means it had no effects.

  **Illustration:** when writing `first.txt` succeeds and writing `failed.txt` fails:

  ```text
  Patch application failed during write failed.txt: disk full
  File operations completed before failure:
  - write first.txt
  Completed operations were not rolled back. The failed operation's state was not verified.
  No later file operations were attempted.
  No checkpoint was created for this patch. /undo cannot restore this patch's changes.
  ```

  The tool also reports completed operations if after-snapshot capture fails. If checkpoint
  persistence throws after the in-memory checkpoint was added, it reports persistence as unconfirmed
  and accurately preserves the existing session `/undo` behavior. Error rendering uses the ordinary
  text renderer instead of assuming successful checkpoint details exist. Rollback, new recovery
  checkpoints, extra settings, and tool instruction/argument changes are outside the selected scope.

  **Acceptance checks and validation:** injected write, rename, delete, first-operation and move
  failures verify reported operations against the files actually left on disk and verify that later
  operations stop. Tool-level checks cover absent checkpoint/undo support, after-snapshot failure,
  unconfirmed persistence with session undo, validation-error compatibility, and visible error
  rendering. Four focused suites passed (119 tests): `patch`, `workspace`, `checkpoint`, and
  `checkpoint-extension`. Core and test `tsc --noEmit` passed. No build was run.
  Implementation: `packages/core/src/patch.ts` and `packages/core/src/dscode-extension.ts`;
  tests: `test/patch.test.ts` and `test/checkpoint-extension.test.ts`.

- [x] **AP-09 — Checkpoints, diffs, and undo.** DSCode saves before/after snapshots for successful
  patches in its session and offers `/diff`, `/checkpoints`, and `/undo`; undo checks for later content
  changes unless forced. Codex's inspected patch path tracks applied deltas and turn diffs, rather
  than returning a DSCode-style checkpoint ID. Illustrate undo before and after a human edits the same
  file. Decide what to preserve or improve in DSCode's recovery UX. This comparison does not claim
  that Codex has no other recovery mechanisms.

  **Decision (2026-10-15): show the last turn's checkpoints by default.** `/checkpoints` lists
  checkpoints from the last settled turn, earliest to latest, retaining the existing file labels
  and active/undone markers. `/checkpoints all` preserves the full current-branch history. A turn
  starts at the first `agent_start` and ends at `agent_settled`; another `agent_start` before
  settlement is part of the same turn. Aborted turns retain checkpoints that were already created.
  Empty turns report “No checkpoints were created in the last turn.” without falling back to older
  checkpoints. Persist the checkpoint ID list at settlement, including empty lists, and restore it
  on session load/reload and tree navigation. Older sessions without this metadata explicitly point
  to `/checkpoints all`; their turn boundaries are not guessed.

  `/undo` remains one checkpoint at a time, selecting the latest checkpoint not already undone,
  including checkpoints from earlier turns. Its confirmation, conflict checks, and `--force`
  behavior are unchanged. `/diff` and `/diff history` retain their existing selection behavior.

  **Acceptance checks:** multiple patches per turn, repeated starts before settlement, last-turn
  versus full-history ordering, empty and aborted turns, resume/reload, session/branch navigation,
  legacy metadata, argument completion, and undo across turn boundaries. Implementation:
  `packages/core/src/dscode-extension.ts`; tests: `test/checkpoint-extension.test.ts`.
  Five focused suites passed (58 tests): checkpoint extension, checkpoint snapshots, execution
  folding, and Core/Web session commands. Core and test `tsc --noEmit` passed. No build was run.

- [ ] **AP-10 — Patch permissions versus command permissions.** Codex routes patch writes through
  filesystem permission assessment and sandbox orchestration. DSCode's patch executor performs host
  filesystem writes with workspace confinement and its tool approval hook; it does not consult the
  command sandbox setting in that execution path. Illustrate a session whose commands are
  `read-only` receiving a patch request. Decide the intended meaning of read-only across tools before
  changing behavior; distinguish model-driven patching from user-requested `/undo`.

- [ ] **AP-11 — Patching through a shell command.** Codex recognizes supported `apply_patch` command
  forms, including heredocs, and routes them through its patch handler. DSCode's managed command path
  has no equivalent patch interception. Shell-created file changes do not automatically produce
  DSCode checkpoints. Illustrate a tool patch and a shell redirection that make the same edit. Decide
  whether interception is useful or whether this boundary should remain explicit.

Source entry points:

- DSCode: [tool registration and checkpoint wrapper](../packages/core/src/dscode-extension.ts),
  [patch parser and writer](../packages/core/src/patch.ts),
  [workspace path checks](../packages/core/src/workspace.ts),
  [checkpoint capture and restore](../packages/core/src/checkpoint.ts).
- Codex: [freeform schema](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/apply_patch_spec.rs),
  [handler and shell interception](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/apply_patch.rs),
  [runtime and partial-change reporting](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/runtimes/apply_patch.rs),
  [verification](/Users/homerh/Code/codex-shallow/codex-rs/apply-patch/src/invocation.rs),
  [file operations](/Users/homerh/Code/codex-shallow/codex-rs/apply-patch/src/lib.rs),
  [anchor matching](/Users/homerh/Code/codex-shallow/codex-rs/apply-patch/src/file_update.rs),
  [matching tolerance](/Users/homerh/Code/codex-shallow/codex-rs/apply-patch/src/seek_sequence.rs),
  [line endings](/Users/homerh/Code/codex-shallow/codex-rs/apply-patch/src/text_file.rs).

## exec_command — starting a command

### Execution path

```text
Codex
  ExecCommandHandler -> resolve environment, cwd, shell, and requested permissions
    -> intercept a recognized patch command, or continue with process execution
    -> UnifiedExecProcessManager -> execution policy / ToolOrchestrator
    -> UnifiedExecRuntime -> local or remote process
    -> output + session ID if still running

DSCode
  tool_call approval hook -> registerCommandTools.execute
    -> SessionAccessController.forCommand
    -> ManagedProcessRegistry.start
    -> sandboxCommand, or a recognized trusted child/vision invocation
    -> Node spawn -> output + process ID and status
    -> possibly request scoped access and retry after a sandbox boundary failure
```

- [ ] **EX-01 — The overall argument contract.** Codex offers `cmd`, `workdir`, `shell`, `login`,
  `tty`, `yield_time_ms`, `max_output_tokens`, and conditional environment/approval options. DSCode
  exposes `cmd`, `yield_time_ms`, and `timeout_ms`. Illustrate sending the same command through both
  tools. Decide which extra options solve real DSCode tasks rather than adding every option.

- [ ] **EX-02 — Where the command runs.** Codex has a per-call `workdir`, defaulting to the turn's
  directory. DSCode starts commands in the session workspace; a shell `cd` changes the directory for
  that command but does not change the patch tool's workspace root. Illustrate testing a package in a
  monorepo. Decide whether an explicit working-directory argument improves clarity.

- [x] **EX-03 — Which shell runs and whether startup files load.** Codex supports shell selection
  and a login-shell option subject to configuration and environment limits. DSCode's Unix command
  backend uses `$SHELL` or `/bin/sh` with `-lc`; Windows uses its PowerShell selection path. Illustrate
  a command that depends on shell startup setup and one that benefits from skipping it. Decide
  whether explicit shell/login controls are needed.

  **Decision (2026-10-15): improve Windows discovery and shared preparation; implemented.**
  Follow up on `498161d0` by sharing the PowerShell invocation builder between host and native
  sandbox execution. Both use the same best-effort UTF-8 output prefix, preserving an already
  prefixed script without duplication. Retain the existing host and native flag sets and the native
  backend's requirement for PowerShell 7. Keep Unix execution and tool instructions/arguments.

  Discovery prefers `DSCODE_SHELL`, then PowerShell 7 on PATH, then its standard
  `%ProgramFiles%\PowerShell\7\pwsh.exe` installation. Host execution alone may fall back to
  Windows PowerShell on PATH or under `%SystemRoot%`/`%WINDIR%`. Host overrides retain the old
  pass-through behavior: trim surrounding whitespace and leave the value unchanged for process
  creation, including bare names and relative or extensionless paths. Native sandbox overrides
  remain validated. Automatic discovery skips directories and reports a clear error if no executable
  is found. Shell discovery does not start probe processes. Microsoft Store/sandbox compatibility
  handling and new shell/login controls are outside this accepted scope.

  **Illustration:** when PowerShell 7 is installed outside PATH but Windows PowerShell is on PATH,
  DSCode now finds PowerShell 7. A native sandbox request for `Write-Output '中文'` now carries the
  same UTF-8-prefixed script as host execution, instead of bypassing that preparation.

  **References:** Codex's shared runtime preparation, duplicate-prefix check, and installation-path
  fallbacks in `codex-rs/core/src/tools/runtimes/unified_exec.rs` and
  `codex-rs/shell-command/src/{powershell,shell_detect}.rs` informed the change. The flag sets from
  DSCode's Pi alignment are preserved.

  **Acceptance checks and validation:** temporary fixture files cover discovery precedence,
  explicit overrides, PowerShell 7 and Windows PowerShell fallbacks, quoted PATH directories,
  missing executables, directory rejection, UTF-8 preparation, flag compatibility, duplicate-prefix
  prevention, and Unix invocation compatibility. The helper-request test exercises native discovery
  without an injected shell. Six focused suites passed (73 tests passed, one platform test skipped):
  shell, Windows sandbox protocol, managed process lifecycle/capacity, access integration, and
  sandbox execution. Core and test `tsc --noEmit` passed. New Windows preparation tests launch no
  subprocesses; Windows execution and actual output encoding were not exercised on this macOS host.
  No build was run. Implementation: `packages/core/src/shell.ts` and
  `packages/core/src/windows-sandbox.ts`; tests: `test/shell.test.ts` and `test/windows-sandbox.test.ts`.

  **Compatibility review (2026-10-15):** restore the original host override contract instead of
  pre-validating, resolving, or adding extensions to `DSCODE_SHELL`. Regression cases cover bare
  names, relative paths, extensionless paths, missing paths, and custom launchers. Native sandbox
  override validation and automatic discovery are retained. Per the user's decision, keep UTF-8
  prefixing on both paths without adding special handling for leading statements such as
  `using namespace`; its ordering restriction is accepted for this scope.

- [ ] **EX-04 — Pipes versus a terminal (PTY).** Codex defaults to pipes and optionally allocates a
  pseudo-terminal with `tty: true`, when enabled. DSCode uses pipes only. Illustrate an ordinary test
  command and an interactive program that detects a terminal. Decide whether DSCode needs PTY support
  and how that affects buffering, stdin, cancellation, platforms, and approvals.

- [ ] **EX-05 — Returning control while a command continues.** Both tools can yield a handle for a
  still-running command. On macOS, Codex's initial wait defaults to 10 seconds and is clamped to
  250–30,000 ms; DSCode defaults to 10 seconds and allows 0–30,000 ms. Illustrate a one-minute task
  whose first tool call returns after ten seconds. Decide whether current DSCode wait behavior is
  suitable. A yield limit is not a process runtime deadline.

- [x] **EX-06 — How long the process is allowed to run.** DSCode's deadline defaults to 120 seconds
  and survives yielding; `timeout_ms: 0` disables it, and the tool allows finite deadlines from
  1,000 to 600,000 ms. Codex's normal resumable path has no corresponding per-call deadline. When
  resumable execution is disabled by managed requirements, Codex can expose a separate completion-only
  `exec_command` with a default ten-second timeout and no resumable handle. Illustrate a slow build
  and a development server. Decide which defaults and overrides DSCode should offer.

  **Decision (2026-10-15): keep.** Retain the 120-second default to stop unexpectedly stuck
  processes. Keep the existing explicit positive deadlines and `timeout_ms: 0` opt-out for
  deliberately long-running tasks. Yielding or polling does not reset the process deadline.
  No runtime, tool argument, or instruction changes are needed.

- [x] **EX-07 — Large output and visible truncation.** Codex has bounded byte buffers and
  model-facing output-token budgets with omission notices. At the comparison baseline, DSCode
  accumulated output in a `BoundedOutput`, but returned a separate `pending` string truncated with
  `.slice(-80_000)`; the earlier text could disappear without a notice. The limit is JavaScript string
  units, not a token budget or a precise UTF-8 byte budget. Illustrate an error printed early followed
  by a flood of logs. Decide how to preserve useful beginning/end output and clearly report omissions.

  **Decision (2026-10-14): change; implemented and validated.** Use the existing
  `BoundedOutput` directly for output accumulated since the previous response and remove the duplicate
  tail-only string. Large results preserve the beginning and end with the existing explicit
  `... output truncated; tail follows ...` notice between them. After each result, replace the buffer
  with an empty one so later `write_stdin` calls return only new output and fresh truncation state.

  Keep the existing 80,000-string-unit capacity and helper's 75% beginning / 25% end allocation
  (60,000 / 20,000 units, plus the notice). Small outputs remain complete. This applies to both
  `exec_command` and `write_stdin`, including stdout, labeled stderr, and completed background results.
  The chosen rule is a bounded preview with a visible omission notice. Full-output log files,
  extra settings, token accounting, and tool instruction/argument changes are outside this scope.

  **Illustration:** an early `ERROR_EARLY`, a flood of progress lines, and a final `FINAL_STATUS`
  now produce the early error, initial logs, a truncation notice, recent logs, and the final status.
  The middle can still be omitted; preserving all logs was not selected.

  **References:** Codex's beginning/end buffer and response truncation informed the preview rule.
  Pi's [output accumulator](../../pi/packages/coding-agent/src/core/tools/output-accumulator.ts) and
  [bash output formatting](../../pi/packages/coding-agent/src/core/tools/bash.ts) were inspected;
  its full-output file mechanism was not adopted to keep this change small.

  **Acceptance checks and validation:** oversized stdout/stderr retain an early error and final
  status with a visible notice and bounded response size. Two oversized interaction windows and an
  intervening empty poll verify fresh buffers and no replay of previous output/warnings. Four focused
  suites passed: `managed-process`, `process`, `access-integration`, and `dscode-process-integration`
  (43 tests passed, one skipped). Core `tsc --noEmit` passed. No build was run.
  Implementation: `packages/core/src/managed-process.ts`; regression tests:
  `test/managed-process.test.ts`.

  **Compatibility review (2026-10-14):** additional regressions cover empty output, the internal
  beginning-buffer boundary, exactly 80,000 units, small stderr labels, and nonzero exit codes.
  A temporary before/after comparison against `0f7edea` confirmed identical complete results for
  seven command cases and one stdin/poll/EOF/cleanup sequence. Changes are limited to the preview of
  output exceeding the cap; tool arguments, instructions, result fields, deadlines, process IDs,
  final-result retention, and cleanup remain compatible. After the anchor compatibility correction,
  eight focused suites passed together (158 tests passed, one platform test skipped), and Core
  `tsc --noEmit` passed. No build was run.

- [ ] **EX-08 — Output budget, metadata, and live display.** Codex provides chunk IDs, elapsed time,
  exit/session information, and token/truncation metadata, and streams process events. Its normal
  direct model response defaults to at most 10,000 output tokens, further constrained by model
  policy; code-mode serialization has distinct budgeting behavior. DSCode returns text status and
  structured `details`, including process ID, running state, exit status, timeout and sandbox
  information; this tool does not use its `_onUpdate` callback for live output. Illustrate what the
  model sees versus what CLI/Web users see. Decide which metadata, budgets, and live output are useful.

- [ ] **EX-09 — Approvals and sandbox retries.** Codex uses execution policy, sandbox orchestration,
  and conditional command permission arguments such as justification, prefix rules, and additional
  permissions. DSCode uses `ask|auto|full`, dangerous-command detection, and scoped network/host
  approvals; it can request access and rerun after detecting a sandbox failure. Illustrate a network
  request and a command blocked from writing outside its allowed area. Decide whether DSCode needs
  more precise grants, different retry behavior, or clearer approval explanations.

- [ ] **EX-10 — Environment variables and credentials.** DSCode strips model credentials from
  ordinary command environments and adds its managed binary directory to PATH. Its recognized child
  and vision commands have separate environment construction. Codex uses shell environment policy,
  shell snapshots, and runtime/network credential handling. Illustrate a command finding an installed
  program and a child needing provider access. Before deciding changes, inspect the exact credential
  and startup-file boundary; this comparison does not establish identical isolation guarantees.

- [ ] **EX-11 — Execution environments and special children.** Codex can target local and remote
  executor environments. DSCode launches local Node processes through host/native sandbox/Docker
  wrappers and recognizes trusted direct DSCode child and vision commands. DSCode children have their
  own permissions and a one-level child-depth limit. Illustrate a normal shell command and a child
  agent command. Decide whether any wider backend work belongs in the tool or a separate architecture
  project; preserve intentional child boundaries unless explicitly revisited.

- [x] **EX-12 — Process capacity and cleanup.** Codex targets a soft cap of 64 managed sessions and
  uses a recency-based pruning policy that prefers exited processes but can terminate an older
  running process under pressure. Busy interactions can defer pruning and temporarily exceed the
  cap. At the comparison baseline, DSCode did not cap running processes. It retains at most 100
  unread completed records, removing the oldest
  completed ones first. DSCode also terminates managed children during shutdown, using process-tree
  signals/taskkill and a grace period. Illustrate starting many background jobs and closing the agent.
  Decide whether capacity limits or cleanup changes are warranted.

  **Discussion (2026-10-15):** retaining EX-06's deadline bounds the normal lifetime of each
  command, but does not bound the number running concurrently; explicit longer/disabled deadlines
  also remain available. Completed-record retention, running-process capacity, and shutdown cleanup
  are separate concerns. The current completed-record cap and process-tree shutdown cleanup already
  address the first and third concerns.

  **Decision (2026-10-15): change; implemented.** Limit each session's process registry to 64
  running jobs. This is a hard admission limit: the 65th concurrent launch is rejected before spawn,
  with instructions to inspect `/jobs`, wait, or stop a job with `write_stdin` and `terminate: true`.
  Existing running jobs are never evicted by this limit. Admission and record registration remain
  synchronous, so concurrent `start` calls cannot oversubscribe capacity. A slot is released only
  when the child closes, including after termination or spawn failure; yielding and polling do not
  release slots. Unread completed records do not count toward running capacity and retain their
  independent 100-record cap. Keep the 120-second default deadline, explicit timeout overrides,
  process-tree shutdown cleanup, tool instructions, and argument schemas. No queue or new setting
  is introduced. This supersedes ADR-0002's earlier no-running-cap decision.

  **Acceptance checks:** 64 concurrent admissions, pre-spawn rejection of the 65th, no eviction,
  per-session isolation, capacity recovery after exit/termination/spawn failure, independent
  completed-record retention, and visible error rendering without process details. Implementation:
  `packages/core/src/managed-process.ts` and `packages/core/src/dscode-extension.ts`; tests:
  `test/managed-process-capacity.test.ts` and `test/access-integration.test.ts`.
  Four focused suites passed (49 tests passed, one platform test skipped): process capacity,
  managed process lifecycle, access integration, and process helpers. Core and test `tsc --noEmit`
  passed. The capacity suite uses simulated child processes to exercise the real registry without
  launching 64 OS processes. No build was run.

Source entry points:

- DSCode: [schemas, execution, and output formatting](../packages/core/src/dscode-extension.ts),
  [process registry](../packages/core/src/managed-process.ts),
  [sandbox backends](../packages/core/src/sandbox.ts),
  [shell selection](../packages/core/src/shell.ts),
  [access grants and boundary detection](../packages/core/src/access.ts),
  [output buffer](../packages/core/src/process.ts),
  [child command handling](../packages/core/src/dscode-command.ts),
  [vision command handling](../packages/core/src/vision-command.ts).
- Codex: [tool schemas](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/shell_spec.rs),
  [handler](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs),
  [argument parsing and shell selection](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/unified_exec.rs),
  [feature-dependent registration](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/spec_plan.rs),
  [process manager](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/process_manager.rs),
  [constants](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/mod.rs),
  [execution runtime](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/runtimes/unified_exec.rs),
  [result serialization](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/context.rs),
  [completion-only execution](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/oneshot.rs).

## write_stdin — interacting with a running command

### Execution path

```text
Codex
  WriteStdinHandler -> UnifiedExecProcessManager.write_stdin
    -> locate process -> acquire per-process interaction lock
    -> review input against retained/current permissions when required
    -> PTY write, non-PTY interrupt, or empty poll
    -> drain output -> return live session or final completion

DSCode
  tool_call approval hook -> registerCommandTools.write_stdin.execute
    -> ManagedProcessRegistry.interact
    -> pipe write / close stdin / terminate process / poll
    -> wait for completion or yield limit -> drain pending output
    -> remove record once its final result has been delivered
```

- [ ] **IN-01 — What the process handle means.** Codex takes a numeric `session_id`; DSCode takes a
  string `process_id`. These are registry handles, not an interchangeable contract or necessarily OS
  process IDs. Illustrate starting a process, saving the returned handle, and following it up. Decide
  whether renaming/type alignment would help or only break callers.

- [ ] **IN-02 — When stdin is available.** Codex requires `tty: true` at launch for ordinary nonempty
  input; its non-PTY process has closed stdin, with an interrupt exception. DSCode leaves piped stdin
  open by default. Illustrate a program waiting for a line of input. Decide whether to retain piped
  input, add PTY input, or expose both explicitly.

- [ ] **IN-03 — Sending EOF.** DSCode has explicit `eof: true`, which can write final characters and
  close stdin; repeated EOF without more characters is harmless. New characters after EOF fail.
  Codex's tool has no dedicated EOF argument; a terminal's control-character behavior is distinct
  from closing a pipe. Illustrate a program that reads until EOF, such as `cat`. Decide how EOF should
  work if DSCode later supports both pipes and terminals.

- [ ] **IN-04 — Interrupting versus terminating.** Codex accepts Ctrl-C input and special-cases it as
  an interrupt for non-PTY processes. DSCode offers `terminate: true`, which stops the process tree
  with termination and force-kill fallback; writing Ctrl-C to a pipe is not a terminal interrupt.
  Illustrate asking a server to stop gracefully versus forcing it to exit. Decide whether an explicit
  interrupt operation is needed in addition to termination.

- [ ] **IN-05 — Polling and response wait times.** Codex defaults writes to 250 ms; empty polls use a
  minimum of five seconds and a configurable maximum defaulting to 300 seconds. DSCode defaults both
  writes and polls to five seconds, allows zero, and caps waits at 30 seconds. These are waits for a
  tool response, not process expiry times. Illustrate typing into an interactive program and polling a
  slow task. Decide whether separate write/poll defaults improve responsiveness.

- [ ] **IN-06 — Concurrent calls and output ownership.** Codex permits parallel command/stdin calls
  across sessions and locks interactions with one process because output is drained. DSCode registers
  all three tools as sequential for Pi's normal tool-call scheduling, but its registry has no
  equivalent per-process interaction lock. Nested code-mode scheduling needs separate verification
  before claiming all interactions are serialized. Illustrate two callers polling the same job and
  two callers polling different jobs. Decide whether locks and broader concurrency are needed.

- [ ] **IN-07 — Approving input to an already privileged process.** When its stdin-approval feature
  is enabled, Codex compares retained launch permissions with current policy and may review or reject
  new input; a changed policy cannot retrofit a running sandbox. DSCode's `ask` mode approves input,
  EOF, and termination while exempting ordinary polls; `auto` does not perform an equivalent retained
  permission check. Illustrate a process launched with extra access and later receiving another
  instruction. Decide which permission semantics DSCode should enforce.

- [ ] **IN-08 — New output, final output, and expired handles.** Both tools drain newly collected
  output rather than replaying everything on each poll. Codex reports a live session handle while
  applicable and removes finished records after collecting completion. DSCode retains unread
  completed results within its completed-record cap, then removes the record when the final result
  is delivered; later calls report an unknown process. Illustrate a job finishing between polls,
  followed by polling twice. Decide whether current retention and error explanations are sufficient.

- [ ] **IN-09 — Cancelling a tool call versus stopping its process.** DSCode distinguishes cancelling
  an active launch from cancelling a later poll/write: later cancellation can leave the yielded
  process available, and its runtime deadline still applies. Codex has different resumable and
  completion-only lifecycles, with explicit timeout/cancellation termination in completion-only mode.
  Illustrate cancelling a waiting poll versus selecting Stop on a running job. Verify Codex's complete
  resumable cancellation path before choosing parity; decide the intended DSCode lifecycle first.

Source entry points:

- DSCode: [schema and approval hook](../packages/core/src/dscode-extension.ts),
  [interaction, draining, and cleanup](../packages/core/src/managed-process.ts),
  [existing lifecycle tests](../test/managed-process.test.ts).
- Codex: [write_stdin handler](/Users/homerh/Code/codex-shallow/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs),
  [interactions and process retention](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/process_manager.rs),
  [process handles](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/process.rs),
  [retained permission review](/Users/homerh/Code/codex-shallow/codex-rs/core/src/unified_exec/stdin_approval.rs).

## Existing DSCode decisions to consult

- [ADR-0002: Web command, MCP, jobs, and checkpoint boundaries](decisions/0002-web-ui-command-mcp-and-checkpoint-boundaries.md).
  In particular: running jobs have a 64-job admission cap; only patch-tool changes create checkpoints; user-requested
  undo has its own confirmation and may restore files even when commands are read-only. Its recorded
  historical completion-read behavior should be rechecked against current code before relying on it.
- [ADR-0005: Native Pi MCP](decisions/0005-native-pi-mcp.md) for code-mode and tool integration.
- [ADR-0006: CLI child processes](decisions/0006-cli-child-processes.md) for intentional child execution
  and permission boundaries.

AP-05, EX-07, EX-12, accurate failure reporting for AP-08, checkpoint listing for AP-09, and Windows
discovery/preparation for EX-03 are the accepted implementation scopes so far.
When work resumes, refer to the item's stable ID and refresh the relevant source if a checkout has
changed.
