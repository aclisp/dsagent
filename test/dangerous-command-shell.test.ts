import { describe, expect, it } from "vitest";
import { detectDangerousCommand } from "../packages/core/src/dangerous-command.js";
import { simpleCommands } from "../packages/core/src/dangerous-command/shell.js";

describe("literal shell control structures", () => {
  it.each([
    "if test -d build; then rm -rf build; fi",
    "if [ -d build ]; then rm -rf build; fi",
    "if [[ -d build ]]; then rm -rf build; fi",
    "if [[ -d build && -w build ]]; then rm -rf build; fi",
    "if false; then echo no; else rm file; fi",
    "if false; then echo no; elif true; then rm file; fi",
    "if rm file; then echo yes; fi",
    "if true; then if true; then rm file; fi; fi",
    "if true\nthen\nrm file\nfi",
    "if true; then # comment\nrm file; fi",
    "if true; th\\\nen rm file; fi",
    "for f in *.log; do rm -f \"$f\"; done",
    "for f; do rm -f \"$f\"; done",
    "for f\nin one two\ndo\nrm \"$f\"\ndone",
    "for f in one; do for g in two; do rm file; done; done",
    "for f in one; do if true; then rm file; fi; done",
    "while test -f file; do rm file; done",
    "until false; do rm file; done",
    "while rm file; do echo yes; done",
    "{ rm file; }",
    "{ { rm file; }; }",
    "if true; then { rm file; }; fi",
    "(rm file)",
    "if (true); then rm file; fi",
    "if false; then echo no; fi; rm file",
    "for f in one; do echo \"$f\"; done; rm file",
    "{ echo hi; }; rm file",
    "if true; then env FOO=bar nice rm file; fi",
    "if true; then 'rm' file; fi",
    "if true; then git reset --hard; fi",
    "if true; then docker compose down -v; fi",
    "for f in one; do rsync -a --delete src/ dst/; done",
    "bash -c 'if true; then systemctl stop app; fi'",
    'if true; then rm "$(pwd)/file"; fi',
    'for f in one; do rm "$(pwd)/file"; done',
  ])("detects commands inside %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(true);
  });

  it.each([
    "echo then rm file", "echo do rm file", "echo { rm file", "echo if rm file",
    "echo 'if true; then rm file; fi'",
    "'if' rm file", "\\if rm file", "'{' rm file", "\\{ rm file",
    "if true; then echo rm file; fi",
    "if true; 'then' rm file; fi", "if true; th\\en rm file; fi",
    "if true; then echo 'else rm file'; fi",
    "if true; then printf '%s' rm; fi",
    "if true; then git clean -nd; else git status; fi",
    "if true; then docker compose --dry-run down -v; fi",
    "if [[ rm == rm ]]; then echo ok; fi",
    "if [[ a == b || rm == rm ]]; then echo ok; fi",
    "if [[ a == b || ']]' == rm ]]; then echo ok; fi",
    "for f in rm -rf file; do echo \"$f\"; done",
    "for f\nin rm -rf file\ndo echo \"$f\"; done",
    "for f in 'do rm file'; do echo \"$f\"; done",
    "for f in one; 'do' rm file; done",
    "for f in one; do echo \"$f\"; done; echo done rm file",
    "while false; do echo rm; done",
    "until true; do echo rm; done",
    "{ echo rm file; }",
    "cat >then; echo rm file",
    "echo x; then rm file", "echo x; do rm file",
  ])("keeps quoted words, arguments, headers and harmless bodies uninterpreted: %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(false);
  });

  it.each([
    "echo $(pwd); rm file",
    "cat <<EOF\ntext\nEOF\nrm file",
    "for f in $(find .); do rm \"$f\"; done",
    'if true; then git clean "$(pwd)" -n; fi',
    "case x in rm) echo hi;; esac",
    "select f in rm file; do echo \"$f\"; done",
    "function cleanup { rm file; }",
    "cleanup() { rm file; }",
    "cleanup () {\nrm file\n}",
    "rm() { echo harmless; }",
    "if true; then cleanup( ) { rm file; }; fi",
    "for ((i=0; i<2; i++)); do rm file; done",
    "(( rm = 1 )); echo ok",
  ])("retains explicit unsupported-syntax limits: %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(false);
  });

  it("preserves complete versus partial command evidence", () => {
    expect(simpleCommands('if true; then rm "$(pwd)"; fi')).toEqual([
      { words: ["true"], complete: true },
      { words: ["rm"], complete: false },
    ]);
    expect(simpleCommands("for f in rm file; do echo \"$f\"; done; git status")).toEqual([
      { words: ["echo", "$f"], complete: true },
      { words: ["git", "status"], complete: true },
    ]);
  });
});
