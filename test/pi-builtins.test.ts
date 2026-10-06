import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { DefaultResourceLoader, ProjectTrustStore, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { createDSCodePiBuiltins } from "../packages/core/src/pi-builtins.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createAgentSessionHost } from "../packages/http-adapter/src/agent-session-host.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-pi-native-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  vi.stubEnv("DSCODE_HOME", agentDir);
  vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(root, "sessions"));
  vi.stubEnv("DEEPSEEK_API_KEY", "inherited-test-key");
  new ProjectTrustStore(agentDir).set(root, true);
  return { root, agentDir };
}

async function fixtureConfig(directory: string, env?: Record<string, string>) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs")], ...(env ? { env } : {}) },
    disabled: { enabled: false, command: "must-not-run" },
  } }));
}

async function executeCode(host: Awaited<ReturnType<typeof createAgentSessionHost>>, code: string) {
  const message = {
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id: "code-parent", name: "codemode", arguments: { code } }],
    api: host.session.model!.api, provider: host.session.model!.provider, model: host.session.model!.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" as const, timestamp: Date.now(),
  };
  host.session.agent.state.messages = [...host.session.agent.state.messages, message];
  host.session.sessionManager.appendMessage(message);
  const tool = host.session.agent.state.tools.find((tool) => tool.name === "codemode")!;
  const result = await tool.execute("code-parent", { code });
  return { result, text: result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") };
}

