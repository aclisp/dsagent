import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, validateToolArguments, type AssistantMessage, type JsonObject, type Message, type Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { ManagedProcessRegistry, type ManagedProcessResult } from "../packages/core/src/managed-process.ts";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.ts";
import { createTestTheme } from "./fixtures/theme.ts";

describe("command access escalation", () => {
  it.each(["tui", "json", "rpc"])("keeps ordinary permissions without planning commands in %s mode", async (mode) => {
    const commands = new Map<string, any>();
    let activeTools = ["read", "exec_command", "write_stdin", "apply_patch"];
    const pi = new Proxy({
      registerCommand(name: string, command: unknown) { commands.set(name, command); },
      getActiveTools: () => activeTools,
      setActiveTools: (tools: string[]) => { activeTools = tools; },
    }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    await runExtensionFactory(options(process.cwd()), pi);
    const ui = new Proxy({ theme: createTestTheme() }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    });
    const ctx = { mode, ui, hasUI: mode === "tui", model: undefined, sessionManager: SessionManager.inMemory() };
    expect(commands.get("permissions").description).toContain("ask|auto|full");
    expect(commands.has("plan")).toBe(false);
    expect(commands.has("agents")).toBe(false);
    await commands.get("permissions").handler("ask", ctx);
    expect(activeTools).toEqual(["read", "exec_command", "write_stdin", "apply_patch"]);
  });

  let root: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    try {
      await shutdown?.();
    } finally {
      shutdown = undefined;
      vi.restoreAllMocks();
      if (root) await fs.rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function processTools() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-process-tools-"));
    const tools = new Map<string, ToolDefinition<any, ManagedProcessResult>>();
    const handlers: Array<(event: any, ctx: ExtensionContext) => any> = [];
    const pi = new Proxy({
      registerTool(tool: ToolDefinition<any, ManagedProcessResult>) { tools.set(tool.name, tool); },
      on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
        if (name === "session_shutdown") handlers.push(handler);
      },
      getThinkingLevel: () => "low",
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: SessionManager.inMemory(root) } as unknown as ExtensionToolContext;
    await runExtensionFactory({ ...options(root), permission: "full", sandbox: "danger-full-access", network: true }, pi);
    shutdown = async () => {
      for (const handler of handlers) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    };
    return async (name: "exec_command" | "write_stdin", input: JsonObject, signal?: AbortSignal) => {
      const tool = tools.get(name)!;
      const args = validateToolArguments(tool, { type: "toolCall", id: "fixture", name, arguments: input });
      return tool.execute("fixture", args, signal, undefined, ctx);
    };
  }

  it.each([
    { input: { eof: true }, expected: "head" },
    { input: { chars: "tail", eof: true, yield_time_ms: 60_000 }, expected: "headtail" },
  ])("delivers input followed by EOF to a background command ($input)", async ({ input, expected }) => {
    const execute = await processTools();
    const started = await execute("exec_command", {
      cmd: nodeCommand("let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', () => process.stdout.write(input));"),
      stdin_open: true, yield_time_ms: 0,
    });
    const processId = started.details.processId;
    await expect(execute("write_stdin", { process_id: processId, chars: "head", yield_time_ms: 0 }))
      .resolves.toMatchObject({ details: { running: true } });
    await expect(execute("write_stdin", { process_id: processId, ...input }))
      .resolves.toMatchObject({ details: { running: false, exitCode: 0, output: expected } });
  });

  it.each<JsonObject>([{}, { chars: "" }, { yield_time_ms: 0 }])("collects a background command's final output when polling with %j", async (input) => {
    const execute = await processTools();
    const started = await execute("exec_command", {
      cmd: nodeCommand("const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('finish')) { clearInterval(timer); process.stdout.write('finished'); } }, 10);"),
      yield_time_ms: 0,
    });
    const polled = execute("write_stdin", { process_id: started.details.processId, ...input });
    await fs.writeFile(path.join(root!, "finish"), "");
    await expect(polled).resolves.toMatchObject({ details: { running: false, exitCode: 0, output: "finished" } });
  });

  it("returns a command's response after writing input without EOF", async () => {
    const execute = await processTools();
    const started = await execute("exec_command", {
      cmd: nodeCommand("process.stdin.once('data', data => { process.stdout.write(data); process.stdin.destroy(); });"),
      stdin_open: true, yield_time_ms: 0,
    });
    await expect(execute("write_stdin", { process_id: started.details.processId, chars: "hello\n" }))
      .resolves.toMatchObject({ details: { running: false, exitCode: 0, output: "hello\n" } });
  });

  it("terminates a background command through write_stdin", async () => {
    const execute = await processTools();
    const started = await execute("exec_command", {
      cmd: nodeCommand("process.stdin.resume();"), stdin_open: true, yield_time_ms: 0,
    });
    await expect(execute("write_stdin", { process_id: started.details.processId, terminate: true, yield_time_ms: 1_000 }))
      .resolves.toMatchObject({ details: { running: false } });
  });

  it("cancels polling without losing the process or writing input from an aborted call", async () => {
    const execute = await processTools();
    const started = await execute("exec_command", {
      cmd: nodeCommand("let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', () => process.stdout.write(input));"),
      stdin_open: true, yield_time_ms: 0,
    });
    const processId = started.details.processId;
    const controller = new AbortController();
    const canceled = expect(execute("write_stdin", { process_id: processId }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await canceled;
    await expect(execute("write_stdin", { process_id: processId, chars: "discarded", eof: true }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(execute("write_stdin", { process_id: processId, chars: "still alive", eof: true }))
      .resolves.toMatchObject({ details: { running: false, exitCode: 0, output: "still alive" } });
  });

  it("requires approval for EOF but still allows polling in ask mode", async () => {
    const handlers: Array<(event: any, ctx: ExtensionContext) => any> = [];
    const pi = new Proxy({
      on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
        if (name === "tool_call") handlers.push(handler);
      },
    }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    await runExtensionFactory({ ...options(process.cwd()), permission: "ask" }, pi);
    const ctx = { hasUI: false } as ExtensionContext;
    const emit = async (input: Record<string, unknown>) => {
      for (const handler of handlers) {
        const result = await handler({ toolName: "write_stdin", input }, ctx);
        if (result?.block) return result;
      }
    };
    expect(await emit({ process_id: "1" })).toBeUndefined();
    expect(await emit({ process_id: "1", eof: true })).toMatchObject({ block: true });
  });

  it("reports stdin write failures as tool errors while preserving running status", async () => {
    const tools = new Map<string, any>();
    const pi = new Proxy({
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    await runExtensionFactory(options(process.cwd()), pi);
    vi.spyOn(ManagedProcessRegistry.prototype, "interact").mockResolvedValue({
      processId: "1", running: true, output: "", sandbox: "host", writeError: "write EPIPE",
    });
    const tool = tools.get("write_stdin");
    const model: Model<"openai-completions"> = {
      id: "test", name: "test", api: "openai-completions", provider: "openai",
      baseUrl: "http://localhost", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096, maxTokens: 1024,
    };
    let turn = 0;
    const streamFn: StreamFn = () => {
      const callsTool = turn++ === 0;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: callsTool
          ? [{ type: "toolCall", id: "write", name: "write_stdin", arguments: { process_id: "1", chars: "hello" } }]
          : [{ type: "text", text: "done" }],
        stopReason: callsTool ? "toolUse" : "stop",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 0,
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: callsTool ? "toolUse" : "stop", message });
      return stream;
    };
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [{ role: "user", content: "write to the process", timestamp: 0 }],
      { messages: [], tools: [tool] },
      { model, convertToLlm: (messages) => messages as Message[] },
      (event) => { events.push(event); },
      undefined,
      streamFn,
    );
    const completed = events.find((event) => event.type === "tool_execution_end");
    expect(completed?.isError).toBe(true);
    expect(completed?.result.details).toMatchObject({ processId: "1", running: true, writeError: "write EPIPE" });
    const result = messages.find((message) => message.role === "toolResult");
    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([
      { type: "text", text: expect.stringContaining("stdin_write_error: write EPIPE") },
    ]);
    expect(result?.content).toEqual([
      { type: "text", text: expect.stringContaining("status: running") },
    ]);
    expect(result?.content).toEqual([
      { type: "text", text: expect.stringContaining("process_id: 1") },
    ]);
    const rendered = tool.renderResult(
      completed!.result,
      { expanded: false, isPartial: false },
      createTestTheme(),
      { isError: completed!.isError, isPartial: false },
    ).render(120).join("\n");
    expect(rendered).toContain("stdin_write_error: write EPIPE");
    expect(rendered).toContain("status: running");
  });

  it("renders text-only exec_command errors without accessing missing process details", async () => {
    const tools = new Map<string, any>();
    const pi = new Proxy({
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    await runExtensionFactory(options(process.cwd()), pi);
    const message = "Cannot start command: this session already has 64 running jobs.";
    const tool = tools.get("exec_command");
    const rendered = tool.renderResult(
      { content: [{ type: "text", text: message }], details: undefined },
      { expanded: false, isPartial: false },
      createTestTheme(),
      { isError: true, isPartial: false },
    ).render(120).join("\n");
    expect(rendered).toContain(message);
  });

  it("passes the current main-agent thinking level to every managed command", async () => {
    const tools = new Map<string, any>();
    let thinkingLevel: "low" | "max" = "low";
    const pi = new Proxy(
      {
        registerTool(tool: { name: string }) {
          tools.set(tool.name, tool);
        },
        on: () => undefined,
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getThinkingLevel: () => thinkingLevel,
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start").mockResolvedValue({
      processId: "vision-process",
      running: false,
      output: "done",
      exitCode: 0,
      sandbox: "trusted dscode-vision",
    });
    runExtensionFactory(
      {
        ...options(process.cwd()),
        permission: "full",
        sandbox: "danger-full-access",
        network: true,
      },
      pi,
    );
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    await tools.get("exec_command").execute(
      "vision-low",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );
    thinkingLevel = "max";
    await tools.get("exec_command").execute(
      "vision-max",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );

    expect(start.mock.calls[0]?.[1]).toMatchObject({ thinkingLevel: "low" });
    expect(start.mock.calls[1]?.[1]).toMatchObject({ thinkingLevel: "max" });
  });

  it("gets scoped network approval before enabling the trusted vision path", async () => {
    const tools = new Map<string, any>();
    const pi = new Proxy(
      {
        registerTool(tool: { name: string }) {
          tools.set(tool.name, tool);
        },
        on: () => undefined,
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getThinkingLevel: () => "high",
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start").mockResolvedValue({
      processId: "vision-process",
      running: false,
      output: "done",
      exitCode: 0,
      sandbox: "trusted dscode-vision",
    });
    runExtensionFactory(options(process.cwd()), pi);
    const prompts: string[] = [];
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        setWorkingVisible: () => undefined,
        select: async (prompt: string) => {
          prompts.push(prompt);
          return "Allow once";
        },
      },
    } as unknown as ExtensionContext;

    await tools.get("exec_command").execute(
      "vision-network",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Allow network access?");
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      sandbox: { mode: "workspace-write", network: true },
      thinkingLevel: "high",
    });
  });

  it.runIf(process.platform === "darwin")(
    "asks for scoped host access and retries the blocked command once approved",
    async () => {
      root = await fs.mkdtemp(path.join(process.cwd(), ".dscode-access-test-"));
      const nestedWorkspace = path.join(root, "workspace");
      const outsideWorkspace = path.join(root, "host-write.txt");
      await fs.mkdir(nestedWorkspace);

      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = new Proxy(
        {
          registerTool(tool: { name: string }) {
            tools.set(tool.name, tool);
          },
          on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          getActiveTools: () => [],
          setActiveTools: () => undefined,
          getThinkingLevel: () => "max",
        },
        {
          get(target, property) {
            if (property in target) return target[property as keyof typeof target];
            return () => undefined;
          },
        },
      ) as unknown as ExtensionAPI;
      runExtensionFactory(options(nestedWorkspace), pi);

      const prompts: string[] = [];
      const ctx = {
        cwd: nestedWorkspace,
        hasUI: true,
        ui: {
          setWorkingVisible: () => undefined,
          select: async (prompt: string) => {
            prompts.push(prompt);
            return "Allow once";
          },
        },
      } as unknown as ExtensionContext;
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(outsideWorkspace)}, 'approved')`,
      )}`;
      const result = await tools.get("exec_command").execute(
        "access-test",
        { cmd: command, yield_time_ms: 10_000, timeout_ms: 30_000 },
        undefined,
        undefined,
        ctx,
      );

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Allow unrestricted host access?");
      expect(result.details).toMatchObject({ running: false, exitCode: 0, sandbox: "host" });
      await expect(fs.readFile(outsideWorkspace, "utf8")).resolves.toBe("approved");
    },
  );
});

function options(cwd: string): DSCodeRuntimeOptions {
  return {
    cwd,
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-v4-flash",
    transport: "responses",
    promptContract: "engineering",
    permission: "auto",
    sandbox: "workspace-write",
    network: false,
    activeTools: ["read", "exec_command", "write_stdin", "apply_patch"],
    toolsExplicit: false,
    noTools: false,
    noMcp: false,
  };
}

function runExtensionFactory(
  extensionOptions: DSCodeRuntimeOptions,
  pi: ExtensionAPI,
): void | Promise<void> {
  const extension = createDSCodeExtension(extensionOptions);
  return typeof extension === "function" ? extension(pi) : extension.factory(pi);
}

function nodeCommand(script: string): string {
  return process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`
    : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
}
