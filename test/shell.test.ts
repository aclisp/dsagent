import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostShellCommand, windowsPowerShellCommand } from "../packages/core/src/shell.ts";

describe("Windows PowerShell preparation", () => {
  let root: string;
  let programFiles: string;
  let systemRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-shell-"));
    programFiles = path.join(root, "Program Files 中文");
    systemRoot = path.join(root, "Windows");
    vi.stubEnv("PATH", "");
    vi.stubEnv("DSCODE_SHELL", "");
    vi.stubEnv("ProgramFiles", programFiles);
    vi.stubEnv("SystemRoot", systemRoot);
    vi.stubEnv("WINDIR", systemRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function executable(...parts: string[]): Promise<string> {
    const file = path.join(...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture; never executed");
    return file;
  }

  it("uses DSCODE_SHELL ahead of PATH and installation fallbacks in both modes", async () => {
    const configured = await executable(root, "chosen", "pwsh.exe");
    const onPath = await executable(root, "bin", "pwsh.exe");
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    vi.stubEnv("DSCODE_SHELL", ` ${configured} `);
    vi.stubEnv("PATH", path.dirname(onPath));
    expect(windowsPowerShellCommand("echo hi").command).toBe(configured);
    expect(windowsPowerShellCommand("echo hi", "native-sandbox").command).toBe(configured);
  });

  it.each(["pwsh.exe", "pwsh"])("resolves native-sandbox override %s on PATH while preserving the host override", async (configured) => {
    const shell = await executable(root, "bin", "pwsh.exe");
    vi.stubEnv("DSCODE_SHELL", configured);
    vi.stubEnv("PATH", path.dirname(shell));
    expect(windowsPowerShellCommand("echo hi").command).toBe(configured);
    expect(windowsPowerShellCommand("echo hi", "native-sandbox").command).toBe(shell);
  });

  it.each([
    ".\\tools\\pwsh.exe",
    "./tools/pwsh.exe",
    "C:\\Tools\\PowerShell\\pwsh",
    "C:\\Missing\\pwsh.exe",
    "custom-launcher",
  ])("passes the host DSCODE_SHELL value %s through unchanged", async (configured) => {
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    vi.stubEnv("DSCODE_SHELL", ` ${configured} `);
    expect(windowsPowerShellCommand("echo hi").command).toBe(configured);
  });

  it("prefers PowerShell 7 on PATH, respecting quoted directories and PATH order", async () => {
    const first = await executable(root, "first bin", "pwsh.exe");
    const second = await executable(root, "second bin", "pwsh.exe");
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    vi.stubEnv("PATH", `"${path.dirname(first)}"${path.delimiter}${path.dirname(second)}`);
    expect(windowsPowerShellCommand("echo hi").command).toBe(first);
  });

  it("finds installed PowerShell 7 before falling back to Windows PowerShell on PATH", async () => {
    const legacy = await executable(root, "bin", "powershell.exe");
    const pwsh = await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    vi.stubEnv("PATH", path.dirname(legacy));
    expect(windowsPowerShellCommand("echo hi").command).toBe(pwsh);
    expect(windowsPowerShellCommand("echo hi", "native-sandbox").command).toBe(pwsh);
  });

  it("uses Windows PowerShell on PATH when no PowerShell 7 installation exists", async () => {
    const shell = await executable(root, "bin", "powershell.exe");
    await executable(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    vi.stubEnv("PATH", path.dirname(shell));
    expect(windowsPowerShellCommand("echo hi").command).toBe(shell);
    expect(() => windowsPowerShellCommand("echo hi", "native-sandbox")).toThrow("requires PowerShell 7");
  });

  it.each(["SystemRoot", "WINDIR"])("finds Windows PowerShell outside PATH through %s", async (variable) => {
    const shell = await executable(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    vi.stubEnv("SystemRoot", variable === "SystemRoot" ? systemRoot : "");
    expect(windowsPowerShellCommand("echo hi").command).toBe(shell);
  });

  it("skips directories named like executable files", async () => {
    const bin = path.join(root, "bin");
    await fs.mkdir(path.join(bin, "pwsh.exe"), { recursive: true });
    const shell = await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    vi.stubEnv("PATH", bin);
    expect(windowsPowerShellCommand("echo hi").command).toBe(shell);
  });

  it.each(["missing", "directory"])("rejects a %s native-sandbox override while passing the host override through", async (kind) => {
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    const configured = path.join(root, "chosen", "pwsh.exe");
    if (kind === "directory") await fs.mkdir(configured, { recursive: true });
    vi.stubEnv("DSCODE_SHELL", configured);
    expect(windowsPowerShellCommand("echo hi").command).toBe(configured);
    expect(() => windowsPowerShellCommand("echo hi", "native-sandbox")).toThrow("requires DSCODE_SHELL to point to pwsh.exe");
  });

  it("allows a configured Windows PowerShell for host execution while keeping the sandbox's PowerShell 7 requirement", async () => {
    const shell = await executable(root, "chosen", "powershell.exe");
    vi.stubEnv("DSCODE_SHELL", shell);
    expect(windowsPowerShellCommand("echo hi").command).toBe(shell);
    expect(() => windowsPowerShellCommand("echo hi", "native-sandbox")).toThrow("requires DSCODE_SHELL to point to pwsh.exe");
  });

  it("reports a missing PowerShell installation before trying to launch a command", () => {
    expect(() => windowsPowerShellCommand("echo hi")).toThrow("No PowerShell executable found");
    expect(() => windowsPowerShellCommand("echo hi", "native-sandbox")).toThrow("requires PowerShell 7");
  });

  it("prepares the same UTF-8 script in both modes while preserving their launch flags", async () => {
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    const script = "Write-Output '中文'; Get-Item -LiteralPath 'C:\\Work Files\\a[1].txt'\nWrite-Output \"$env:TEMP\"";
    const host = windowsPowerShellCommand(script);
    const native = windowsPowerShellCommand(script, "native-sandbox");
    expect(host.args.at(-1)).toBe(`try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${script}`);
    expect(native.args.at(-1)).toBe(host.args.at(-1));
    expect(host.args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(native.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("does not duplicate an existing UTF-8 prefix, including after leading whitespace", async () => {
    await executable(programFiles, "PowerShell", "7", "pwsh.exe");
    const prepared = ` \n${windowsPowerShellCommand("Write-Output '中文'").args.at(-1)!}`;
    expect(windowsPowerShellCommand(prepared).args.at(-1)).toBe(prepared);
    expect(windowsPowerShellCommand(prepared, "native-sandbox").args.at(-1)).toBe(prepared);
  });

  it.skipIf(process.platform === "win32")("preserves Unix host shell invocation", () => {
    vi.stubEnv("SHELL", "/bin/sh");
    expect(hostShellCommand("printf hello")).toEqual({ command: "/bin/sh", args: ["-lc", "printf hello"], description: "host" });
  });
});
