import { describe, expect, it } from "vitest";
import { classifyLiteralCommand } from "../packages/core/src/literal-command.ts";

function classify(command: string, platform: NodeJS.Platform = "win32") {
  return classifyLiteralCommand(command, "dscode", platform);
}

describe("Windows literal child commands", () => {
  it.each(["dscode", "dscode.exe", "DSCode.EXE", "DSCODE"])("recognizes the fixed CLI alias %s", executable => {
    expect(classify(`${executable} --mode rpc --no-session`)).toEqual({
      kind: "trusted", command: { args: ["--mode", "rpc", "--no-session"] },
    });
  });

  it("preserves drive paths, UNC paths, trailing backslashes, and Chinese directory names", () => {
    expect(classify(String.raw`dscode.exe -C "C:\项目 files\" --session '\\server\共享目录\a.jsonl' --export C:\work\a.jsonl C:\work\out.html`))
      .toEqual({ kind: "trusted", command: { args: ["-C", "C:\\项目 files\\", "--session", "\\\\server\\共享目录\\a.jsonl",
        "--export", "C:\\work\\a.jsonl", "C:\\work\\out.html"] } });
  });

  it("supports doubled PowerShell quotes and literal backtick escapes", () => {
    expect(classify("dscode -C 'C:\\O''Brien\\项目' -p \"Say \"\"hello\"\"\""))
      .toEqual({ kind: "trusted", command: { args: ["-C", "C:\\O'Brien\\项目", "-p", 'Say "hello"'] } });
    expect(classify('dscode -p "Say `"hello`" to `$HOME and ``"'))
      .toEqual({ kind: "trusted", command: { args: ["-p", 'Say "hello" to $HOME and `'] } });
    expect(classify("dscode -p hello` world"))
      .toEqual({ kind: "trusted", command: { args: ["-p", "hello world"] } });
  });

  it("keeps quoted task text literal without variable or command evaluation", () => {
    expect(classify('dscode -p "Read $HOME literally"'))
      .toEqual({ kind: "trusted", command: { args: ["-p", "Read $HOME literally"] } });
    expect(classify("dscode -p '$(Get-Content secret); & | > `text`'"))
      .toEqual({ kind: "trusted", command: { args: ["-p", "$(Get-Content secret); & | > `text`"] } });
    expect(classify('dscode -p "`$(literal)"'))
      .toEqual({ kind: "trusted", command: { args: ["-p", "$(literal)"] } });
  });

  it.each([
    "dscode.exe -p task | Get-Content", "DSCODE.EXE -p task > out.txt", "DSCode.EXE -p task && whoami",
    "dscode.exe -p task; whoami", "dscode.exe -p $TASK", 'dscode.exe -p "$(whoami)"',
    "dscode.exe -p @args", "dscode.exe -p @(whoami)", "dscode.exe -p {whoami}",
    "dscode.exe -p 'unterminated", "dscode.exe -p task\nwhoami", "dscode.exe -p task`",
    'dscode.exe -p "unsupported`nnewline"',
  ])("rejects unsupported shell syntax before spawning: %s", command => {
    expect(classify(command)).toMatchObject({ kind: "invalid" });
  });

  it.each([
    "Set-Location C:\\repo; DSCODE.EXE -p task", "Write-Output ok | dscode.exe -p task",
    "Set-Location 'C:\\O''Brien'; DSCode.EXE -p task", 'Write-Output "C:\\repo\\"; dscode.exe -p task',
  ])("rejects chained aliases instead of falling back to a shell: %s", command => {
    expect(classify(command)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("must be invoked directly") });
  });

  it.each([
    "echo dscode.exe", "dscode.exe.backup -p task", "dscode-vision.exe --image test.png",
    "Write-Output 'C:\\O''Brien; dscode.exe -p task'", 'Write-Output "a`"; dscode.exe -p task"',
  ])("does not reinterpret unrelated commands or quoted mentions: %s", command => {
    expect(classify(command)).toEqual({ kind: "other" });
  });
});

describe("Unix literal child commands", () => {
  it.each(["linux", "darwin"] as const)("retains Unix escaping and exact names on %s", platform => {
    expect(classify(String.raw`dscode -C work\ files -p "say \"hello\""`, platform))
      .toEqual({ kind: "trusted", command: { args: ["-C", "work files", "-p", 'say "hello"'] } });
    expect(classify("dscode.exe --version", platform)).toEqual({ kind: "other" });
    expect(classify("DSCODE --version", platform)).toEqual({ kind: "other" });
    expect(classify("dscode -p `whoami`", platform)).toMatchObject({ kind: "invalid" });
  });
});
