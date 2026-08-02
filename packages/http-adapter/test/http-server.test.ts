import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpAdapterServer,
  type HttpAdapterEvent,
  type HttpAdapterServerHost,
} from "../src/http-server.js";
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
  uiBroker: HttpUiBroker;
}

interface EventStream {
  response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  next(): Promise<HttpAdapterEvent>;
  close(): void;
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
  prompt?: (message: string) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  abort?: () => Promise<void>;
  broker?: HttpUiBroker;
}): FakeHost {
  const broker = options?.broker ?? createHttpUiBroker();
  const host: FakeHost = {
    calls: [],
    abortCount: 0,
    disposeCount: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
    uiBroker: broker,
    session: {
      getLastAssistantText() {
        host.calls.push("output");
        return options?.output;
      },
    },
    async prompt(message) {
      host.calls.push(`prompt:${message}`);
      await options?.prompt?.(message);
    },
    async waitForIdle() {
      host.calls.push("wait");
      await options?.waitForIdle?.();
    },
    async abort() {
      host.abortCount += 1;
      await options?.abort?.();
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
      broker.dispose();
    },
  };
  return host;
}

function createServer(host = createFakeHost()): FastifyInstance {
  const server = createHttpAdapterServer(host);
  servers.push(server);
  return server;
}