describe("DSCode Pi built-ins", () => {
  it.each([
    { args: [], tools: ["codemode", "tool_search"], mcp: true },
    { args: ["--no-mcp"], tools: ["codemode", "tool_search"], mcp: false },
    { args: ["--no-tools"], tools: [], mcp: false },
  ])("loads native factories or suppresses them before startup and reload ($args)", async ({ args, tools, mcp }) => {
    const { root, agentDir } = await setup();
    const options = parseRuntimeArgs(["-C", root, ...args]).options;
    const upstreamFactory = vi.fn(() => { throw new Error("Default must be replaced"); });
    const upstream: InlineExtension[] = ["mcp", "codemode", "tool-search"].map((name) => ({ name, builtin: true, factory: upstreamFactory }));
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir,
      settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
      additionalExtensionPaths: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"],
      extensionFactories: [...upstream, ...await createDSCodePiBuiltins(options), createDSCodeExtension(options)],
    });
    for (let reload = 0; reload < 2; reload++) {
      await loader.reload();
      const result = loader.getExtensions();
      expect(result.errors).toEqual([]);
      expect(result.warnings ?? []).toEqual([]);
      const registered = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
      expect(registered.filter((name) => ["codemode", "tool_search"].includes(name)).sort()).toEqual(tools);
      expect(result.extensions.flatMap((extension) => [...extension.commands.keys()]).includes("mcp")).toBe(mcp);
      expect(result.runtime.pendingVirtualModelRegistrations).toEqual([]);
    }
    expect(upstreamFactory).not.toHaveBeenCalled();
  });

  it("uses project .pi config, deferred discovery, nested hooks and sanitized MCP credentials", async () => {
    const { root } = await setup();
    await fixtureConfig(path.join(root, ".pi"));
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "full"] });
    try {
      host.subscribe((event) => {
        if (event.type === "ui_request" && event.request.method === "confirm" && event.request.title.startsWith("Undo")) {
          host.uiBroker.respond({ requestId: event.request.id, confirmed: true });
        }
      });
      await host.prompt("/mcp");
      const activeTools = host.session.getActiveToolNames();
      expect(activeTools).not.toContain("tool_search");
      expect(host.session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
      expect(host.session.getCallableToolNames()).toContain("mcp__fixture__echo");
      expect(host.session.getAllTools().some((tool) => tool.name.startsWith("mcp__disabled__"))).toBe(false);
      const nested: string[] = [];
      const unsubscribe = host.session.subscribe((event) => {
        if (event.type === "tool_execution_start" && event.parentToolCallId) nested.push(event.parentToolCallId);
      });
      const { text } = await executeCode(host, 'console.log(await searchTools("echo")); console.log(await describeTool("mcp__fixture__echo")); console.log(await tools.mcp__fixture__echo({text:"NATIVE_OK"})); console.log(typeof models);');
      unsubscribe();
      expect(text).toContain("mcp__fixture__echo");
      expect(text).toContain("NATIVE_OK|DEEPSEEK_API_KEY=unset");
      expect(text).toContain("undefined");
      expect(nested).toContain("code-parent");
      expect(host.session.getActiveToolNames()).toEqual(activeTools);
      await host.session.reload();
      await host.prompt("/mcp");
      expect(host.session.getActiveToolNames()).toEqual(activeTools);
      await executeCode(host, 'console.log(await tools.apply_patch({input:"*** Begin Patch\\n*** Add File: nested.txt\\n+checkpoint\\n*** End Patch"}));');
      expect(await fs.readFile(path.join(root, "nested.txt"), "utf8")).toContain("checkpoint");
      await host.prompt("/undo");
      await expect(fs.stat(path.join(root, "nested.txt"))).rejects.toThrow();
    } finally { await host.dispose(); }
  }, 15_000);

  it("lets Pi select codemode's protocol and keeps apply_patch a function across model changes and reload", async () => {
    const { root } = await setup();
    vi.stubEnv("OPENAI_API_KEY", "switch-test-key");
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--no-mcp"] });
    const captureTools = async () => {
      let payload: unknown;
      await streamSimple(host.session.model!, normalizeContext({ messages: [], tools: host.session.agent.state.tools }), {
        apiKey: "test-only-key",
        onPayload(value) {
          payload = value;
          throw new Error("Captured before network request");
        },
      }).result();
      expect(payload).toBeDefined();
      return (payload as { tools: { name: string; type: string }[] }).tools;
    };
    const expectProtocols = async (codemodeType: string) => {
      const tools = await captureTools();
      expect(tools.find((tool) => tool.name === "codemode")).toMatchObject({ type: codemodeType });
      expect(tools.find((tool) => tool.name === "apply_patch"))
        .toMatchObject({ type: "function", parameters: { properties: { input: { type: "string" } } } });
      if (codemodeType === "function") {
        expect(tools.find((tool) => tool.name === "codemode"))
          .toMatchObject({ parameters: { properties: { code: { type: "string" } } } });
      }
    };
    try {
      const deepseek = host.session.model!;
      expect(deepseek.compat).toMatchObject({ supportsOpenAIGrammarTools: false });
      await expectProtocols("function");
      await host.session.setModel({ ...deepseek, provider: "openai", id: "switch-fixture",
        compat: { ...deepseek.compat, supportsOpenAIGrammarTools: true } });
      await expectProtocols("custom");
      await host.session.reload();
      await expectProtocols("custom");
      await host.session.setModel(deepseek);
      await expectProtocols("function");
      await host.session.reload();
      await expectProtocols("function");
    } finally { await host.dispose(); }
  });

  it("restores Pi's saved tool loadout and script store when an HTTP session resumes", async () => {
    const { root, agentDir } = await setup();
    await fixtureConfig(agentDir);
    const first = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "full", "--tools", "read,exec_command,write_stdin,apply_patch,codemode,tool_search"], session: { type: "persistent" } });
    const id = first.session.sessionManager.getSessionId();
    try {
      await first.prompt("/mcp");
      const search = first.session.agent.state.tools.find((tool) => tool.name === "tool_search")!;
      await search.execute("search", { query: "echo" });
      first.session.sessionManager.appendMessage({
        role: "system", content: "", timestamp: Date.now(),
        toolsAdded: first.session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      });
      await executeCode(first, 'store("saved", "RESUMED_STORE_OK");');
    } finally { await first.dispose(); }
    const resumed = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "full"], session: { type: "resume", id } });
    try {
      await resumed.prompt("/mcp");
      const { text } = await executeCode(resumed, 'console.log(await tools.mcp__fixture__echo({text:load("saved")}));');
      expect(text).toContain("RESUMED_STORE_OK");
      expect(resumed.session.getActiveToolNames()).toContain("mcp__fixture__echo");
      expect(resumed.session.getActiveToolNames()).not.toContain("bash");
    } finally { await resumed.dispose(); }
  }, 15_000);

  it.each(["auto", "ask"])("approves server tools but reads resources freely in %s and preserves configured credentials", async (permission) => {
    const { root, agentDir } = await setup();
    await fixtureConfig(agentDir, { DEEPSEEK_API_KEY: "explicit-server-key", FIXTURE_RESOURCES: "1" });
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "full"] });
    try {
      await host.prompt("/mcp");
      expect((await executeCode(host, 'console.log(await tools.mcp__fixture__echo({text:"explicit"}));')).text).toContain("DEEPSEEK_API_KEY=explicit-server-key");
      await host.prompt(`/permissions ${permission}`);
      const pending: string[] = [];
      const unsubscribe = host.subscribe((event) => {
        if (event.type === "ui_request" && event.request.method === "select") {
          pending.push(event.request.title);
          host.uiBroker.respond({ requestId: event.request.id, value: "Deny" });
        }
      });
      const { text } = await executeCode(host, 'await tools.mcp__fixture__echo({text:"deny"});');
      expect(text).toContain("Denied by user");
      expect(pending).toEqual([expect.stringContaining("Tool: mcp__fixture__echo")]);
      expect(pending[0]).toContain("Server: mcp__fixture");
      expect(pending[0]).toContain("Read-only hint: Not provided");
      const approvalsBeforeResources = pending.length;
      const resourceResult = await executeCode(host, 'console.log(await tools.list_mcp_resources({})); console.log(await tools.list_mcp_resource_templates({})); console.log(await tools.read_mcp_resource({server:"fixture",uri:"fixture://note"}));');
      expect(resourceResult.text).toContain("fixture://note");
      expect(resourceResult.text).toContain("resourceTemplates");
      expect(resourceResult.text).toContain("RESOURCE_OK");
      expect(pending).toHaveLength(approvalsBeforeResources);
      unsubscribe();
    } finally { await host.dispose(); }
  }, 15_000);

  it("shares a native MCP grant across concurrent codemode calls and revokes it through /permissions", async () => {
    const { root, agentDir } = await setup();
    await fixtureConfig(agentDir, { FIXTURE_READ_ONLY: "1" });
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "auto"] });
    try {
      await host.prompt("/mcp");
      const pending: string[] = [];
      let choice = "Allow all tools from this server for this session";
      host.subscribe((event) => {
        if (event.type === "ui_request" && event.request.method === "select") {
          pending.push(event.request.title);
          host.uiBroker.respond({ requestId: event.request.id, value: choice });
        }
      });
      const { text } = await executeCode(host, 'console.log(await Promise.all([tools.mcp__fixture__echo({text:"FIRST"}), tools.mcp__fixture__echo({text:"SECOND"})]));');
      expect(text).toContain("FIRST");
      expect(text).toContain("SECOND");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain("Read-only hint: true");
      await host.prompt("/permissions revoke-mcp mcp__fixture");
      choice = "Deny";
      expect((await executeCode(host, 'await tools.mcp__fixture__echo({text:"DENIED"});')).text).toContain("Denied by user");
      expect(pending).toHaveLength(2);
    } finally { await host.dispose(); }
  }, 15_000);
});
