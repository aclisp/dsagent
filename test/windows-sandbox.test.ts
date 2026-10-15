import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowsPowerShellCommand } from "../packages/core/src/shell.ts";
import {
  buildWindowsSandboxCommand,
  parseWindowsSandboxLifecycleCommand,
} from "../packages/core/src/windows-sandbox.ts";

describe("Windows native sandbox protocol", () => {
  const requests: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(requests.splice(0).map((request) => fs.rm(request, { force: true })));
  });

  it("writes a structured helper request without host credentials", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-windows-request-"));
    try {
      const invocation = buildWindowsSandboxCommand(
        "Write-Output 'hello world'",
        cwd,
        { mode: "workspace-write", network: false },
        {
          helperPath: "C:\\DSCode\\dscode-windows-sandbox.exe",
          statePath: "C:\\DSCode\\state.bin",
          shell: {
            command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            args: ["-NoProfile", "-Command", "Write-Output 'hello world'"],
            description: "PowerShell 7",
          },
        },
      );
      const requestPath = invocation.args[1]!;
      requests.push(requestPath);
      const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;

      expect(invocation.args[0]).toBe("run");
      expect(invocation.description).toBe(
        "Windows native sandbox (workspace-write, no network)",
      );
      expect(request).toMatchObject({
        version: 1,
        state_path: "C:\\DSCode\\state.bin",
        mode: "workspace-write",
        network: false,
        cwd: path.resolve(cwd),
      });
      expect(request.command).toBeTruthy();
      expect(request.args).toBeInstanceOf(Array);
      expect(request).not.toHaveProperty("env");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("discovers PowerShell 7 and sends the shared UTF-8 script to the helper without an injected shell", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-windows-discovery-"));
    try {
      const programFiles = path.join(cwd, "Program Files 中文");
      const shell = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
      await fs.mkdir(path.dirname(shell), { recursive: true });
      await fs.writeFile(shell, "fixture; never executed");
      vi.stubEnv("PATH", "");
      vi.stubEnv("DSCODE_SHELL", "");
      vi.stubEnv("ProgramFiles", programFiles);
      const script = "Write-Output '中文'\nGet-Item -LiteralPath 'C:\\Work Files\\a[1].txt'";
      const invocation = buildWindowsSandboxCommand(script, cwd, { mode: "workspace-write", network: false }, {
        helperPath: "C:\\DSCode\\dscode-windows-sandbox.exe", statePath: "C:\\DSCode\\state.bin",
      });
      const requestPath = invocation.args[1]!;
      requests.push(requestPath);
      const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
      expect(request.command).toBe(shell);
      expect(request.args.at(-1)).toBe(windowsPowerShellCommand(script).args.at(-1));
      expect(request.args.at(-1)).toContain("[Console]::OutputEncoding=");
      expect(request.args.at(-1)).toContain(script);
      expect(request.args).toContain("-NoProfile");
      expect(request).not.toHaveProperty("env");
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });

  it("parses only explicit lifecycle commands", () => {
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "setup"])).toBe("setup");
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "status"])).toBe("status");
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "uninstall"])).toBe("uninstall");
    expect(parseWindowsSandboxLifecycleCommand(["--sandbox", "read-only"])).toBeUndefined();
    expect(() => parseWindowsSandboxLifecycleCommand(["sandbox", "repair"])).toThrow(
      "Usage: dscode sandbox <setup|status|uninstall>",
    );
  });
});
