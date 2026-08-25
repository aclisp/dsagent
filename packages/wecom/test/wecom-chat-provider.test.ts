import { describe, expect, it } from "vitest";
import type { WSClientOptions } from "@wecom/aibot-node-sdk";
import type {
  ChatMessageHandlingResult,
  InboundGroupMessage,
} from "@thinkany/dscode-chat-client";
import {
  createWeComChatProvider,
  createWeComChatProviderFromEnv,
  type WeComChatProvider,
  type WeComClient,
  type WeComMessageBody,
  type WeComMessageFrame,
} from "../src/wecom-chat-provider.js";

type Listener = (...args: unknown[]) => void;

class FakeWeComClient {
  readonly replyStreamCalls: Array<{
    frame: Pick<WeComMessageFrame, "headers">;
    streamId: string;
    content: string;
    finish: boolean | undefined;
  }> = [];
  readonly sendMessageCalls: Array<{
    chatId: string;
    body: { msgtype: "markdown"; markdown: { content: string } };
  }> = [];
  replyError: unknown;
  sendError: unknown;
  private connects = 0;
  private disconnects = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  connect(): this {
    this.connects += 1;
    return this;
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  get connectCount(): number {
    return this.connects;
  }

  get disconnectCount(): number {
    return this.disconnects;
  }

  replyStream(
    frame: Pick<WeComMessageFrame, "headers">,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown> {
    this.replyStreamCalls.push({ frame, streamId, content, finish });
    return this.replyError === undefined
      ? Promise.resolve({})
      : Promise.reject(this.replyError);
  }

  sendMessage(
    chatId: string,
    body: { msgtype: "markdown"; markdown: { content: string } },
  ): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, body });
    return this.sendError === undefined
      ? Promise.resolve({})
      : Promise.reject(this.sendError);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function frame(
  content = "@Steve 检查当前工作",
  overrides: Partial<WeComMessageBody> = {},
): WeComMessageFrame {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "request-1" },
    body: {
      msgid: "message-1",
      aibotid: "bot-1",
      chatid: "group-1",
      chattype: "group",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content },
      ...overrides,
    },
  };
}

function createHarness(options: { botName?: string } = {}): {
  client: FakeWeComClient;
  provider: WeComChatProvider;
} {
  const client = new FakeWeComClient();
  const provider = createWeComChatProvider({
    botId: "bot-1",
    secret: "secret-1",
    groupChatId: "group-1",
    botName: options.botName ?? "Steve",
    clientFactory: () => client as unknown as WeComClient,
  });
  return { client, provider };
}

async function collectMessage(
  provider: WeComChatProvider,
  client: FakeWeComClient,
  messageFrame: WeComMessageFrame,
): Promise<InboundGroupMessage[]> {
  const messages: InboundGroupMessage[] = [];
  provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
    messages.push(message);
    return { status: "ignored" };
  });
  provider.start();
  client.emit("message.text", messageFrame);
  await Promise.resolve();
  return messages;
}

describe("WeCom Chat Provider", () => {
  it("normalizes an exact mention from any position in the configured group", async () => {
    const { client, provider } = createHarness();
    const messages = await collectMessage(
      provider,
      client,
      frame("请 @Steve 检查当前工作"),
    );

    expect(messages).toEqual([
      {
        dedupeKey: "wecom:message-1",
        groupChatId: "group-1",
        messageId: "message-1",
        text: "请 检查当前工作",
      },
    ]);
    provider.dispose();
  });

  it("ignores non-triggering WeCom frames", async () => {
    const { client, provider } = createHarness({ botName: "Steve" });
    const messages: InboundGroupMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    for (const candidate of [
      frame("请检查"),
      frame("@Other 请检查"),
      frame("请 @Other 检查"),
      frame("@Steve 引用检查", { quote: { msgtype: "text" } }),
      frame("@Steve 私聊", { chattype: "single" }),
      frame("@Steve 其他群", { chatid: "other-group" }),
      frame("@Steve 其他机器人", { aibotid: "other-bot" }),
      frame("@Steve 机器人自己", { from: { userid: "bot-1" } }),
      frame("@Steve 图片", { msgtype: "image" }),
      frame("@all 全员"),
    ]) {
      client.emit("message.text", candidate);
    }
    await Promise.resolve();

    expect(messages).toEqual([]);
    provider.dispose();
  });

  it("uses the original frame for replies and the fixed group for proactive sends", async () => {
    const { client, provider } = createHarness();
    await collectMessage(provider, client, frame());

    await expect(provider.reply("message-1", "已完成")).resolves.toEqual({
      status: "delivered",
    });
    expect(client.replyStreamCalls).toHaveLength(1);
    expect(client.replyStreamCalls[0]).toMatchObject({
      frame: { headers: { req_id: "request-1" } },
      content: "已完成",
      finish: true,
    });
    expect(client.replyStreamCalls[0]?.streamId).toMatch(/^dscode_/u);

    await expect(provider.send("group-1", "定时结果")).resolves.toEqual({
      status: "delivered",
    });
    expect(client.sendMessageCalls).toEqual([
      {
        chatId: "group-1",
        body: { msgtype: "markdown", markdown: { content: "定时结果" } },
      },
    ]);
    await expect(provider.reply("unknown", "重试")).resolves.toEqual({
      status: "permanent_failure",
    });
    provider.dispose();
  });

  it("classifies transport failures as retryable and manages the client lifecycle", async () => {
    const { client, provider } = createHarness();
    await collectMessage(provider, client, frame());
    client.replyError = new Error("socket closed");

    await expect(provider.reply("message-1", "稍后")).resolves.toEqual({
      status: "retryable",
    });
    expect(client.connectCount).toBe(1);
    provider.start();
    expect(client.connectCount).toBe(1);
    provider.dispose();
    expect(client.disconnectCount).toBe(1);
    provider.dispose();
    expect(client.disconnectCount).toBe(1);
  });

  it("keeps network reconnects persistent while stopping repeated auth failures", () => {
    const client = new FakeWeComClient();
    let clientOptions: WSClientOptions | undefined;
    const provider = createWeComChatProvider({
      botId: "bot-1",
      secret: "secret-1",
      groupChatId: "group-1",
      botName: "Steve",
      clientFactory: (options) => {
        clientOptions = options;
        return client as unknown as WeComClient;
      },
    });

    expect(clientOptions).toMatchObject({
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 1,
    });
    expect(clientOptions?.logger).toBeDefined();
    provider.dispose();
  });

  it("only enables from a complete IM_WECOM configuration", () => {
    expect(createWeComChatProviderFromEnv({})).toBeUndefined();
    expect(() =>
      createWeComChatProviderFromEnv({ IM_WECOM_BOT_ID: "bot-1" }),
    ).toThrow(
      "IM_WECOM_SECRET, IM_WECOM_GROUP_CHAT_ID, IM_WECOM_BOT_NAME",
    );
    expect(() =>
      createWeComChatProviderFromEnv({
        IM_WECOM_BOT_ID: "bot-1",
        IM_WECOM_SECRET: "secret-1",
        IM_WECOM_GROUP_CHAT_ID: "group-1",
      }),
    ).toThrow("IM_WECOM_BOT_NAME");

    const provider = createWeComChatProviderFromEnv({
      IM_WECOM_BOT_ID: "bot-1",
      IM_WECOM_SECRET: "secret-1",
      IM_WECOM_GROUP_CHAT_ID: "group-1",
      IM_WECOM_BOT_NAME: "Steve",
    });
    expect(provider?.groupChatId).toBe("group-1");
    provider?.dispose();
  });
});
