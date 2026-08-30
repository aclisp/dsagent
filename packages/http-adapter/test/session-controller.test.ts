import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionController,
  type HttpActivityPhase,
  type HttpAdapterEvent,
  type HttpAdapterServerHost,
} from "../src/session-controller.js";
import type {
  SessionPortTurnContext,
  SessionPortTurnEvent,
} from "../src/session-port.js";
import type { AgentMessage } from "../src/session-messages.js";
import {
  createHttpUiBroker,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "../src/ui-broker.js";

interface FakeHost extends HttpAdapterServerHost {
  calls: string[];
  abortCount: number;
  disposeCount: number;
  subscribeCount: number;
  unsubscribeCount: number;
  pruneCalls: number;
  uiBroker: HttpUiBroker;
}

interface EventStream {
  next(): Promise<HttpAdapterEvent>;
  close(): void;
}

interface ControllerHarness {
  controller: SessionController;
  host: FakeHost;
  terminalEvents: SessionPortTurnEvent[];
  logErrors: Array<{ bindings: Record<string, unknown>; message: string }>;
}

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFakeHost(options?: {
  output?: string;
  messages?: readonly AgentMessage[];
  prompt?: (message: string) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  abort?: () => Promise<void>;
  dispose?: () => Promise<void>;
  broker?: HttpUiBroker;
}): FakeHost {
  const broker = options?.broker ?? createHttpUiBroker();
  const host: FakeHost = {
    calls: [],
    abortCount: 0,
    disposeCount: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
    pruneCalls: 0,
    uiBroker: broker,
    session: { messages: options?.messages ?? [] },
    async prompt(message) {
      host.calls.push(`prompt:${message}`);
      await options?.prompt?.(message);
      host.calls.push("output");
      return options?.output;
    },
    async waitForIdle() {
      host.calls.push("wait");
      await options?.waitForIdle?.();
    },
    async abort() {
      host.abortCount += 1;
      await options?.abort?.();
    },
    prunePersistedSession() {
      host.pruneCalls += 1;
      return false;
    },
    subscribe(listener: HttpUiBrokerListener) {
      host.subscribeCount += 1;
      const unsubscribe = broker.subscribe(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        host.unsubscribeCount += 1;
        unsubscribe();
      };
    },
    async dispose() {
      host.disposeCount += 1;
      try {
        await options?.dispose?.();
      } finally {
        broker.dispose();
      }
    },
  };
  return host;
}

function createHarness(
  options?: Parameters<typeof createFakeHost>[0],
): ControllerHarness {
  const host = createFakeHost(options);
  const terminalEvents: SessionPortTurnEvent[] = [];
  const logErrors: Array<{
    bindings: Record<string, unknown>;
    message: string;
  }> = [];
  const controller = new SessionController(
    "session-1",
    "main",
    host,
    {
      error(bindings, message) {
        logErrors.push({ bindings, message });
      },
    },
    (event) => terminalEvents.push(event),
  );
  return { controller, host, terminalEvents, logErrors };
}

function startTurn(
  controller: SessionController,
  message: string,
  clientId?: string,
  context?: SessionPortTurnContext,
): { id: string; status: "running" } {
  const turn = controller.startTurn(message, clientId, context);
  if (!turn) throw new Error("Expected the Turn to start");
  return turn;
}

async function openEventStream(
  controller: SessionController,
): Promise<EventStream> {
  const server = Fastify();
  server.get("/events", async (request, reply) =>
    controller.openEventStream(request, reply),
  );
  servers.push(server);

  const abortController = new AbortController();
  const response = await server.inject({
    method: "GET",
    url: "/events",
    payloadAsStream: true,
    signal: abortController.signal,
  });
  const stream = response.stream();
  const events: HttpAdapterEvent[] = [];
  const waiters: Array<(event: HttpAdapterEvent) => void> = [];
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data) as HttpAdapterEvent;
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else events.push(event);
    }
  });

  return {
    next() {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      return new Promise<HttpAdapterEvent>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for SSE event")),
          2000,
        );
        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    close() {
      abortController.abort();
      stream.destroy();
    },
  };
}

async function waitForCall(host: FakeHost, call: string): Promise<void> {
  await vi.waitFor(() => expect(host.calls).toContain(call));
}

