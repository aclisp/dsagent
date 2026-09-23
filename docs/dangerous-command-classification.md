# Dangerous command classification

In auto mode, `dangerous` triggers destructive-command approval. Other command
classifications do not trigger that approval; sandbox and network controls are
separate. This detector is a small heuristic, not a guarantee of safe execution.

`git rm` is flagged when forced (`-f`/`--force`, including combined short flags),
except for dry runs (`-n`/`--dry-run`) or index-only removal (`--cached`). Plain
`git rm` is not flagged by this rule. Like forced checkout/reset rules, this
checks the operation's capability, without querying whether local changes exist.

Rules inspect literal command names and selected arguments, including common
`env`, `command`, `xargs`, `nice`, `timeout`, and `nohup` forms, `find -exec/-execdir`,
literal `eval` arguments (joined with spaces), and literal
`sh/bash/dash/zsh/ksh -c` payloads. Recursive inspection is limited to four
levels. Unknown wrapper options are not guessed. Tests pair destructive commands
with informational or harmless forms to limit false positives.

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
- Git worktree operations are not classified by their effects. In particular,
  `git worktree remove --force` can delete a worktree directory, including
  untracked files, but worktree subcommands remain outside the focused Git rules.
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
