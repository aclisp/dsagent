import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandRules from "../packages/core/src/dangerous-command.ts";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";
import * as sandbox from "../packages/core/src/sandbox.ts";
import { createTestTheme } from "./fixtures/theme.ts";

vi.mock("../packages/core/src/hooks.ts", () => ({ registerHooks: vi.fn() }));

async function harness(permission: string, hasUI: boolean, args: string[] = []) {
  const handlers: ((event: any, ctx: ExtensionContext) => any)[] = [];
  const tools = new Map<string, ToolDefinition>();
  const pi = new Proxy({
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      if (name === "tool_call") handlers.push(handler);
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [],
    getThinkingLevel: () => "low",
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
  const extension = createDSCodeExtension(parseRuntimeArgs(["--permission", permission, ...args]).options);
  await (typeof extension === "function" ? extension : extension.factory)(pi);
  const confirm = vi.fn().mockResolvedValue(false);
  const select = vi.fn().mockResolvedValue("Allow once");
  const ui = { confirm, select, theme: createTestTheme(), setWorkingVisible() {}, setStatus() {}, setTitle() {}, notify() {} };
  const ctx = { cwd: process.cwd(), mode: "rpc", hasUI, ui } as unknown as ExtensionToolContext;
  const call = async (cmd: string) => {
    for (const handler of handlers) {
      const result = await handler({ toolName: "exec_command", input: { cmd } }, ctx);
      if (result?.block) return result;
    }
  };
  return {
    confirm, select, call,
    async execute(cmd: string) {
      const result = await call(cmd);
      if (result?.block) throw new Error(result.reason);
      return tools.get("exec_command")!.execute("fixture", { cmd }, undefined, undefined, ctx);
    },
  };
}

describe("DSCode launch command permissions", () => {
  it.runIf(process.platform === "win32")("keeps Windows aliases in the same parent approval flow", async () => {
    const h = await harness("auto", false);
    expect(await h.call('DSCode.EXE -C "C:\\项目 files\\" --permission full -p task'))
      .toMatchObject({ block: true, reason: expect.stringContaining("interactive approval UI") });
    expect(await h.call("dscode.exe --help")).toBeUndefined();
    expect(await h.call("DSCODE.EXE --version")).toBeUndefined();
  });

  it("requires the parent's auto approval even when the child selects full permissions", async () => {
    const h = await harness("auto", true);
    const cmd = "dscode --permission full --network -p 'perform the task'";
    expect(await h.call(cmd)).toMatchObject({ block: true, reason: "Destructive command denied by user" });
    expect(h.confirm).toHaveBeenCalledWith("Run destructive command?", expect.stringContaining("Launch a DSCode agent with independent permissions"));
    h.confirm.mockResolvedValue(true);
    expect(await h.call(cmd)).toBeUndefined();
  });

  it("blocks noninteractive auto launches while allowing help and version commands", async () => {
    const h = await harness("auto", false);
    expect(await h.call("dscode -p 'read the project'"))
      .toMatchObject({ block: true, reason: expect.stringContaining("interactive approval UI") });
    expect(await h.call("dscode --help")).toBeUndefined();
    expect(await h.call("dscode --version")).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("allows full parent mode without introducing another approval flow", async () => {
    const h = await harness("full", false);
    expect(await h.call("dscode --permission full -p 'perform the task'")).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("PowerShell command permissions", () => {
  const detect = commandRules.detectDangerousCommand;
  beforeEach(() => {
    vi.spyOn(sandbox, "sandboxShellSyntax").mockReturnValue("powershell");
    vi.spyOn(commandRules, "detectDangerousCommand").mockImplementation((command, _platform, shell) => detect(command, "win32", shell));
  });
  afterEach(() => vi.restoreAllMocks());

  it("requires auto approval and honors the user's decision", async () => {
    const h = await harness("auto", true);
    const command = "Remove-Item -LiteralPath 'C:\\项目 files\\old.txt' -Confirm:$false";
    expect(await h.call(command)).toMatchObject({ block: true, reason: "Destructive command denied by user" });
    expect(h.confirm).toHaveBeenCalledWith("Run destructive command?", expect.stringContaining("Delete the specified files or provider items"));
    h.confirm.mockResolvedValue(true);
    expect(await h.call(command)).toBeUndefined();
  });

  it("blocks destructive noninteractive calls while allowing inspection and previews", async () => {
    const h = await harness("auto", false);
    for (const command of ["Remove-Item file", "Clear-Content file", "Stop-Process -Id 123 -WhatIf:$false"]) {
      expect(await h.call(command)).toMatchObject({ block: true, reason: expect.stringContaining("interactive approval UI") });
    }
    for (const command of ["Get-Content file", "Remove-Item file -WhatIf", "Write-Output 'Remove-Item file'"]) {
      expect(await h.call(command)).toBeUndefined();
    }
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("keeps full mode available for explicitly trusted commands", async () => {
    const h = await harness("full", false);
    expect(await h.call("Remove-Item file")).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("does not request auto approval for process-local cleanup, with or without UI", async () => {
    for (const hasUI of [false, true]) {
      const h = await harness("auto", hasUI);
      expect(await h.call('Remove-Item "Env:$name"')).toBeUndefined();
      expect(h.confirm).not.toHaveBeenCalled();
    }
  });

  it("keeps ask mode approval for ordinary PowerShell commands", async () => {
    const h = await harness("ask", true);
    expect(await h.call("Get-Content file")).toMatchObject({ block: true });
    expect(await h.call("Remove-Item Env:DSCODE_TEST_VALUE")).toMatchObject({ block: true });
    expect(h.confirm).toHaveBeenCalledWith("Allow exec_command?", expect.any(String));
  });

  it("uses the POSIX parser when Windows commands execute in Docker", async () => {
    vi.mocked(sandbox.sandboxShellSyntax).mockReturnValue("posix");
    const h = await harness("auto", true);
    expect(await h.call('"rm" file.txt')).toMatchObject({ block: true });
    expect(h.confirm).toHaveBeenCalledWith("Run destructive command?", expect.stringContaining("Delete the specified files"));
  });

  it.each([false, true])("honors destructive approval after switching to the host shell (approved=%s)", async approved => {
    vi.mocked(sandbox.sandboxShellSyntax).mockImplementation(options => options.mode === "danger-full-access" ? "powershell" : "posix");
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start")
      .mockResolvedValueOnce({ processId: "1", running: false, output: "Permission denied", exitCode: 1, sandbox: "Docker" })
      .mockResolvedValue({ processId: "2", running: false, output: "", exitCode: 0, sandbox: "host" });
    const h = await harness("auto", true, ["--sandbox", "workspace-write", "--network"]);
    h.confirm.mockResolvedValue(approved);
    const result = h.execute("echo data > output.txt");
    if (approved) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow("Destructive command denied by user");
    expect(h.select).toHaveBeenCalledWith(expect.stringContaining("Allow unrestricted host access?"), expect.any(Array));
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(approved ? 2 : 1);
    if (approved) expect(start.mock.calls[1]![1].sandbox.mode).toBe("danger-full-access");
  });

  it("uses an existing command-scoped host grant for the initial assessment", async () => {
    vi.mocked(sandbox.sandboxShellSyntax).mockImplementation(options => options.mode === "danger-full-access" ? "powershell" : "posix");
    vi.spyOn(ManagedProcessRegistry.prototype, "start")
      .mockResolvedValueOnce({ processId: "1", running: false, output: "Permission denied", exitCode: 1, sandbox: "Docker" })
      .mockResolvedValue({ processId: "2", running: false, output: "", exitCode: 0, sandbox: "host" });
    const h = await harness("auto", true, ["--sandbox", "workspace-write", "--network"]);
    h.select.mockResolvedValue("Allow this command for this session");
    h.confirm.mockResolvedValueOnce(true);
    await h.execute("echo data > output.txt");
    expect(await h.call("echo data > output.txt")).toMatchObject({ block: true });
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("does not repeat destructive approval for a network-only retry in the same shell", async () => {
    vi.mocked(sandbox.sandboxShellSyntax).mockReturnValue("posix");
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start")
      .mockResolvedValueOnce({ processId: "1", running: false, output: "Network is unreachable", exitCode: 1, sandbox: "Docker" })
      .mockResolvedValue({ processId: "2", running: false, output: "", exitCode: 0, sandbox: "Docker" });
    const h = await harness("auto", true, ["--sandbox", "workspace-write"]);
    h.confirm.mockResolvedValue(true);
    await h.execute('"rm" file.txt');
    expect(start).toHaveBeenCalledTimes(2);
    expect(h.select).toHaveBeenCalledWith(expect.stringContaining("Allow network access?"), expect.any(Array));
    expect(h.confirm).toHaveBeenCalledOnce();
  });
});
