# Dangerous command classification

In auto mode, `dangerous` triggers destructive-command approval. Other command
classifications do not trigger that approval; sandbox and network controls are
separate. This detector is a small heuristic, not a guarantee of safe execution.

`git rm` is flagged when forced (`-f`/`--force`, including combined short flags),
except for dry runs (`-n`/`--dry-run`) or index-only removal (`--cached`). Plain
`git rm` is not flagged by this rule. Like forced checkout/reset rules, this
checks the operation's capability, without querying whether local changes exist.

Rules inspect literal command names and selected arguments, including common
`env`, `command`, `xargs`, `nice`, `timeout`, and `nohup` forms. `sudo` and
`doas` parse common privilege options and recursively inspect the wrapped
command. Rules also inspect `find -exec/-execdir`, literal `eval` arguments
(joined with spaces), and literal `sh/bash/dash/zsh/ksh -c` payloads. Recursive
inspection is limited to four levels. Unknown wrapper options are not guessed.
Tests pair destructive commands with informational or harmless forms to limit
false positives.

The terminal destructive-command confirmation keeps the command in a bounded,
scrollable view and shows a concise intent summary with the choices. `intent` is
derived from the matched rule; it does not claim to know dynamic command effects.
`reason` remains the rule explanation shown by generic confirmation flows.

## Focused server rules

- `rsync`: destination-deletion options (`--delete`, `--del`, `--delete-before`,
  `--delete-during`, `--delete-delay`, `--delete-after`, `--delete-excluded`,
  `--delete-missing-args`) and `--remove-source-files`. Literal `-n`/`--dry-run`,
  `--list-only`, help and version invocations are exempt. Ordinary synchronization
  remains outside this rule even though it can overwrite destination files.
- `docker` / `docker-compose`: Compose `down -v/--volumes`; Docker `volume rm`
  and `volume/system/container/image/builder prune`. Compose dry runs and help
  are exempt. Common Docker context/host and Compose project/file options are
  understood. Plain `compose down` and other Docker operations are not covered.
- `systemctl`: `stop`, `restart`, `try-restart`, `reload-or-restart`,
  `reload-or-try-restart`, `kill`, `disable`, `mask`, `isolate`, `halt`, `poweroff`,
  `reboot`, `kexec`, `soft-reboot`, `rescue`, and `emergency`. Queries, `start`, and
  `daemon-reload` are not flagged. `--dry-run` only exempts the recognized verbs
  that support it: `halt`, `poweroff`, `reboot`, `kexec`, `rescue`, `emergency`.
  In particular it does not exempt `stop` or `restart`.
- `git worktree remove -f/--force` (including `-ff`) can discard uncommitted
  files. Plain removal, `list`, and `prune` are outside this rule.
- `unlink` is a command-name risk, like `rm`.

New parameter-sensitive rules accept a bounded set of options. The shared option
scanner consumes known option values, respects `--`, supports combined short
flags and attached values, and handles Docker boolean `=true/false` in order.
Unknown options or missing values leave these invocations unclassified. Values
such as `--exclude --dry-run` do not count as dry-run flags. No path existence,
permissions, service status, Docker configuration, or environment is queried.

