import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTools } from "../packages/core/src/subagents.ts";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function assistant(content: string, stopReason = "stop", errorMessage?: string): string {
  return JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: content ? [{ type: "text", text: content }] : [],
    stopReason, ...(errorMessage === undefined ? {} : { errorMessage }),
  } });
}

function makeTool(entry = "/fixture/cli.js") {
  vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "0");
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, entry]);
  let tool: ToolDefinition | undefined;
  const registerCommand = vi.fn();
  const register = () => registerSubagentTools({
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    registerCommand, getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI, {
    providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "http://localhost",
    transport: "responses", promptContract: "engineering", sandbox: "workspace-write", network: false,
  } as DSCodeRuntimeOptions);
  register();
  const ctx = { cwd: "/fixture", model: { provider: "openai", id: "current-model" } } as ExtensionToolContext;
  return { tool: tool!, register, registerCommand, ctx };
}

function child() {
  const instance = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValueOnce(instance as unknown as ReturnType<typeof spawn>);
  return instance;
}

async function delegate(stdout: string, exitCode: number, stderr = "", entry?: string) {
  const run = makeTool(entry);
  const process = child();
  queueMicrotask(() => {
    process.stdout.once("end", () => process.emit("close", exitCode));
    process.stderr.end(stderr);
    process.stdout.end(stdout);
  });
  return run.tool.execute("audit", { task: "Inspect authentication" }, undefined, undefined, run.ctx);
}

