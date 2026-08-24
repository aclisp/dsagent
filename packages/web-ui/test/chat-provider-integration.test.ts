import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_REPLY,
  type ChatDeliveryResult,
  type ChatMessageHandlingResult,
  type InboundGroupMessage,
} from "@thinkany/dscode-chat-client";
import {
  createHttpUiBroker,
  type HttpAdapterHostFactoryOptions,
  type HttpAdapterServerHost,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "@thinkany/dscode-http-adapter";
import type { WebUiChatProvider } from "../src/chat-provider.js";
import { createWebUiServer } from "../src/web-ui-server.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledHost implements HttpAdapterServerHost {
  readonly session = { messages: [] };
  readonly uiBroker: HttpUiBroker = createHttpUiBroker();
  readonly prompts: string[] = [];
  private readonly pendingOutputs: Array<Deferred<string | undefined>> = [];

  prompt(message: string): Promise<string | undefined> {
    this.prompts.push(message);
    const output = deferred<string | undefined>();
    this.pendingOutputs.push(output);
    return output.promise;
  }

  async waitForIdle(): Promise<void> {}

  async abort(): Promise<void> {}

  prunePersistedSession(): boolean {
    return false;
  }

  subscribe(listener: HttpUiBrokerListener): () => void {
    return this.uiBroker.subscribe(listener);
  }

  async dispose(): Promise<void> {
    this.uiBroker.dispose();
  }

  completeNext(output: string | undefined): void {
    const pending = this.pendingOutputs.shift();
    if (!pending) throw new Error("No pending Turn");
    pending.resolve(output);
  }
}

class FakeChatProvider implements WebUiChatProvider {
  readonly groupChatId = "bound-group";
  readonly replies: Array<{ messageId: string; text: string }> = [];
  readonly sends: Array<{ groupChatId: string; text: string }> = [];
  private readonly listeners = new Set<
    (message: InboundGroupMessage) => Promise<ChatMessageHandlingResult>
  >();

  subscribe(
    listener: (
      message: InboundGroupMessage,
    ) => Promise<ChatMessageHandlingResult>,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(message: InboundGroupMessage): Promise<ChatMessageHandlingResult> {
    const listener = this.listeners.values().next().value;
    if (!listener) throw new Error("Chat Provider is not bound");
    return listener(message);
  }

  async reply(messageId: string, text: string): Promise<ChatDeliveryResult> {
    this.replies.push({ messageId, text });
    return { status: "delivered" };
  }

  async send(groupChatId: string, text: string): Promise<ChatDeliveryResult> {
    this.sends.push({ groupChatId, text });
    return { status: "delivered" };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Harness {
  server: FastifyInstance;
  provider?: FakeChatProvider;
  hosts: ControlledHost[];
  factoryCalls: HttpAdapterHostFactoryOptions[];
  listCalls: string[];
  workspaces: Record<string, string>;
}

const servers: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createHarness(
  withProvider: boolean,
  scheduleSource?: string,
): Promise<Harness> {
  const provider = withProvider ? new FakeChatProvider() : undefined;
  const hosts: ControlledHost[] = [];
  const factoryCalls: HttpAdapterHostFactoryOptions[] = [];
  const listCalls: string[] = [];
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dscode-web-ui-"));
  temporaryDirectories.push(workspaceRoot);
  const workspaces = {
    first_workspace_01: path.join(workspaceRoot, "first"),
    second_workspace_02: path.join(workspaceRoot, "second"),
  };
  if (scheduleSource !== undefined) {
    const scheduleDirectory = path.join(workspaces.first_workspace_01, ".dscode");
    await mkdir(scheduleDirectory, { recursive: true });
    await writeFile(path.join(scheduleDirectory, "schedules.yaml"), scheduleSource);
  }
  const server = await createWebUiServer({
    workspaces,
    chatAgentName: "Steve Code",
    maxUploadBytes: 1024,
    timezone: "Asia/Shanghai",
    logger: false,
    requireWorkspaceIdForSessionList: true,
    createHost: async (options) => {
      factoryCalls.push(options);
      const host = new ControlledHost();
      hosts.push(host);
      return host;
    },
    listPersistedSessions: async (cwd) => {
      listCalls.push(cwd);
      return [];
    },
    ...(provider !== undefined ? { chatProvider: provider } : {}),
  });
  await server.ready();
  servers.push(server);
  return {
    server,
    hosts,
    factoryCalls,
    listCalls,
    workspaces,
    ...(provider !== undefined ? { provider } : {}),
  };
}

function inbound(
  overrides: Partial<InboundGroupMessage> = {},
): InboundGroupMessage {
  return {
    dedupeKey: "event-1",
    groupChatId: "bound-group",
    messageId: "message-1",
    senderName: "张三",
    text: "检查当前工作",
    ...overrides,
  };
}

async function activeSessionId(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: "GET",
    url: "/v1/sessions?workspaceId=first_workspace_01",
  });
  expect(response.statusCode).toBe(200);
  const entry = response.json<{
    sessions: Array<{
      active: boolean;
      session: { id: string; status?: string } | null;
    }>;
  }>().sessions[0];
  if (!entry?.active || !entry.session) throw new Error("Session is not active");
  return entry.session.id;
}

async function waitForSessionIdle(server: FastifyInstance): Promise<void> {
  await vi.waitFor(async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/sessions?workspaceId=first_workspace_01",
    });
    expect(response.json().sessions[0].session.status).toBe("idle");
  });
}

