import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistedSessionAlreadyExistsError,
  PersistedSessionNotFoundError,
  createAgentSessionHost,
  parseHttpRuntimeArgs,
} from "../src/agent-session-host.js";
import { createHttpUiBroker, type HttpUiBrokerEvent } from "../src/ui-broker.js";

const ENV_KEYS = [
  "DSCODE_HOME",
  "DSCODE_SESSIONS_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "DSCODE_PERMISSION",
] as const;
const originalEnvironment = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createAgentSessionHost", { concurrent: false }, () => {
  it("creates and disposes an in-process DSCode session without provider calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    const broker = createHttpUiBroker();
    const events: HttpUiBrokerEvent[] = [];
    const host = await createAgentSessionHost({
      cwd: workspace,
      runtimeArgs: [
        "--provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
        "--effort",
        "high",
        "--permission",
        "auto",
      ],
      uiBroker: broker,
    });
    host.subscribe((event) => events.push(event));

    try {
      expect(host.session.model).toMatchObject({
        provider: "deepseek",
        id: "deepseek-v4-flash",
      });
      expect(host.session.sessionManager.isPersisted()).toBe(false);
      expect(host.session.extensionRunner.hasUI()).toBe(true);
      expect(host.session.getActiveToolNames()).toEqual(
        ["read", "exec_command", "write_stdin", "apply_patch"],
      );
      expect(host.session.getAllTools().some((tool) => tool.name === "update_plan")).toBe(false);
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "status",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "title",
        ),
      ).toBe(true);
      for (const [prompt, command] of [
        ["/clear", "clear"],
        ["/plan", "plan"],
        ["/plan show", "plan"],
        ["/plan clear", "plan"],
        ["/base-url", "base-url"],
        ["/base-url https://example.com", "base-url"],
        ["/agents", "agents"],
        ["  /AGENTS", "agents"],
      ] as const) {
        await expect(host.prompt(prompt)).rejects.toThrow(
          `Session command /${command} is not supported`,
        );
      }
      const activeTools = host.session.getActiveToolNames();
      const entriesBefore = host.session.sessionManager.getEntries().length;
      for (const prompt of ["/permissions plan", " /PERMISSIONS  PLAN ", "/permissions\tplan"]) {
        await expect(host.prompt(prompt)).rejects.toThrow("Plan permission is not supported");
      }
      expect(host.session.getActiveToolNames()).toEqual(activeTools);
      expect(host.session.sessionManager.getEntries()).toHaveLength(entriesBefore);
      await host.prompt("/permissions");
      await host.prompt("/permissions invalid");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ui_event",
          event: expect.objectContaining({ message: expect.stringContaining("available modes: ask|auto|full") }),
        }),
        expect.objectContaining({
          type: "ui_event",
          event: expect.objectContaining({ message: "Expected /permissions ask|auto|full" }),
        }),
      ]));
      await host.prompt("/permissions ask");
      await host.prompt("/permissions auto");
      await expect(host.prompt("/status")).resolves.toBeUndefined();
      await expect(host.prompt("/doctor")).resolves.toBeUndefined();

      const firstDispose = host.dispose();
      const secondDispose = host.dispose();
      expect(secondDispose).toBe(firstDispose);
      await firstDispose;
      await expect(host.prompt("Do not run")).rejects.toThrow("disposed");
    } finally {
      await host.dispose();
    }
  });

  it("aborts an in-flight manual compaction and preserves session history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-compaction-"));
    temporaryRoots.push(root);
    const home = path.join(root, "home");
    process.env.DSCODE_HOME = home;
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({
      compaction: { keepRecentTokens: 16 },
    }));

    const host = await createAgentSessionHost({
      cwd: root,
      runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-v4-flash", "--no-mcp"],
    });
    const stream = createAssistantMessageEventStream();
    let finishRequest: (() => void) | undefined;
    let compaction: Promise<unknown> | undefined;
    let abort: Promise<void> | undefined;
    try {
      const session = host.session;
      const model = session.model!;
      await session.modelRuntime.setRuntimeApiKey(model.provider, "test-only-key");
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Earlier investigation and decisions. ".repeat(20) }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const manager = session.sessionManager;
      manager.appendMessage({ role: "user", content: "Investigate the cancellation bug", timestamp: 1 });
      manager.appendMessage(assistant);
      manager.appendMessage({ role: "user", content: "Keep the latest request", timestamp: 3 });
      session.agent.state.messages = manager.buildSessionContext().messages;
      const entriesBefore = structuredClone(manager.getEntries());
      const messagesBefore = structuredClone(session.messages);
      const events: HttpUiBrokerEvent[] = [];
      host.subscribe((event) => events.push(event));

      let requestSignal: AbortSignal | undefined;
      finishRequest = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...assistant, content: [], stopReason: "aborted" },
        });
      };
      const providerAbort = vi.fn(finishRequest);
      session.agent.streamFunction = (_model, _context, options) => {
        requestSignal = options?.signal;
        requestSignal?.addEventListener("abort", providerAbort, { once: true });
        // Stay pending until the real session cancellation reaches the provider boundary.
        return stream;
      };
      // Handle rejection immediately, even if an assertion fails before aborting.
      compaction = session.compact().then(() => undefined, (error: unknown) => error);
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      expect(requestSignal!.aborted).toBe(false);
      expect(session.isCompacting).toBe(true);
      expect(session.isIdle).toBe(false);

      abort = host.abort();
      await vi.waitFor(() => expect(providerAbort).toHaveBeenCalledOnce());
      expect(requestSignal!.aborted).toBe(true);
      await abort;
      expect(await compaction).toEqual(new Error("Compaction cancelled"));
      expect(session.isCompacting).toBe(false);
      expect(session.isIdle).toBe(true);
      await host.waitForIdle();
      expect(manager.getEntries()).toEqual(entriesBefore);
      expect(session.messages).toEqual(messagesBefore);
      expect(events.filter((event) => event.type === "session" &&
        (event.event.type === "compaction_start" || event.event.type === "compaction_end")))
        .toEqual([
          { type: "session", event: { type: "compaction_start", reason: "manual" } },
          { type: "session", event: expect.objectContaining({
            type: "compaction_end", reason: "manual", aborted: true, willRetry: false,
          }) },
        ]);
    } finally {
      // Release the request even if abort() regresses, so failed tests cannot hang teardown.
      host.session.abortCompaction();
      finishRequest?.();
      await Promise.all([compaction, abort]);
      await host.dispose();
    }
  });

  it("creates and resumes a persistent session without changing process cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = sessionsDir;
    const originalCwd = process.cwd();
    const sessionId = "0193f4ca-7d8b-7000-8000-000000000001";

    const first = await createAgentSessionHost({
      cwd: workspace,
      session: { type: "persistent", id: sessionId },
    });
    try {
      const manager = first.session.sessionManager;
      const model = first.session.model;
      if (!model) throw new Error("Missing session model");
      expect(manager.isPersisted()).toBe(true);
      expect(manager.getSessionId()).toBe(sessionId);
      expect(manager.getSessionDir()).toBe(sessionsDir);
      manager.appendCustomEntry("dscode-permission", { permission: "plan" });
      manager.appendCustomEntry("dscode-plan-state", {
        steps: [{ step: "Historical plan", status: "pending" }],
        revision: 1,
        updatedAt: "2026-09-07T00:00:00.000Z",
      });
      manager.appendMessage({ role: "user", content: "Remember this", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Remembered" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      expect((await fs.stat(manager.getSessionFile()!)).isFile()).toBe(true);
    } finally {
      await first.dispose();
    }

    await expect(
      createAgentSessionHost({
        cwd: workspace,
        session: { type: "persistent", id: sessionId },
      }),
    ).rejects.toBeInstanceOf(PersistedSessionAlreadyExistsError);

    const resumed = await createAgentSessionHost({
      cwd: workspace,
      runtimeArgs: ["--permission", "auto"],
      session: { type: "resume", id: sessionId },
    });
    try {
      expect(resumed.session.sessionManager.getSessionId()).toBe(sessionId);
      expect(resumed.session.getActiveToolNames()).toContain("apply_patch");
      expect(resumed.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
        expect.objectContaining({ customType: "dscode-permission", data: { permission: "plan" } }),
        expect.objectContaining({ customType: "dscode-plan-state" }),
      ]));
      expect(
        resumed.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message"),
      ).toHaveLength(2);
      expect(resumed.session.sessionManager.buildSessionContext().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Remember this" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      await resumed.dispose();
    }
  });

  it("rejects an unknown persistent session ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    await expect(
      createAgentSessionHost({
        cwd: workspace,
        session: { type: "resume", id: "missing" },
      }),
    ).rejects.toBeInstanceOf(PersistedSessionNotFoundError);
  });

  it("rejects CLI-only arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    await expect(
      createAgentSessionHost({ cwd: root, runtimeArgs: ["--thinking", "high"] }),
    ).rejects.toThrow("Unsupported direct session argument");
  });

  it("rejects final plan configuration before creating a host, without downgrading", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-plan-"));
    temporaryRoots.push(root);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");
    for (const runtimeArgs of [["--permission", "plan"], ["--permission=plan"]]) {
      await expect(createAgentSessionHost({ cwd: root, runtimeArgs }))
        .rejects.toThrow("Plan permission is not supported");
    }
    expect(parseHttpRuntimeArgs(["--prompt-contract", "none"], root).options.promptContract)
      .toBe("none");
    process.env.DSCODE_PERMISSION = "plan";
    await expect(createAgentSessionHost({ cwd: root }))
      .rejects.toThrow("Plan permission is not supported");
    await expect(fs.access(process.env.DSCODE_HOME)).rejects.toMatchObject({ code: "ENOENT" });
    for (const permission of ["ask", "auto", "full"]) {
      expect(parseHttpRuntimeArgs(["--permission", permission, "--sandbox", "read-only"], root).options)
        .toMatchObject({ permission, sandbox: "read-only" });
    }
    expect(parseHttpRuntimeArgs(["--permission=plan", "--permission=auto"], root).options.permission)
      .toBe("auto");
  });

  it("rejects update_plan tool selection but keeps --no-tools dominant", () => {
    expect(() => parseHttpRuntimeArgs(["--tools", "read,update_plan"]))
      .toThrow("update_plan tool is not supported");
    expect(parseHttpRuntimeArgs(["--no-tools", "--tools", "update_plan"]).options.activeTools).toEqual([]);
    expect(parseHttpRuntimeArgs(["--no-mcp"]).options.noMcp).toBe(true);
  });

  it.each([
    { runtimeArgs: [], expected: ["read", "exec_command", "write_stdin", "apply_patch", "mcp__fixture__echo"] },
    { runtimeArgs: ["--tools", "read,exec_command,write_stdin,apply_patch"], expected: ["read", "exec_command", "write_stdin", "apply_patch", "mcp__fixture__echo"] },
    { runtimeArgs: ["--no-mcp", "--tools", "read,mcp__fixture__echo"], expected: ["read"] },
    { runtimeArgs: ["--no-tools", "--tools", "read,mcp__fixture__echo"], expected: [] },
  ])(
    "applies MCP selection in a real HTTP session ($runtimeArgs)", async ({ runtimeArgs, expected }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-mcp-"));
      temporaryRoots.push(root);
      const home = path.join(root, "home");
      process.env.DSCODE_HOME = home;
      process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: {
        fixture: { command: process.execPath, args: [path.resolve(import.meta.dirname, "../../../test/fixtures/mcp-server.mjs")] },
      } }));
      const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--permission", "full", ...runtimeArgs] });
      try {
        const events: HttpUiBrokerEvent[] = [];
        host.subscribe((event) => events.push(event));
        await host.prompt("/mcp");
        expect(host.session.getActiveToolNames(), JSON.stringify(events)).toEqual(expected);
        if (expected.includes("mcp__fixture__echo")) {
          const tool = host.session.agent.state.tools.find((tool) => tool.name === "mcp__fixture__echo")!;
          const result = await tool.execute("test-mcp", { text: "http" });
          expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("http|") });
        } else {
          expect(host.session.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
        }
      } finally {
        await host.dispose();
      }
    },
  );
});