describe("investigation-only child", () => {
  it("launches exactly one child with the current model, effort, credentials and fixed tools", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-agent-key");
    const result = await delegate(assistant("Found the issue"), 0);
    expect(result.details).toEqual({ success: true, output: "Found the issue" });
    expect(result.isError).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      "/fixture/cli.js", "-C", "/fixture", "--provider", "openai", "--base-url", "http://localhost",
      "--transport", "responses", "--model", "current-model", "--prompt-contract", "engineering",
      "--thinking", "high", "--mode", "json", "--print", "--no-session", "--no-mcp", "--no-extensions",
      "--permission", "auto", "--sandbox", "workspace-write", "--tools", "read,grep,find,ls",
      expect.stringContaining("Inspect authentication"),
    ]);
    expect(options).toMatchObject({ cwd: "/fixture", shell: false,
      env: { DSCODE_SUBAGENT_DEPTH: "1", OPENAI_API_KEY: "test-agent-key" } });
    expect(args).not.toContain("apply_patch");
    expect(args).not.toContain("exec_command");
  });

  it.each([
    { jsonl: assistant("", "error", "401: provider rejected the API key"), expected: "401: provider rejected the API key" },
    { jsonl: [assistant("Investigating"), assistant("", "error", "Rate limit exceeded")].join("\n"), expected: "Rate limit exceeded" },
    { jsonl: assistant("Partial answer", "error", "Connection lost"), expected: "Partial answer\nConnection lost" },
    { jsonl: assistant("", "error"), expected: "Request error" },
    { jsonl: assistant("", "aborted"), expected: "Request aborted" },
  ])("preserves failed child diagnostics: $expected", async ({ jsonl, expected }) => {
    const result = await delegate(jsonl, 1);
    expect(result.details).toEqual({ success: false, output: expected });
    expect(result.isError).toBe(true);
  });

  it.each(["/fixture/cli.js", "/fixture/src/cli.ts"])("launches %s with Node and keeps the final answer", async (entry) => {
    const result = await delegate(["startup noise", assistant("Investigating"), assistant("Done")].join("\n"), 0, "", entry);
    expect(result.details).toEqual({ success: true, output: "Done" });
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([entry]), expect.any(Object));
  });

  it("keeps stderr for failures before JSON output", async () => {
    expect((await delegate("", 1, "Cannot load native module")).details)
      .toEqual({ success: false, output: "Cannot load native module" });
  });

  it("does not report an empty response or provider failure as successful", async () => {
    expect((await delegate("", 0)).isError).toBe(true);
    expect((await delegate(assistant("", "error", "Rejected"), 0)).isError).toBe(true);
  });

  it("bounds the final findings", async () => {
    const result = await delegate(assistant("x".repeat(200_000)), 0);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("output truncated") });
    expect((result.details as { output: string }).output.length).toBeLessThan(101_000);
  });

  it("handles split JSON records", async () => {
    const run = makeTool();
    const process = child();
    const result = run.tool.execute("audit", { task: "Inspect" }, undefined, undefined, run.ctx);
    const line = assistant("Complete evidence");
    process.stdout.write(line.slice(0, 25));
    process.stdout.once("end", () => process.emit("close", 0));
    process.stdout.end(line.slice(25));
    expect((await result).details).toEqual({ success: true, output: "Complete evidence" });
  });

  it("reports launch errors", async () => {
    const run = makeTool();
    const process = child();
    const result = run.tool.execute("audit", { task: "Inspect" }, undefined, undefined, run.ctx);
    process.emit("error", new Error("Unable to launch"));
    expect((await result).details).toEqual({ success: false, output: "Unable to launch" });
  });

  it("cancels the child and escalates termination if it stays alive", async () => {
    vi.useFakeTimers();
    const run = makeTool();
    const process = child();
    const controller = new AbortController();
    const result = run.tool.execute("audit", { task: "Inspect" }, controller.signal, undefined, run.ctx);
    controller.abort();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    process.emit("close", null);
    expect((await result).content[0]).toMatchObject({ text: expect.stringContaining("cancelled") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")("terminates the child process group on cancellation", async () => {
    vi.useFakeTimers();
    const run = makeTool();
    const processChild = Object.assign(child(), { pid: 123456 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const result = run.tool.execute("audit", { task: "Inspect" }, controller.signal, undefined, run.ctx);
    controller.abort();
    expect(kill).toHaveBeenCalledWith(-123456, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
    expect(processChild.kill).not.toHaveBeenCalled();
    processChild.emit("close", null);
    expect((await result).isError).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a child without hanging the parent", async () => {
    vi.useFakeTimers();
    const run = makeTool();
    const process = child();
    const result = run.tool.execute("audit", { task: "Inspect" }, undefined, undefined, run.ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    process.emit("close", null);
    expect((await result).content[0]).toMatchObject({ text: expect.stringContaining("timed out") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not launch a cancelled or blank task", async () => {
    const run = makeTool();
    const controller = new AbortController();
    controller.abort();
    expect((await run.tool.execute("audit", { task: "Inspect" }, controller.signal, undefined, run.ctx)).isError).toBe(true);
    expect((await run.tool.execute("audit", { task: " " }, undefined, undefined, run.ctx)).isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("registers no role command and prevents nested delegation", () => {
    const run = makeTool();
    expect(run.registerCommand).not.toHaveBeenCalled();
    vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "1");
    const registerTool = vi.fn();
    registerSubagentTools({ registerTool } as unknown as ExtensionAPI, {} as DSCodeRuntimeOptions);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("blocks all child tools except file readers, even if another extension activates them", async () => {
    vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "1");
    const handlers: Array<(event: any, ctx: any) => any> = [];
    const pi = new Proxy({ on(name: string, handler: any) { if (name === "tool_call") handlers.push(handler); } }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    const extension = createDSCodeExtension(parseRuntimeArgs(["--permission", "auto", "--no-mcp"]).options);
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    for (const toolName of ["apply_patch", "exec_command", "write_stdin", "delegate", "mcp__fixture__echo"]) {
      expect(await handlers[0]!({ toolName, input: {} }, {})).toMatchObject({ block: true });
    }
    for (const toolName of ["read", "grep", "find", "ls"]) {
      expect(await handlers[0]!({ toolName, input: {} }, {})).toBeUndefined();
    }
  });
});
