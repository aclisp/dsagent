import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROUP_BUSY_REPLY,
  type ChatDeliveryResult,
  type ChatConversation,
  type ChatMessageHandlingResult,
  type ChatProvider,
  type ChatProviderListener,
  type ChatReplyTarget,
  type InboundChatMessage,
} from "@thinkany/dscode-chat-client";
import {
  createHttpUiBroker,
  type HttpAdapterHostFactoryOptions,
  type HttpAdapterServerHost,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "@thinkany/dscode-http-adapter";
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

class FakeChatProvider implements ChatProvider {
  readonly providerId: string;
  readonly replies: Array<{ target: ChatReplyTarget; text: string }> = [];
  readonly sends: Array<{ conversation: ChatConversation; text: string }> = [];
  startCalls = 0;
  disposeCalls = 0;
  private readonly listeners = new Set<ChatProviderListener>();

  constructor(
    providerId = "fake",
    private readonly startFailure?: Error,
  ) {
    this.providerId = providerId;
  }

  subscribe(listener: ChatProviderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(message: InboundChatMessage): Promise<ChatMessageHandlingResult> {
    const listener = this.listeners.values().next().value;
    if (!listener) throw new Error("Chat Provider is not bound");
    return listener(message);
  }

  async reply(target: ChatReplyTarget, text: string): Promise<ChatDeliveryResult> {
    this.replies.push({ target, text });
    return { status: "delivered" };
  }

  async send(
    conversation: ChatConversation,
    text: string,
  ): Promise<ChatDeliveryResult> {
    this.sends.push({ conversation, text });
    return { status: "delivered" };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  start(): void {
    this.startCalls += 1;
    if (this.startFailure) throw this.startFailure;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

interface Harness {
  server: FastifyInstance;
  provider?: FakeChatProvider;
  providers: FakeChatProvider[];
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
  additionalProviders: FakeChatProvider[] = [],
  persistedSourceAlias?: string,
): Promise<Harness> {
  const provider = withProvider ? new FakeChatProvider() : undefined;
  const providers = [
    ...(provider === undefined ? [] : [provider]),
    ...additionalProviders,
  ];
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
    if (persistedSourceAlias !== undefined) {
      await writeFile(
        path.join(scheduleDirectory, "conversations.json"),
        JSON.stringify({
          version: 1,
          conversations: [
            {
              alias: persistedSourceAlias,
              providerId: "fake",
              type: "group",
              address: "fake-bound-group",
            },
          ],
          senders: [],
        }),
      );
      await writeFile(
        path.join(scheduleDirectory, "schedules.status.json"),
        JSON.stringify({
          version: 1,
          timezone: "Asia/Shanghai",
          tasks: [
            {
              id: "scheduled-report",
              definitionHash: "persisted-source-baseline",
              delivery: "source",
              sourceAlias: persistedSourceAlias,
            },
          ],
        }),
      );
    }
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
    ...(providers.length === 1
      ? { chatProvider: providers[0] }
      : providers.length > 1
        ? { chatProviders: providers }
        : {}),
  });
  await server.ready();
  servers.push(server);
  return {
    server,
    hosts,
    factoryCalls,
    listCalls,
    workspaces,
    providers,
    ...(provider !== undefined ? { provider } : {}),
  };
}

function inbound(
  overrides: Partial<InboundChatMessage> = {},
): InboundChatMessage {
  return {
    dedupeKey: "event-1",
    messageId: "message-1",
    conversation: {
      providerId: "fake",
      type: "group",
      address: "fake-bound-group",
    },
    sender: { providerId: "fake", address: "user-1" },
    text: "检查当前工作",
    ...overrides,
  };
}

function providerInbound(
  providerId: string,
  overrides: Partial<InboundChatMessage> = {},
): InboundChatMessage {
  return {
    dedupeKey: `${providerId}-event-1`,
    messageId: `${providerId}-message-1`,
    conversation: {
      providerId,
      type: "group",
      address: `${providerId}-bound-group`,
    },
    sender: { providerId, address: `${providerId}-user-1` },
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
  it("delivers a source scheduled Turn through the bound Provider conversation", async () => {
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
    delivery: source
    prompt: 生成定时总结
`,
      [],
      "conv-scheduled-source",
    );
    const provider = harness.provider;
    if (!provider) throw new Error("Missing Fake Chat Provider");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.hosts).toHaveLength(1));
    const host = harness.hosts[0];
    if (!host) throw new Error("Session Host was not created");
    expect(host.prompts).toEqual([
      expect.stringMatching(
        /^\[Scheduled task: scheduled-report; source=conv-scheduled-source\]\n\n生成定时总结$/,
      ),
    ]);

    host.completeNext("定时总结结果");
    await vi.waitFor(() =>
      expect(provider.sends).toEqual([
        {
          conversation: {
            providerId: "fake",
            type: "group",
            address: "fake-bound-group",
          },
          text: "定时总结结果",
        },
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
      provider.emit(
        inbound({
          dedupeKey: "other-event",
          messageId: "other-message",
          conversation: {
            providerId: "fake",
            type: "group",
            address: "another-group",
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(harness.factoryCalls).toHaveLength(1);

    const accepted = await provider.emit(
      inbound({ dedupeKey: "event-2", messageId: "message-2" }),
    );
    expect(accepted).toEqual({ status: "busy" });
    expect(harness.factoryCalls).toHaveLength(1);
    expect(harness.factoryCalls[0]?.cwd).toBe(harness.workspaces.first_workspace_01);
    expect(harness.listCalls).toEqual([harness.workspaces.first_workspace_01]);
    const host = harness.hosts[0];
    if (!host) throw new Error("Session Host was not created");
    expect(host.prompts[0]).toMatch(
      /^\[IM message: group=conv-[a-z0-9-]+; sender=sender-[a-z0-9-]+\]\n\n检查当前工作$/,
    );

    expect(provider.replies).toEqual([
      {
        target: {
          messageId: "message-2",
          conversation: {
            providerId: "fake",
            type: "group",
            address: "fake-bound-group",
          },
        },
        text: GROUP_BUSY_REPLY,
      },
    ]);

    host.completeNext("另一个群聊结果");
    await vi.waitFor(() =>
      expect(provider.replies).toContainEqual({
        target: {
          messageId: "other-message",
          conversation: {
            providerId: "fake",
            type: "group",
            address: "another-group",
          },
        },
        text: "另一个群聊结果",
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
      expect.stringMatching(
        /^\[IM message: group=conv-[a-z0-9-]+; sender=sender-[a-z0-9-]+\]\n\n检查当前工作$/,
      ),
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
    expect(provider.startCalls).toBe(1);

    await withProvider.server.close();
    expect(provider.listenerCount).toBe(0);
    expect(provider.disposeCalls).toBe(1);
    await expect(provider.emit(inbound())).rejects.toThrow("not bound");
  });

  it("composes multiple Providers over one Session and keeps reply targets isolated", async () => {
    const secondProvider = new FakeChatProvider("second");
    const harness = await createHarness(true, undefined, [secondProvider]);
    const firstProvider = harness.provider;
    if (!firstProvider) throw new Error("Missing first Fake Chat Provider");

    expect(harness.providers).toHaveLength(2);
    expect(firstProvider.listenerCount).toBe(1);
    expect(secondProvider.listenerCount).toBe(1);

    await expect(firstProvider.emit(inbound())).resolves.toMatchObject({
      status: "accepted",
    });
    const secondResult = await secondProvider.emit(
      providerInbound("second"),
    );
    expect(secondResult).toEqual({ status: "busy" });
    expect(secondProvider.replies).toEqual([
      {
        target: {
          messageId: "second-message-1",
          conversation: {
            providerId: "second",
            type: "group",
            address: "second-bound-group",
          },
        },
        text: GROUP_BUSY_REPLY,
      },
    ]);

    const host = harness.hosts[0];
    if (!host) throw new Error("Session Host was not created");
    host.completeNext("第一个 Provider 的结果");
    await vi.waitFor(() =>
      expect(firstProvider.replies).toContainEqual({
        target: {
          messageId: "message-1",
          conversation: {
            providerId: "fake",
            type: "group",
            address: "fake-bound-group",
          },
        },
        text: "第一个 Provider 的结果",
      }),
    );
    expect(secondProvider.replies).toHaveLength(1);
  });

  it("isolates a Provider startup failure while keeping other Providers and HTTP alive", async () => {
    const failingProvider = new FakeChatProvider(
      "broken",
      new Error("connection failed"),
    );
    const harness = await createHarness(true, undefined, [failingProvider]);
    const workingProvider = harness.provider;
    if (!workingProvider) throw new Error("Missing working Fake Chat Provider");

    expect(workingProvider.listenerCount).toBe(1);
    expect(workingProvider.startCalls).toBe(1);
    expect(failingProvider.startCalls).toBe(1);
    expect(failingProvider.listenerCount).toBe(0);
    expect(failingProvider.disposeCalls).toBe(1);

    await expect(workingProvider.emit(inbound())).resolves.toMatchObject({
      status: "accepted",
    });
    expect(harness.factoryCalls).toHaveLength(1);
  });
});
