import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxCommand, sandboxShellSyntax } from "../packages/core/src/sandbox.ts";
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
    { mode: "workspace-write", native: true, syntax: "powershell", executable: "native-helper" },
  ] as const)("matches approval syntax to the execution backend ($executable)", sample => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
    vi.stubEnv("PATH", "/fixture-bin");
    vi.stubEnv("DSCODE_SANDBOX_IMAGE", "fixture-image");
    vi.stubEnv("DSCODE_WINDOWS_SANDBOX", sample.native ? "1" : "0");
    vi.stubEnv("DSCODE_SHELL", "pwsh.exe");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(nativeSandbox, "windowsNativeSandboxCommand").mockReturnValue({ command: "native-helper", args: [], description: "native" });
    const options = { mode: sample.mode, network: false };
    expect(sandboxShellSyntax(options)).toBe(sample.syntax);
    const invocation = sandboxCommand("echo data", process.cwd(), options);
    expect(invocation.command).toBe(sample.executable);
    if (sample.executable === "docker") expect(invocation.args.slice(-3)).toEqual(["/bin/sh", "-c", "echo data"]);
  });
});
