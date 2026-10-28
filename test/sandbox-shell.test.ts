import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxCommand, sandboxShellName, sandboxShellSyntax } from "../packages/core/src/sandbox.ts";
import * as nativeSandbox from "../packages/core/src/windows-sandbox.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Windows execution shell selection", () => {
  it.each([
    { mode: "workspace-write", native: false, syntax: "posix", executable: "docker" },
    { mode: "danger-full-access", native: false, syntax: "powershell", executable: "pwsh.exe" },
    { mode: "danger-full-access", native: false, syntax: "powershell", executable: "powershell.exe" },
    { mode: "workspace-write", native: true, syntax: "powershell", executable: "native-helper" },
  ] as const)("matches approval syntax to the execution backend ($executable)", sample => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
    vi.stubEnv("PATH", "/fixture-bin");
    vi.stubEnv("DSCODE_SANDBOX_IMAGE", "fixture-image");
    vi.stubEnv("DSCODE_WINDOWS_SANDBOX", sample.native ? "1" : "0");
    vi.stubEnv("DSCODE_SHELL", sample.executable === "powershell.exe" ? "powershell.exe" : "pwsh.exe");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.spyOn(nativeSandbox, "windowsNativeSandboxCommand").mockReturnValue({ command: "native-helper", args: [], description: "native" });
    const options = { mode: sample.mode, network: false };
    expect(sandboxShellSyntax(options)).toBe(sample.syntax);
    expect(sandboxShellName(options)).toBe(sample.executable === "docker" ? "/bin/sh"
      : sample.executable === "native-helper" ? "pwsh.exe" : sample.executable);
    const invocation = sandboxCommand("echo data", process.cwd(), options);
    expect(invocation.command).toBe(sample.executable);
    if (sample.executable === "docker") expect(invocation.args.slice(-3)).toEqual(["/bin/sh", "-c", "echo data"]);
  });

  it("keeps environment reporting available when PowerShell is missing", () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
    vi.stubEnv("DSCODE_SHELL", "");
    vi.stubEnv("PATH", "");
    vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("ENOENT"); });
    expect(sandboxShellName({ mode: "danger-full-access", network: false })).toBe("unavailable");
  });
});