async function openEventStream(server: FastifyInstance): Promise<EventStream> {
  const controller = new AbortController();
  const response = await server.inject({
    method: "GET",
    url: "/v1/events",
    payloadAsStream: true,
    signal: controller.signal,
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
    response,
    next() {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      return new Promise<HttpAdapterEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 2000);
        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    close() {
      controller.abort();
      stream.destroy();
    },
  };
}

async function waitForCall(host: FakeHost, call: string): Promise<void> {
  await vi.waitFor(() => expect(host.calls).toContain(call));
}

describe("createHttpAdapterServer", () => {
  it("reports health", async () => {
    const response = await createServer().inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("accepts a turn asynchronously and rejects overlap", async () => {
    const blocked = deferred();
    const host = createFakeHost({
      output: "Completed",
      prompt: async () => blocked.promise,
    });
    const server = createServer(host);

    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Review the repository" },
    });
    const body = accepted.json<{ id: string; status: string }>();
    expect(accepted.statusCode).toBe(202);
    expect(body).toMatchObject({ status: "running" });
    expect(body.id).toEqual(expect.any(String));

    const overlapping = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Second" },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toEqual({ error: "turn_in_progress" });

    blocked.resolve();
    await waitForCall(host, "output");
    const events = await openEventStream(server);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId: body.id,
      status: "completed",
      output: "Completed",
    });
    events.close();

    const next = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Second" },
    });
    expect(next.statusCode).toBe(202);
  });

  it("reports null output after completion", async () => {
    const host = createFakeHost();
    const server = createServer(host);
    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Run a command" },
    });
    const turnId = accepted.json<{ id: string }>().id;
    await waitForCall(host, "output");

    const events = await openEventStream(server);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: null,
    });
    events.close();
  });

  it.each([
    ["missing body", undefined],
    ["missing message", {}],
    ["wrong message type", { message: 1 }],
    ["empty message", { message: "" }],
    ["blank message", { message: "   " }],
    ["extra property", { message: "Hello", extra: true }],
  ])("rejects an invalid turn request: %s", async (_label, payload) => {
    const response = await createServer().inject({
      method: "POST",
      url: "/v1/turns",
      ...(payload !== undefined ? { payload } : {}),
    });

    expect(response.statusCode).toBe(400);
  });

  it("publishes failed turns and releases the guard", async () => {
    let attempts = 0;
    const host = createFakeHost({
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider failed");
      },
    });
    const server = createServer(host);
    const first = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "First" },
    });
    const firstId = first.json<{ id: string }>().id;
    await vi.waitFor(() => expect(attempts).toBe(1));

    const events = await openEventStream(server);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId: firstId,
      status: "failed",
    });
    events.close();

    const recovered = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Second" },
    });
    expect(recovered.statusCode).toBe(202);
    await waitForCall(host, "output");
  });

  it("streams translated assistant, tool, and UI events", async () => {
    const broker = createHttpUiBroker();
    const host = createFakeHost({ broker });
    const events = await openEventStream(createServer(host));

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { text: "Done" },
      isError: false,
    } as AgentSessionEvent);
    broker.uiContext.setStatus("agent", "working");
    broker.publishExtensionError({
      extensionPath: "extension.ts",
      event: "tool_call",
      error: "Extension failed",
      stack: "hidden",
    });

    expect(await events.next()).toEqual({
      type: "assistant_text_delta",
      turnId: null,
      delta: "Hello",
    });
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "started",
      toolCallId: "tool-1",
      name: "read",
    });
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "completed",
      toolCallId: "tool-1",
      isError: false,
    });
    expect(await events.next()).toEqual({
      type: "ui_event",
      turnId: null,
      event: { method: "status", key: "agent", text: "working" },
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
    expect(events.response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );

    events.close();
    await vi.waitFor(() => expect(host.unsubscribeCount).toBe(1));
  });

  it("delivers and resolves a confirmation over HTTP", async () => {
    const broker = createHttpUiBroker();
    let confirmed: boolean | undefined;
    const host = createFakeHost({
      broker,
      output: "Approved",
      prompt: async () => {
        confirmed = await broker.uiContext.confirm("Apply patch?", "src/auth.ts");
      },
    });
    const server = createServer(host);
    const events = await openEventStream(server);
    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Apply the fix" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    expect(await events.next()).toEqual({ type: "turn", turnId, status: "running" });
    const requestEvent = await events.next();
    expect(requestEvent).toMatchObject({
      type: "ui_request",
      turnId,
      request: { method: "confirm", title: "Apply patch?" },
    });
    if (requestEvent.type !== "ui_request") throw new Error("Missing UI request");

    const invalid = await server.inject({
      method: "POST",
      url: `/v1/ui-requests/${requestEvent.request.id}/responses`,
      payload: { value: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_ui_response" });

    const response = await server.inject({
      method: "POST",
      url: `/v1/ui-requests/${requestEvent.request.id}/responses`,
      payload: { confirmed: true },
    });
    expect(response.statusCode).toBe(204);
    expect(confirmed).toBe(true);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: "Approved",
    });
    events.close();
  });

  it("accepts value and cancellation responses and rejects unknown requests", async () => {
    const broker = createHttpUiBroker();
    const server = createServer(createFakeHost({ broker }));
    let requestId = "";
    broker.subscribe((event) => {
      if (event.type === "ui_request") requestId = event.request.id;
    });

    const selection = broker.uiContext.select("Database", ["SQLite", "PostgreSQL"]);
    const invalid = await server.inject({
      method: "POST",
      url: `/v1/ui-requests/${requestId}/responses`,
      payload: { value: "MySQL" },
    });
    expect(invalid.statusCode).toBe(400);

    const selected = await server.inject({
      method: "POST",
      url: `/v1/ui-requests/${requestId}/responses`,
      payload: { value: "SQLite" },
    });
    expect(selected.statusCode).toBe(204);
    await expect(selection).resolves.toBe("SQLite");

    const input = broker.uiContext.input("Name");
    const cancelled = await server.inject({
      method: "POST",
      url: `/v1/ui-requests/${requestId}/responses`,
      payload: { cancelled: true },
    });
    expect(cancelled.statusCode).toBe(204);
    await expect(input).resolves.toBeUndefined();

    const missing = await server.inject({
      method: "POST",
      url: "/v1/ui-requests/missing/responses",
      payload: { confirmed: true },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "ui_request_not_found" });
  });

  it.each([
    {},
    { confirmed: "yes" },
    { cancelled: false },
    { value: "yes", confirmed: true },
    { value: "yes", extra: true },
  ])("rejects an invalid UI response body", async (payload) => {
    const response = await createServer().inject({
      method: "POST",
      url: "/v1/ui-requests/request/responses",
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_ui_response" });
  });

  it("aborts the active turn idempotently", async () => {
    const promptBlocked = deferred();
    const abortBlocked = deferred();
    const host = createFakeHost({
      prompt: async () => promptBlocked.promise,
      abort: async () => abortBlocked.promise,
    });
    const server = createServer(host);
    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Long task" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    const firstAbort = server.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/abort`,
    });
    await vi.waitFor(() => expect(host.abortCount).toBe(1));
    const repeated = server.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/abort`,
    });
    expect(host.abortCount).toBe(1);

    abortBlocked.resolve();
    expect((await firstAbort).statusCode).toBe(202);
    expect((await repeated).statusCode).toBe(202);
    promptBlocked.resolve();
    await waitForCall(host, "wait");
    const events = await openEventStream(server);
    expect(await events.next()).toEqual({ type: "turn", turnId, status: "aborted" });
    events.close();

    const unknown = await server.inject({
      method: "POST",
      url: "/v1/turns/missing/abort",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("restores a running turn after abort fails", async () => {
    const promptBlocked = deferred();
    let abortAttempts = 0;
    const host = createFakeHost({
      prompt: async () => promptBlocked.promise,
      abort: async () => {
        abortAttempts += 1;
        if (abortAttempts === 1) throw new Error("abort failed");
      },
    });
    const server = createServer(host);
    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Long task" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    const failed = await server.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/abort`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "turn_abort_failed" });

    const retried = await server.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/abort`,
    });
    expect(retried.statusCode).toBe(202);
    expect(abortAttempts).toBe(2);
    promptBlocked.resolve();
  });

  it("does not report an aborted turn when abort fails after settlement", async () => {
    const promptBlocked = deferred();
    const abortBlocked = deferred();
    let abortAttempts = 0;
    const host = createFakeHost({
      output: "Finished",
      prompt: async () => promptBlocked.promise,
      abort: async () => {
        abortAttempts += 1;
        if (abortAttempts === 1) await abortBlocked.promise;
      },
    });
    const server = createServer(host);
    const accepted = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Long task" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    const abortRequest = server.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/abort`,
    });
    await vi.waitFor(() => expect(host.abortCount).toBe(1));
    promptBlocked.resolve();
    await waitForCall(host, "wait");
    abortBlocked.reject(new Error("abort failed"));

    expect((await abortRequest).statusCode).toBe(500);
    await waitForCall(host, "output");
    const events = await openEventStream(server);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: "Finished",
    });
    events.close();
  });

  it("closes event streams before aborting and disposing the host", async () => {
    const host = createFakeHost();
    const server = createServer(host);
    const events = await openEventStream(server);

    await server.close();
    await server.close();

    expect(events.response.statusCode).toBe(200);
    expect(host.subscribeCount).toBe(1);
    expect(host.unsubscribeCount).toBe(1);
    expect(host.abortCount).toBe(1);
    expect(host.disposeCount).toBe(1);
  });
});