async function expectActivity(
  events: EventStream,
  turnId: string,
  phase: HttpActivityPhase,
): Promise<void> {
  expect(await events.next()).toEqual({ type: "activity", turnId, phase });
}

describe("SessionController", () => {
  it("immediately rejects interactive UI requests for headless Turns", async () => {
    const broker = createHttpUiBroker();
    const results: unknown[] = [];
    const observedMethods: string[] = [];
    broker.subscribe((event) => {
      if (event.type === "ui_request") observedMethods.push(event.request.method);
    });
    const harness = createHarness({
      broker,
      prompt: async () => {
        results.push(await broker.uiContext.confirm("Confirm", "Details"));
        results.push(await broker.uiContext.select("Select", ["one", "two"]));
        results.push(await broker.uiContext.input("Input"));
        results.push(await broker.uiContext.editor("Editor"));
      },
    });

    startTurn(harness.controller, "Headless request");

    await vi.waitFor(() => expect(harness.terminalEvents).toHaveLength(1));
    expect(results).toEqual([false, undefined, undefined, undefined]);
    expect(observedMethods).toEqual(["confirm", "select", "input", "editor"]);
    expect(harness.terminalEvents[0]?.status).toBe("completed");
  });

  it("owns the descriptor, messages, and one-active-Turn guard", async () => {
    const promptBlocked = deferred();
    const messages: AgentMessage[] = [
      { role: "user", content: "Previous", timestamp: 1 },
    ];
    const harness = createHarness({
      messages,
      output: "Completed",
      prompt: async () => promptBlocked.promise,
    });

    expect(harness.controller.descriptor).toEqual({
      id: "session-1",
      workspaceId: "main",
      persisted: true,
      status: "idle",
    });
    expect(harness.controller.messages).toBe(messages);

    const turn = startTurn(harness.controller, "First");
    expect(harness.controller.descriptor.status).toBe("running");
    expect(harness.controller.startTurn("Overlap", undefined)).toBeUndefined();

    promptBlocked.resolve();
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
    expect(harness.controller.descriptor.status).toBe("idle");
    expect(harness.terminalEvents).toEqual([
      { status: "completed", turnId: turn.id, output: "Completed" },
    ]);
  });

  it("streams Turn progress and replays only the latest Turn event", async () => {
    const promptBlocked = deferred();
    const harness = createHarness({ prompt: async () => promptBlocked.promise });
    const live = await openEventStream(harness.controller);

    const turn = startTurn(harness.controller, "/status", "browser");
    expect(await live.next()).toEqual({
      type: "turn",
      turnId: turn.id,
      status: "running",
      message: "/status",
      clientId: "browser",
    });

    promptBlocked.resolve();
    expect(await live.next()).toEqual({
      type: "turn",
      turnId: turn.id,
      status: "completed",
      output: null,
    });
    const replay = await openEventStream(harness.controller);
    expect(await replay.next()).toEqual({
      type: "turn",
      turnId: turn.id,
      status: "completed",
      output: null,
    });
    live.close();
    replay.close();
  });

  it("keeps internal IM source context on Port terminal events but out of SSE", async () => {
    const promptBlocked = deferred();
    const harness = createHarness({ prompt: async () => promptBlocked.promise });
    const live = await openEventStream(harness.controller);
    const context: SessionPortTurnContext = {
      source: { type: "im", conversationAlias: "conv-example" },
    };

    const turn = startTurn(harness.controller, "来自 IM", undefined, context);
    expect(await live.next()).toEqual({
      type: "turn",
      turnId: turn.id,
      status: "running",
      message: "来自 IM",
    });

    promptBlocked.resolve();
    expect(await live.next()).toEqual({
      type: "turn",
      turnId: turn.id,
      status: "completed",
      output: null,
    });
    await vi.waitFor(() =>
      expect(harness.terminalEvents).toEqual([
        {
          status: "completed",
          turnId: turn.id,
          output: null,
          context,
        },
      ]),
    );
    live.close();
  });

  it("publishes output for consecutive Turns with identical assistant text", async () => {
    const harness = createHarness({ output: "Same answer" });

    const first = startTurn(harness.controller, "First");
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
    const second = startTurn(harness.controller, "Second");
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(2));

    expect(harness.terminalEvents).toEqual([
      { status: "completed", turnId: first.id, output: "Same answer" },
      { status: "completed", turnId: second.id, output: "Same answer" },
    ]);
  });

  it("publishes failure and releases the Turn guard", async () => {
    let attempts = 0;
    const harness = createHarness({
      output: "Recovered",
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider failed");
      },
    });
    const events = await openEventStream(harness.controller);

    const failed = startTurn(harness.controller, "First");
    expect(await events.next()).toMatchObject({
      type: "turn",
      turnId: failed.id,
      status: "running",
    });
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
    expect(await events.next()).toEqual({
      type: "turn",
      turnId: failed.id,
      status: "failed",
      error: "provider failed",
    });
    expect(harness.terminalEvents[0]).toEqual({
      status: "failed",
      turnId: failed.id,
    });
    expect(harness.logErrors[0]).toMatchObject({
      message: "Agent turn failed",
      bindings: { turnId: failed.id },
    });

    const recovered = startTurn(harness.controller, "Second");
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(2));
    expect(harness.terminalEvents[1]).toEqual({
      status: "completed",
      turnId: recovered.id,
      output: "Recovered",
    });
    events.close();
  });

  it("uses processing for subsequent model turns", async () => {
    const promptBlocked = deferred();
    const broker = createHttpUiBroker();
    const harness = createHarness({
      broker,
      prompt: async () => promptBlocked.promise,
    });
    const events = await openEventStream(harness.controller);
    const turn = startTurn(harness.controller, "Continue this", "browser");

    expect(await events.next()).toMatchObject({
      type: "turn",
      turnId: turn.id,
      status: "running",
    });

    broker.publishSessionEvent({ type: "turn_start" } as AgentSessionEvent);
    await expectActivity(events, turn.id, "reading");

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "First round" },
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "output");
    expect(await events.next()).toMatchObject({
      type: "assistant_text_delta",
      delta: "First round",
    });

    broker.publishSessionEvent({ type: "turn_end" } as AgentSessionEvent);
    broker.publishSessionEvent({ type: "turn_start" } as AgentSessionEvent);
    await expectActivity(events, turn.id, "processing");

    events.close();
    promptBlocked.resolve();
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
  });

  it("derives and replays the current activity phase", async () => {
    const promptBlocked = deferred();
    const broker = createHttpUiBroker();
    const harness = createHarness({
      broker,
      prompt: async () => promptBlocked.promise,
    });
    const events = await openEventStream(harness.controller);
    const turn = startTurn(harness.controller, "Explain this", "browser");

    expect(await events.next()).toMatchObject({
      type: "turn",
      turnId: turn.id,
      status: "running",
    });

    broker.publishSessionEvent({ type: "turn_start" } as AgentSessionEvent);
    await expectActivity(events, turn.id, "reading");

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "thinking");
    expect(await events.next()).toMatchObject({ type: "thinking_start" });

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "output");
    expect(await events.next()).toMatchObject({
      type: "assistant_text_delta",
      delta: "Hello",
    });

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
    } as AgentSessionEvent);
    expect(await events.next()).toMatchObject({ type: "thinking_start" });

    broker.publishSessionEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "executing");
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "started",
      toolCallId: "tool-1",
    });

    broker.publishSessionEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [] },
      isError: false,
    } as AgentSessionEvent);
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "completed",
      toolCallId: "tool-1",
    });

    broker.publishSessionEvent({ type: "turn_end" } as AgentSessionEvent);
    await expectActivity(events, turn.id, "processing");

    broker.publishSessionEvent({ type: "turn_start" } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 2 },
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "thinking");
    expect(await events.next()).toMatchObject({ type: "thinking_start" });

    broker.publishSessionEvent({
      type: "compaction_start",
      reason: "threshold",
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "compaction");
    expect(await events.next()).toMatchObject({ type: "compaction_start" });

    broker.publishSessionEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    await expectActivity(events, turn.id, "processing");
    expect(await events.next()).toMatchObject({ type: "compaction_end" });

    broker.publishSessionEvent({
      type: "agent_end",
      messages: [],
      willRetry: true,
    } as AgentSessionEvent);

    const replay = await openEventStream(harness.controller);
    expect(await replay.next()).toMatchObject({
      type: "turn",
      turnId: turn.id,
      status: "running",
    });
    await expectActivity(replay, turn.id, "processing");

    events.close();
    replay.close();
    promptBlocked.resolve();
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
  });

  it("shares repeated abort attempts and publishes aborted", async () => {
    const promptBlocked = deferred();
    const abortBlocked = deferred();
    const harness = createHarness({
      prompt: async () => promptBlocked.promise,
      abort: async () => abortBlocked.promise,
    });
    const turn = startTurn(harness.controller, "Long task");

    expect(await harness.controller.abortTurn("missing")).toBe("not_found");
    const firstAbort = harness.controller.abortTurn(turn.id);
    await vi.waitFor(() => expect(harness.host.abortCount).toBe(1));
    const repeatedAbort = harness.controller.abortTurn(turn.id);
    expect(harness.controller.descriptor.status).toBe("aborting");

    abortBlocked.resolve();
    await expect(Promise.all([firstAbort, repeatedAbort])).resolves.toEqual([
      "aborting",
      "aborting",
    ]);
    promptBlocked.resolve();
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
    expect(harness.terminalEvents).toEqual([
      { status: "aborted", turnId: turn.id },
    ]);
  });

  it("completes normally when an abort attempt fails after settlement", async () => {
    const promptBlocked = deferred();
    const abortBlocked = deferred();
    const harness = createHarness({
      output: "Finished",
      prompt: async () => promptBlocked.promise,
      abort: async () => abortBlocked.promise,
    });
    const turn = startTurn(harness.controller, "Long task");

    const abortAttempt = harness.controller.abortTurn(turn.id);
    await vi.waitFor(() => expect(harness.host.abortCount).toBe(1));
    promptBlocked.resolve();
    await waitForCall(harness.host, "wait");
    abortBlocked.reject(new Error("abort failed"));

    await expect(abortAttempt).resolves.toBe("failed");
    await vi.waitFor(() => expect(harness.host.pruneCalls).toBe(1));
    expect(harness.terminalEvents).toEqual([
      { status: "completed", turnId: turn.id, output: "Finished" },
    ]);
  });

  it("translates broker events and forwards UI responses", async () => {
    const broker = createHttpUiBroker();
    const harness = createHarness({ broker });
    const events = await openEventStream(harness.controller);

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "internal" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "internal" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "compaction_start",
      reason: "threshold",
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    } as AgentSessionEvent);
    broker.publishExtensionError({
      extensionPath: "extension.ts",
      event: "tool_call",
      error: "Extension failed",
      stack: "hidden",
    });

    expect(await events.next()).toMatchObject({
      type: "assistant_text_delta",
      delta: "Hello",
    });
    expect(await events.next()).toMatchObject({ type: "thinking_start" });
    expect(await events.next()).toMatchObject({ type: "thinking_end" });
    expect(await events.next()).toMatchObject({ type: "compaction_start" });
    expect(await events.next()).toMatchObject({ type: "compaction_end" });
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "started",
      toolCallId: "tool-1",
    });
    expect(await events.next()).toEqual({
      type: "extension_error",
      turnId: null,
      error: {
        extensionPath: "extension.ts",
        event: "tool_call",
        message: "Extension failed",
      },
    });

    let requestId = "";
    broker.subscribe((event) => {
      if (event.type === "ui_request") requestId = event.request.id;
    });
    const confirmation = broker.uiContext.confirm("Continue?", "Details");
    await vi.waitFor(() => expect(requestId).not.toBe(""));
    harness.controller.respond({ requestId, confirmed: true });
    await expect(confirmation).resolves.toBe(true);
    events.close();
  });

  it("closes streams and shares a successful disposal attempt", async () => {
    const disposeBlocked = deferred();
    const harness = createHarness({ dispose: async () => disposeBlocked.promise });
    const events = await openEventStream(harness.controller);

    const first = harness.controller.dispose();
    const repeated = harness.controller.dispose();
    expect(repeated).toBe(first);
    expect(harness.host.abortCount).toBe(1);
    expect(harness.host.unsubscribeCount).toBe(2);

    disposeBlocked.resolve();
    await expect(Promise.all([first, repeated])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(harness.host.disposeCount).toBe(1);
    events.close();
  });
});
