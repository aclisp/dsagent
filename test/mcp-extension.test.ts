import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";
import { createTestTheme } from "./fixtures/theme.js";

const baseTools = ["read", "exec_command", "write_stdin", "apply_patch"];
const mcpTool = "mcp__fixture__echo";
const fixture = { command: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs")] };

describe("MCP extension lifecycle", () => {
  let root: string;
  let home: string;
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-mcp-extension-"));
    home = path.join(root, "home");
    await fs.mkdir(home);
    vi.stubEnv("DSCODE_HOME", home);
    vi.stubEnv("DSCODE_PROVIDER", "deepseek");
    await configure({ fixture });
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function configure(mcpServers: Record<string, unknown>) {
    await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers }));
  }

  async function runtime(args: string[] = [], trusted = true) {
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    let active: string[] = [];
    const pi = new Proxy({
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = [...names]; },
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const notify = vi.fn();
    const confirm = vi.fn(async () => true);
    const ui = new Proxy({ theme: createTestTheme(), notify, confirm }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
    });
    const ctx = {
      cwd: root, mode: "rpc", hasUI: true, ui,
      isProjectTrusted: () => trusted,
      sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    };
    const extension = createDSCodeExtension(parseRuntimeArgs(["-C", root, "--permission", "auto", ...args]).options);
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    const emit = async (name: string, event = {}) => {
      let lastResult: any;
      for (const handler of handlers.get(name) ?? []) {
        lastResult = await handler(event, ctx);
        if (lastResult?.block) return lastResult;
      }
      return lastResult;
    };
    cleanups.push(() => emit("session_shutdown"));
    await emit("session_start");
    return { tools, ctx, notify, confirm, emit, active: () => active,
      command: (name: string, args = "") => commands.get(name)!.handler(args, ctx) };
  }

  it.each([{ args: [] }, { args: ["--tools", baseTools.join(",")] }, { args: ["--tools", `read,read,${mcpTool}`] }])(
    "automatically activates discovered tools for selection $args", async ({ args }) => {
      const run = await runtime(args);
      expect(run.active()).toEqual([...new Set([...(args.length ? args[1]!.split(",") : baseTools), mcpTool])]);
      const result = await run.tools.get(mcpTool)!.execute("echo", { text: "hello" }, undefined, undefined, run.ctx as any);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("hello|") });
    },
  );

  it.each([
    { mode: "engineering" as const, includesContract: true },
    { mode: "none" as const, includesContract: false },
  ])("controls the engineering contract with --prompt-contract $mode", async ({ mode, includesContract }) => {
    const run = await runtime(["--prompt-contract", mode]);
    const result = await run.emit("before_agent_start", { systemPrompt: "base prompt" });
    if (includesContract) {
      expect(result.systemPrompt).toContain("# DSCode engineering contract");
    } else {
      expect(result.systemPrompt).toBe("base prompt");
    }
  });

  it.each(["--no-mcp", "--no-tools"])("skips discovery for %s, even with invalid configuration", async (flag) => {
    await fs.writeFile(path.join(home, "mcp.json"), "invalid json");
    const run = await runtime([flag, "--tools", `read,${mcpTool}`]);
    expect(run.active()).toEqual(flag === "--no-tools" ? [] : ["read"]);
    expect(run.tools.has(mcpTool)).toBe(false);
    await run.command("mcp");
    expect(run.notify).toHaveBeenCalledWith(`MCP disabled by ${flag}.`, "info");
    await run.command("permissions", "plan");
    await run.command("permissions", "plan");
    await run.command("permissions", "auto");
    expect(run.active()).toEqual(flag === "--no-tools" ? [] : ["read"]);
  });

  it("hides MCP in plan and restores the original tools after repeated plan requests", async () => {
    const run = await runtime(["--permission", "plan"]);
    expect(run.active()).toEqual(["read", "exec_command", "write_stdin", "update_plan"]);
    await run.command("permissions", "plan");
    await run.command("mcp");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("[disabled in plan mode]"), "info");
    expect(await run.emit("tool_call", { toolName: mcpTool, input: {} })).toMatchObject({ block: true });
    await run.command("plan");
    expect(run.active()).toEqual([...baseTools, mcpTool]);
  });

  it("keeps MCP approvals in auto/ask, blocks noninteractive approval, and allows full", async () => {
    const run = await runtime();
    const call = { toolName: mcpTool, input: { text: "hello" } };
    for (const mode of ["auto", "ask"]) {
      await run.command("permissions", mode);
      run.confirm.mockResolvedValueOnce(false);
      expect(await run.emit("tool_call", call)).toMatchObject({ block: true });
    }
    run.ctx.hasUI = false;
    expect(await run.emit("tool_call", call)).toMatchObject({ block: true });
    run.ctx.hasUI = true;
    await run.command("permissions", "full");
    run.confirm.mockClear();
    expect(await run.emit("tool_call", call)).toBeUndefined();
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("continues after one server fails and clears stale active tools on session initialization", async () => {
    await configure({ missing: { command: path.join(root, "missing-command") }, fixture, disabled: { ...fixture, disabled: true } });
    const run = await runtime(["--tools", `read,${mcpTool}`]);
    expect(run.active()).toEqual(["read", mcpTool]);
    await run.command("mcp");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("error: missing:"), "info");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("[active]"), "info");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("disabled by configuration"), "info");
    await configure({});
    await run.emit("session_start");
    expect(run.active()).toEqual(["read"]);
    await fs.writeFile(path.join(home, "mcp.json"), "invalid");
    await run.emit("session_start");
    await run.command("mcp");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid MCP configuration"), "info");
  });

  it("does not load project MCP configuration without project trust", async () => {
    await configure({});
    await fs.mkdir(path.join(root, ".dscode"));
    await fs.writeFile(path.join(root, ".dscode", "mcp.json"), JSON.stringify({ mcpServers: { fixture } }));
    const run = await runtime([], false);
    expect(run.active()).toEqual(baseTools);
    expect(run.tools.has(mcpTool)).toBe(false);
    await run.command("mcp");
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("Project is not trusted"), "info");
  });
});