describe("Web UI Server Chat Provider composition", () => {
  it("delivers a scheduled group Turn through the bound Headless Chat Client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const harness = await createHarness(
      true,
      `version: 1
tasks:
  - id: scheduled-report
    enabled: true
    type: once
    at: "2026-08-24T12:00:01Z"
    delivery: group
    prompt: 生成定时总结
`,
    );
    const provider = harness.provider;
    if (!provider) throw new Error("Missing Fake Chat Provider");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.hosts).toHaveLength(1));
    const host = harness.hosts[0];
    if (!host) throw new Error("Session Host was not created");
    expect(host.prompts).toEqual([
      "[Scheduled task: scheduled-report]\n\n生成定时总结",
    ]);

    host.completeNext("定时总结结果");
    await vi.waitFor(() =>
      expect(provider.sends).toEqual([
        { groupChatId: "bound-group", text: "定时总结结果" },
      ]),
    );
  });

  it("runs Provider and browser Turns through the same in-process Session", async () => {
    const harness = await createHarness(true);
    const provider = harness.provider;
    if (!provider) throw new Error("Missing Fake Chat Provider");

    expect(provider.listenerCount).toBe(1);
    expect(harness.factoryCalls).toEqual([]);
    expect(harness.listCalls).toEqual([]);

    await expect(
      provider.emit(inbound({ groupChatId: "another-group" })),
    ).resolves.toEqual({ status: "ignored" });
    expect(harness.factoryCalls).toEqual([]);

    const accepted = await provider.emit(inbound());
    expect(accepted).toMatchObject({ status: "accepted" });
    expect(harness.factoryCalls).toHaveLength(1);
    expect(harness.factoryCalls[0]?.cwd).toBe(harness.workspaces.first_workspace_01);
    expect(harness.listCalls).toEqual([harness.workspaces.first_workspace_01]);
    const host = harness.hosts[0];
    if (!host) throw new Error("Session Host was not created");
    expect(host.prompts).toEqual([
      "[Group message from 张三]\n\n检查当前工作",
    ]);

    await expect(
      provider.emit(
        inbound({ dedupeKey: "event-2", messageId: "message-2" }),
      ),
    ).resolves.toEqual({ status: "busy" });
    expect(provider.replies).toEqual([
      { messageId: "message-2", text: BUSY_REPLY },
    ]);

    host.completeNext("群聊结果");
    await vi.waitFor(() =>
      expect(provider.replies).toContainEqual({
        messageId: "message-1",
        text: "群聊结果",
      }),
    );
    await waitForSessionIdle(harness.server);

    const sessionId = await activeSessionId(harness.server);
    const browserTurn = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      payload: { message: "浏览器请求" },
    });
    expect(browserTurn.statusCode).toBe(202);
    expect(host.prompts).toEqual([
      "[Group message from 张三]\n\n检查当前工作",
      "浏览器请求",
    ]);

    host.completeNext("浏览器结果");
    await waitForSessionIdle(harness.server);
    expect(provider.replies).toHaveLength(2);
    expect(provider.sends).toEqual([]);
    expect(harness.factoryCalls).toHaveLength(1);
  });

  it("keeps Provider binding optional, route-neutral, and tied to Server lifetime", async () => {
    const withoutProvider = await createHarness(false);
    const withProvider = await createHarness(true);
    const provider = withProvider.provider;
    if (!provider) throw new Error("Missing Fake Chat Provider");

    expect(withProvider.server.printRoutes()).toBe(
      withoutProvider.server.printRoutes(),
    );
    expect(withProvider.factoryCalls).toEqual([]);
    expect(provider.listenerCount).toBe(1);

    await withProvider.server.close();
    expect(provider.listenerCount).toBe(0);
    await expect(provider.emit(inbound())).rejects.toThrow("not bound");
  });
});
