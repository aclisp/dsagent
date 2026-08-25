import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  readonly downloadFileCalls: Array<{ url: string; aesKey: string | undefined }> = [];
  readonly uploadMediaCalls: Array<{
    buffer: Buffer;
    options: { type: "image" | "file"; filename: string };
  }> = [];
  readonly sendMediaMessageCalls: Array<{
    chatId: string;
    mediaType: "image" | "file";
    mediaId: string;
  }> = [];
  replyError: unknown;
  sendError: unknown;
  downloadError: unknown;
  uploadError: unknown;
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

  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.downloadFileCalls.push({ url, aesKey });
    if (this.downloadError !== undefined) {
      return Promise.reject(this.downloadError);
    }
    if (url.includes("image")) {
      return Promise.resolve({
        buffer: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]),
        filename: "photo.png",
      });
    }
    return Promise.resolve({
      buffer: Buffer.from("report"),
      filename: "report.pdf",
    });
  }

  uploadMedia(
    buffer: Buffer,
    options: { type: "image" | "file"; filename: string },
  ): Promise<{ media_id: string }> {
    this.uploadMediaCalls.push({ buffer, options });
    return this.uploadError === undefined
      ? Promise.resolve({ media_id: `media-${this.uploadMediaCalls.length}` })
      : Promise.reject(this.uploadError);
  }

  sendMediaMessage(
    chatId: string,
    mediaType: "image" | "file",
    mediaId: string,
  ): Promise<unknown> {
    this.sendMediaMessageCalls.push({ chatId, mediaType, mediaId });
    return Promise.resolve({});
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

function createHarness(options: { botName?: string; workspacePath?: string } = {}): {
  client: FakeWeComClient;
  provider: WeComChatProvider;
} {
  const client = new FakeWeComClient();
  const provider = createWeComChatProvider({
    botId: "bot-1",
    secret: "secret-1",
    groupChatId: "group-1",
    botName: options.botName ?? "Steve",
    ...(options.workspacePath !== undefined
      ? { workspacePath: options.workspacePath }
      : {}),
    logger: { error() {} },
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

async function waitForAsyncMessage(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "dscode-wecom-provider-"));
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

  it("downloads mixed group images and exposes the Chat UI attachment marker", async () => {
    const workspace = await createTempWorkspace();
    const { client, provider } = createHarness({ workspacePath: workspace });
    const messages: InboundGroupMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();
    client.emit(
      "message.mixed",
      frame("ignored", {
        msgtype: "mixed",
        mixed: {
          msg_item: [
            {
              msgtype: "text",
              text: { content: "请 @Steve 读这张图" },
            },
            {
              msgtype: "image",
              image: { url: "https://example.invalid/image", aeskey: "aes-1" },
            },
          ],
        },
        quote: {
          msgtype: "text",
          text: { content: "引用的上下文" },
        },
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-photo\.png\]\n请 读这张图$/u,
    );
    expect(client.downloadFileCalls).toEqual([
      { url: "https://example.invalid/image", aesKey: "aes-1" },
    ]);
    const storedPath = messages[0]?.text.match(/(uploads\/[^\]]+)/u)?.[1];
    expect(storedPath).toBeDefined();
    await expect(
      readFile(path.join(workspace, storedPath as string)),
    ).resolves.toHaveLength(8);
    provider.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  it("accepts a quoted group file and continues with an attachment failure note", async () => {
    const workspace = await createTempWorkspace();
    const { client, provider } = createHarness({ workspacePath: workspace });
    const messages: InboundGroupMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();
    client.emit(
      "message.text",
      frame("@Steve 总结引用的文件", {
        quote: {
          msgtype: "file",
          file: { url: "https://example.invalid/file", aeskey: "aes-2" },
        },
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-report\.pdf\]\n总结引用的文件$/u,
    );

    client.downloadError = new Error("temporary download failure");
    client.emit(
      "message.text",
      frame("@Steve 再试一次", {
        msgid: "message-2",
        quote: {
          msgtype: "file",
          file: { url: "https://example.invalid/file-2" },
        },
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]?.text).toBe(
      "再试一次\n\n文件附件下载失败，请基于可用内容继续处理。",
    );
    provider.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  it("delivers explicitly cited artifacts after text without making media failure retryable", async () => {
    const workspace = await createTempWorkspace();
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(workspace, "uploads"), { recursive: true }),
    );
    await writeFile(path.join(workspace, "uploads", "result.pdf"), "result");
    const { client, provider } = createHarness({ workspacePath: workspace });
    await collectMessage(provider, client, frame());

    await expect(provider.reply("message-1", "结果见 `uploads/result.pdf`")).resolves.toEqual({
      status: "delivered",
    });
    expect(client.replyStreamCalls[0]?.content).toBe(
      "结果见 `uploads/result.pdf`",
    );
    expect(client.uploadMediaCalls).toHaveLength(1);
    expect(client.uploadMediaCalls[0]?.options).toEqual({
      type: "file",
      filename: "result.pdf",
    });
    expect(client.sendMediaMessageCalls).toEqual([
      { chatId: "group-1", mediaType: "file", mediaId: "media-1" },
    ]);
    await expect(
      provider.send("group-1", "定时结果见 `uploads/result.pdf`"),
    ).resolves.toEqual({ status: "delivered" });
    expect(client.sendMessageCalls.at(-1)?.body.markdown.content).toBe(
      "定时结果见 `uploads/result.pdf`",
    );
    expect(client.sendMediaMessageCalls.at(-1)).toEqual({
      chatId: "group-1",
      mediaType: "file",
      mediaId: "media-2",
    });

    const second = createHarness({ workspacePath: workspace });
    await collectMessage(second.provider, second.client, frame("@Steve 再做一次"));
    second.client.uploadError = new Error("upload failed");
    await expect(
      second.provider.reply("message-1", "结果见 `uploads/result.pdf`"),
    ).resolves.toEqual({ status: "delivered" });
    second.provider.dispose();
    provider.dispose();
    await rm(workspace, { recursive: true, force: true });
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

  it("redacts private Web UI URLs before sending reply or proactive text", async () => {
    const { client, provider } = createHarness();
    await collectMessage(provider, client, frame());
    const text =
      "结果见 https://example.com/share/k9x7q2m4v8w1z5t3/uploads/result.pdf；文档说明见 https://example.com/docs。";

    await expect(provider.reply("message-1", text)).resolves.toEqual({
      status: "delivered",
    });
    expect(client.replyStreamCalls[0]?.content).toBe(
      "结果见 [私密链接已隐藏]；文档说明见 https://example.com/docs。",
    );

    await expect(provider.send("group-1", text)).resolves.toEqual({
      status: "delivered",
    });
    expect(client.sendMessageCalls[0]?.body.markdown.content).toBe(
      "结果见 [私密链接已隐藏]；文档说明见 https://example.com/docs。",
    );
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
