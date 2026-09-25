import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
    vi.restoreAllMocks();
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
    const custom = vi.fn(async (): Promise<string> => "once");
    const ui = new Proxy({ theme: createTestTheme(), notify, confirm, custom }, {
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
    return { tools, ctx, notify, confirm, custom, emit, active: () => active,
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

  it.each(["auto", "ask"])("allows one tool across arguments in %s without allowing sibling tools", async (mode) => {
    vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [
      { name: "echo", inputSchema: { type: "object" } },
      { name: "other", inputSchema: { type: "object" } },
    ] });
    const run = await runtime(["--permission", mode]);
    run.ctx.mode = "tui";
    run.custom.mockResolvedValueOnce("tool");
    expect(await run.emit("tool_call", { toolName: mcpTool, input: { text: "one" } })).toBeUndefined();
    expect(await run.emit("tool_call", { toolName: mcpTool, input: { text: "two" } })).toBeUndefined();
    expect(run.custom).toHaveBeenCalledTimes(1);
    run.custom.mockResolvedValueOnce("deny");
    expect(await run.emit("tool_call", { toolName: "mcp__fixture__other", input: {} })).toMatchObject({ block: true });
    await run.command("mcp");
    expect(run.notify).toHaveBeenLastCalledWith(expect.stringContaining("[allowed for this session]"), "info");
    await run.command("permissions", "plan");
    expect(await run.emit("tool_call", { toolName: mcpTool, input: {} })).toMatchObject({ block: true });
  });

  it("allows all tools only on the selected server, using registered server identity", async () => {
    await configure({ "fixture__one": fixture, other: fixture });
    vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [
      { name: "echo", inputSchema: { type: "object" } },
      { name: "other", inputSchema: { type: "object" } },
    ] });
    const run = await runtime();
    run.ctx.mode = "tui";
    run.custom.mockResolvedValueOnce("server");
    expect(await run.emit("tool_call", { toolName: "mcp__fixture__one__echo", input: {} })).toBeUndefined();
    expect(await run.emit("tool_call", { toolName: "mcp__fixture__one__other", input: {} })).toBeUndefined();
    expect(run.custom).toHaveBeenCalledTimes(1);
    await run.command("mcp");
    expect(run.notify).toHaveBeenLastCalledWith(expect.stringContaining("fixture__one: connected (2 tools) [all tools allowed for this session]"), "info");
    run.custom.mockResolvedValueOnce("deny");
    expect(await run.emit("tool_call", { toolName: "mcp__other__echo", input: {} })).toMatchObject({ block: true });
  });

  it.each(["once", "deny"])("does not retain a %s decision", async (choice) => {
    const run = await runtime();
    run.ctx.mode = "tui";
    run.custom.mockResolvedValue(choice);
    const call = { toolName: mcpTool, input: {} };
    const first = await run.emit("tool_call", call);
    expect(first?.block === true).toBe(choice === "deny");
    await run.emit("tool_call", call);
    expect(run.custom).toHaveBeenCalledTimes(2);
  });

  it("keeps non-TUI confirmations single-use", async () => {
    const run = await runtime();
    const call = { toolName: mcpTool, input: {} };
    await run.emit("tool_call", call);
    await run.emit("tool_call", call);
    expect(run.confirm).toHaveBeenCalledTimes(2);
    expect(run.custom).not.toHaveBeenCalled();
  });

  it.each(["tool", "server"])("revokes %s permission and clears it when the session reconnects", async (scope) => {
    const run = await runtime();
    run.ctx.mode = "tui";
    const call = { toolName: mcpTool, input: {} };
    run.custom.mockResolvedValue(scope);
    await run.emit("tool_call", call);
    await run.command("mcp", "revoke");
    await run.emit("tool_call", call);
    expect(run.custom).toHaveBeenCalledTimes(2);
    await run.emit("session_start");
    await run.emit("tool_call", call);
    expect(run.custom).toHaveBeenCalledTimes(3);
  });

  it("serializes concurrent prompts and rechecks granted permissions", async () => {
    const run = await runtime();
    run.ctx.mode = "tui";
    let finish!: (choice: string) => void;
    run.custom.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const call = { toolName: mcpTool, input: {} };
    const first = run.emit("tool_call", call);
    const second = run.emit("tool_call", call);
    await vi.waitFor(() => expect(run.custom).toHaveBeenCalledTimes(1));
    finish("tool");
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(run.custom).toHaveBeenCalledTimes(1);
  });

  it.each(["revoke", "session_start"])("does not apply a stale decision after %s", async (action) => {
    const run = await runtime();
    run.ctx.mode = "tui";
    let finish!: (choice: string) => void;
    run.custom.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const call = { toolName: mcpTool, input: {} };
    const pending = run.emit("tool_call", call);
    await vi.waitFor(() => expect(run.custom).toHaveBeenCalledTimes(1));
    if (action === "revoke") await run.command("mcp", "revoke");
    else await run.emit("session_start");
    finish("server");
    expect(await pending).toMatchObject({ block: true, reason: expect.stringContaining("context changed") });
    await run.emit("tool_call", call);
    expect(run.custom).toHaveBeenCalledTimes(2);
  });

  it("rejects normalized tool-name collisions before registering the second server", async () => {
    await configure({ "fixture.one": fixture, fixture_one: fixture });
    const run = await runtime();
    expect(run.active().filter((name) => name.startsWith("mcp__"))).toEqual(["mcp__fixture_one__echo"]);
    expect(run.notify).toHaveBeenCalledWith(expect.stringContaining("Duplicate MCP tool name: mcp__fixture_one__echo"), "warning");
    await run.command("mcp");
    expect(run.notify).toHaveBeenLastCalledWith(expect.stringContaining("fixture.one: connected (1 tools)"), "info");
  });

  it("uses dangerous command rules for auto approvals", async () => {
    const run = await runtime(["--no-mcp"]);
    run.confirm.mockClear();
    for (const cmd of ["git rm tracked.ts", "git rm -fn tracked.ts", "git rm -f --cached tracked.ts"]) {
      expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd } })).toBeUndefined();
    }
    expect(run.confirm).not.toHaveBeenCalled();
    run.confirm.mockResolvedValueOnce(false);
    expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd: "git rm -f tracked.ts" } })).toMatchObject({ block: true });
    expect(run.confirm).toHaveBeenLastCalledWith("Run destructive command?", expect.stringContaining("git rm -f tracked.ts"));
    run.confirm.mockClear();
    for (const cmd of ["echo rm", "git clean -nd", "git reset --soft HEAD~1", "npm test", "bash -euo pipefail -c 'echo rm'", "eval 'echo rm'", "git switch main", "nohup echo rm"]) {
      expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd } })).toBeUndefined();
    }
    expect(run.confirm).not.toHaveBeenCalled();
    for (const cmd of ["find . -exec rm {} +", "xargs -0 rm", "bash -lc 'rm file'", 'rm "$(pwd)/file"', "dd of=output", "git stash clear", "bash -euo pipefail -c 'rm x'", "bash --login -c 'rm x'", "eval 'rm' '-rf x'", "git switch --discard-changes main", "nohup rm x"]) {
      run.confirm.mockResolvedValueOnce(false);
      expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd } })).toMatchObject({ block: true });
      expect(run.confirm).toHaveBeenLastCalledWith("Run destructive command?", expect.stringContaining(cmd));
    }
    const call = { toolName: "exec_command", input: { cmd: "git -C repo reset --hard" } };
    run.confirm.mockResolvedValueOnce(false);
    expect(await run.emit("tool_call", call)).toMatchObject({ block: true });
    expect(run.confirm).toHaveBeenLastCalledWith("Run destructive command?", expect.stringContaining(call.input.cmd));
    run.confirm.mockResolvedValueOnce(true);
    expect(await run.emit("tool_call", call)).toBeUndefined();
    run.ctx.hasUI = false;
    expect(await run.emit("tool_call", call)).toMatchObject({ block: true });
  });

  it("gates server operations and control-structure bodies even with unrestricted host access", async () => {
    const run = await runtime(["--no-mcp", "--sandbox", "danger-full-access", "--network"]);
    run.confirm.mockClear();
    for (const cmd of [
      "rsync -an --delete src/ dst/", "docker compose --dry-run down -v",
      "systemctl status app", "if true; then git clean -nd; fi",
      "for f in rm file; do echo \"$f\"; done",
    ]) {
      expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd } })).toBeUndefined();
    }
    expect(run.confirm).not.toHaveBeenCalled();
    run.confirm.mockResolvedValue(false);
    for (const cmd of [
      "rsync -a --delete src/ dst/", "docker compose down -v", "systemctl restart app",
      "git worktree remove -f ../old", "unlink data.db",
      "if true; then rm file; fi", "for f in *.log; do rm \"$f\"; done",
      "{ docker volume prune -f; }",
    ]) {
      expect(await run.emit("tool_call", { toolName: "exec_command", input: { cmd } })).toMatchObject({ block: true });
      expect(run.confirm).toHaveBeenLastCalledWith("Run destructive command?", expect.stringContaining(cmd));
    }
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
