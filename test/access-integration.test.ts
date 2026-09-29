import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, validateToolArguments, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.js";
import { createTestTheme } from "./fixtures/theme.js";

describe("command access escalation", () => {
  it.each(["tui", "json", "rpc"])("keeps CLI plan commands available in %s mode", async (mode) => {
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
    const ctx = { mode, ui, hasUI: mode === "tui", model: undefined };
    expect(commands.get("permissions").description).toContain("plan|ask|auto|full");
    await commands.get("permissions").handler("plan", ctx);
    expect(activeTools).toEqual(["read", "exec_command", "write_stdin", "update_plan"]);
    await commands.get("plan").handler("", ctx);
    expect(activeTools).toEqual(["read", "exec_command", "write_stdin", "apply_patch"]);
  });

  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([{}, { eof: true }, { chars: "last input", eof: true }])("validates and forwards write_stdin options (%j)", async (input) => {
    const tools = new Map<string, any>();
    const pi = new Proxy({
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as ExtensionAPI;
    await runExtensionFactory(options(process.cwd()), pi);
    const interact = vi.spyOn(ManagedProcessRegistry.prototype, "interact").mockResolvedValue({
      processId: "background-process",
      running: true,
      output: "",
      sandbox: "host",
    });
    const tool = tools.get("write_stdin");
    const args = validateToolArguments(tool, {
      type: "toolCall",
      id: "poll",
      name: "write_stdin",
      arguments: { process_id: "background-process", yield_time_ms: 60_000, ...input },
    });

    await tool.execute("poll", args);
    expect(interact).toHaveBeenLastCalledWith("background-process", {
      yieldTimeMs: 60_000,
      terminate: false,
      ...input,
    });
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
      sandbox: "trusted dscode-vision (fixed executable)",
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
      sandbox: "trusted dscode-vision (fixed executable)",
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
    activeTools: ["update_plan", "exec_command", "write_stdin", "apply_patch"],
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