Option semantics are based on the [rsync manual](https://download.samba.org/pub/rsync/rsync.1),
[Docker Compose](https://docs.docker.com/reference/cli/docker/compose/),
[Docker volume commands](https://docs.docker.com/reference/cli/docker/volume/rm/),
[systemctl documentation](https://github.com/systemd/systemd/blob/main/man/systemctl.xml),
and [Git worktree documentation](https://git-scm.com/docs/git-worktree).

## Limited control structures

Literal commands in `if/then/elif/else/fi`, `for/do/done`, `while`/`until` loops,
and brace groups are inspected with the same rules as top-level commands.
Conditions and every branch are checked; their truth or reachability is not
evaluated. Quoted/escaped words are not control keywords. A `for` iteration list
and the contents of a literal `[[ ... ]]` test are data, not command positions.
This covers `if test -d build; then rm -rf build; fi` without flagging
`echo then rm file` or `for f in rm file; do echo "$f"; done`.

This is limited structural context, not a shell grammar validator. `case`,
`select`, the `function` keyword, `name()` function declarations, and arithmetic
`((...))` stop scanning.
Substitutions and heredocs still stop the scan, including any later commands;
no attempt is made to find a recovery point or evaluate a dynamic loop list.

## Code organization

- `packages/core/src/dangerous-command.ts`: public result, command dispatch,
  recursion limit, command-name risks, and recursive `find`/wrapper inspection.
- `dangerous-command/shell.ts`: literal tokenization, quote information,
  limited control context, and complete versus partial command evidence.
- `dangerous-command/wrappers.ts`: the existing bounded wrapper/shell option scans.
- `dangerous-command/git.ts` and `server.ts`: command-specific risk rules.
- `dangerous-command/options.ts`: known-option scanning for the new rules.
- `dangerous-command/match.ts`: shared reason/intent and elevation formatting.

Approval policy and UI remain outside these modules. Add new effects to the
relevant rule module, not the shell scanner. Add wrappers to wrapper parsing,
not each individual command rule. Every new rule needs dangerous and harmless
examples, especially option values, help, dry-run, and `--` boundaries. Pure
classification tests never execute their command strings; extension tests verify
that matches still require approval in auto mode with unrestricted host access.

## Deliberate limits

- Pipeline output and stdin are not traced into interpreters (`printf ... | sh`,
  managed-process input). This requires data-flow or session analysis.
- Variable expansion, command substitution, backticks, process substitution and
  heredoc bodies are not evaluated. If unsupported syntax interrupts a command,
  already identified command-name risks such as `rm` are retained. Incomplete
  parameter-sensitive commands are not classified from a prefix: later arguments
  might change the decision, such as `git clean ... -n`.
- Python/Node code, script files, shell aliases/functions and dynamically assembled
  commands are not interpreted. Literal shell `-c` is a bounded exception that
  reuses existing rules, not a general interpreter.
- `env -S` and unsupported wrapper option variants remain out of scope. Their
  splitting/option semantics require additional parsing; common forms take priority.
- `setsid` and `stdbuf` wrappers remain unsupported: extending the option matrix
  has lower priority than the common forms above. Shell option scanning supports
  selected short flags, separate `-o` values (including `-euo pipefail`), and Bash
  `--login`, `--noprofile`, `--norc`, and `--posix`; other options are not guessed.
  Dynamic `eval` payloads are not expanded. These are bounded literal-command
  checks, not full shell compatibility.
- The `exec` shell builtin is not inspected as a command wrapper. `ash -c` is not
  among the shells whose literal command payload is recursively checked. Both are
  uncommon in agent commands and supporting them would broaden shell handling.
- `time` and `watch` are not recognized wrappers. Their option and repeated-execution
  semantics add parsing complexity for uncommon forms.
- Git worktree operations other than forced removal remain outside the focused
  Git rules. Git checkout's ambiguous branch-versus-path forms are not resolved.
- `find -fprint`, `-fprintf`, and `-fls` can overwrite output files; these narrow
  actions are not currently classified. The find rules focus on deletion via
  `-delete` and destructive commands passed to `-exec`/`-execdir`.
- `dd` is flagged for an explicit nonempty `of=` other than `/dev/null`. The rule
  does not resolve paths, symlinks, determine whether a file already exists, or
  infer an output supplied by shell redirection. `shred` is a command-name risk.
- No general shell AST, complete command catalog, or filesystem-state analysis is
  attempted. Future classification can replace or supplement the detector without
  changing auto-mode approval policy.

A negative result means only that no supported rule matched. These limits are
intentional tradeoffs to keep the implementation small ahead of LLM classification.
