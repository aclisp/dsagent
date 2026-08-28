import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WSClientOptions } from "@wecom/aibot-node-sdk";
import type {
  ChatMessageHandlingResult,
  ChatConversation,
  ChatReplyTarget,
  InboundChatMessage,
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

function groupConversation(address = "group-1"): ChatConversation {
  return { providerId: "wecom", type: "group", address };
}

function replyTarget(
  messageId: string,
  address = "group-1",
): ChatReplyTarget {
  return { messageId, conversation: groupConversation(address) };
}

function createHarness(options: { botName?: string; workspacePath?: string } = {}): {
  client: FakeWeComClient;
  provider: WeComChatProvider;
} {
  const client = new FakeWeComClient();
  const provider = createWeComChatProvider({
    botId: "bot-1",
    secret: "secret-1",
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
): Promise<InboundChatMessage[]> {
  const messages: InboundChatMessage[] = [];
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
  it("normalizes an exact mention from any position in any group", async () => {
    const { client, provider } = createHarness();
    const messages = await collectMessage(
      provider,
      client,
      frame("请 @Steve 检查当前工作"),
    );

    expect(messages).toEqual([
      {
        dedupeKey: "message-1",
        messageId: "message-1",
        conversation: {
          providerId: "wecom",
          type: "group",
          address: "group-1",
        },
        sender: { providerId: "wecom", address: "user-1" },
        text: "请 检查当前工作",
      },
    ]);
    provider.dispose();
  });

  it("accepts inbound messages from any group", async () => {
    const { client, provider } = createHarness();
    const messages = await collectMessage(
      provider,
      client,
      frame("@Steve 另一个群的请求", { chatid: "other-group" }),
    );

    expect(messages[0]?.conversation).toEqual({
      providerId: "wecom",
      type: "group",
      address: "other-group",
    });
    provider.dispose();
  });

  it("normalizes direct text without a mention and routes delivery to the sender", async () => {
    const { client, provider } = createHarness();
    const messages = await collectMessage(
      provider,
      client,
      frame("请检查当前工作", {
        msgid: "direct-message",
        chattype: "single",
        from: { userid: "direct-user" },
      }),
    );

    expect(messages[0]).toEqual({
      dedupeKey: "direct-message",
      messageId: "direct-message",
      conversation: {
        providerId: "wecom",
        type: "direct",
        address: "direct-user",
      },
      sender: { providerId: "wecom", address: "direct-user" },
      text: "请检查当前工作",
    });

    await expect(
      provider.reply(
        {
          messageId: "direct-message",
          conversation: {
            providerId: "wecom",
            type: "direct",
            address: "direct-user",
          },
        },
        "已完成",
      ),
    ).resolves.toEqual({ status: "delivered" });
    await expect(
      provider.send(
        { providerId: "wecom", type: "direct", address: "direct-user" },
        "主动提醒",
      ),
    ).resolves.toEqual({ status: "delivered" });
    expect(client.sendMessageCalls.at(-1)?.chatId).toBe("direct-user");
    provider.dispose();
  });

  it("accepts a standalone direct voice transcript", async () => {
    const { client, provider } = createHarness();
    const messages: InboundChatMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    client.emit(
      "message.voice",
      frame("ignored", {
        msgid: "direct-voice",
        chattype: "single",
        from: { userid: "direct-user" },
        msgtype: "voice",
        voice: { content: "  帮我检查今天的安排  " },
      }),
    );
    client.emit(
      "message.voice",
      frame("ignored", {
        msgid: "empty-direct-voice",
        chattype: "single",
        from: { userid: "direct-user" },
        msgtype: "voice",
        voice: { content: "   " },
      }),
    );
    client.emit(
      "message.voice",
      frame("ignored", {
        msgid: "group-voice",
        msgtype: "voice",
        voice: { content: "群聊语音" },
      }),
    );
    await Promise.resolve();

    expect(messages).toEqual([
      {
        dedupeKey: "direct-voice",
        messageId: "direct-voice",
        conversation: {
          providerId: "wecom",
          type: "direct",
          address: "direct-user",
        },
        sender: { providerId: "wecom", address: "direct-user" },
        text: "帮我检查今天的安排",
      },
    ]);
    provider.dispose();
  });

  it("uses only the outer group mention to trigger quoted text and voice", async () => {
    const { client, provider } = createHarness();
    const messages: InboundChatMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    client.emit(
      "message.text",
      frame("@Steve", {
        msgid: "quoted-text",
        quote: {
          msgtype: "text",
          text: { content: "第一行\n\n第二行" },
        },
      }),
    );
    client.emit(
      "message.text",
      frame("@Steve", {
        msgid: "quoted-voice",
        quote: {
          msgtype: "voice",
          voice: { content: "引用语音的转写" },
        },
      }),
    );
    client.emit(
      "message.text",
      frame("请处理这条消息", {
        msgid: "mention-only-in-quote",
        quote: {
          msgtype: "text",
          text: { content: "@Steve 被引用的内容" },
        },
      }),
    );
    await Promise.resolve();

    expect(messages.map(({ messageId, text }) => ({ messageId, text }))).toEqual([
      {
        messageId: "quoted-text",
        text: "请回应以下引用消息：\n\n> 第一行\n> \n> 第二行",
      },
      {
        messageId: "quoted-voice",
        text: "请回应以下引用消息：\n\n> 引用语音的转写",
      },
    ]);
    provider.dispose();
  });

  it("ignores unusable quotes without dropping valid outer text", async () => {
    const { client, provider } = createHarness();
    const messages: InboundChatMessage[] = [];
    const videoQuote = {
      msgtype: "video",
      video: { url: "https://example.invalid/video" },
    } as unknown as NonNullable<WeComMessageBody["quote"]>;
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    client.emit(
      "message.text",
      frame("@Steve 继续处理正文", {
        msgid: "text-with-video-quote",
        quote: videoQuote,
      }),
    );
    client.emit(
      "message.text",
      frame("@Steve", {
        msgid: "video-quote-only",
        quote: videoQuote,
      }),
    );
    client.emit(
      "message.text",
      frame("@Steve", {
        msgid: "blank-quote-only",
        quote: { msgtype: "text", text: { content: "   " } },
      }),
    );
    await Promise.resolve();

    expect(messages.map(({ messageId, text }) => ({ messageId, text }))).toEqual([
      {
        messageId: "text-with-video-quote",
        text: "继续处理正文",
      },
    ]);
    provider.dispose();
  });

  it("ignores non-triggering WeCom frames", async () => {
    const { client, provider } = createHarness({ botName: "Steve" });
    const messages: InboundChatMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    for (const candidate of [
      frame("请检查"),
      frame("@Other 请检查"),
      frame("请 @Other 检查"),
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
    const messages: InboundChatMessage[] = [];
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
          msgtype: "mixed",
          mixed: {
            msg_item: [
              {
                msgtype: "text",
                text: { content: "引用的第一行" },
              },
              {
                msgtype: "image",
                image: { url: "https://example.invalid/image-quote" },
              },
              {
                msgtype: "text",
                text: { content: "引用的第二行" },
              },
            ],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-photo\.png, uploads\/wecom-[a-f0-9]{12}-2-photo\.png\]\n请 读这张图\n\n> 引用的第一行\n> 引用的第二行$/u,
    );
    expect(client.downloadFileCalls).toEqual([
      { url: "https://example.invalid/image", aesKey: "aes-1" },
      { url: "https://example.invalid/image-quote", aesKey: undefined },
    ]);
    const storedPath = messages[0]?.text.match(/(uploads\/[^,\]]+)/u)?.[1];
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
    const messages: InboundChatMessage[] = [];
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

  it("accepts direct mixed and standalone image/file messages without a mention", async () => {
    const workspace = await createTempWorkspace();
    const { client, provider } = createHarness({ workspacePath: workspace });
    const messages: InboundChatMessage[] = [];
    provider.subscribe(async (message): Promise<ChatMessageHandlingResult> => {
      messages.push(message);
      return { status: "ignored" };
    });
    provider.start();

    client.emit(
      "message.mixed",
      frame("ignored", {
        msgid: "direct-mixed",
        chattype: "single",
        from: { userid: "direct-user" },
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "请读这张图" } },
            {
              msgtype: "image",
              image: { url: "https://example.invalid/direct-image" },
            },
          ],
        },
      }),
    );
    client.emit(
      "message.image",
      frame("ignored", {
        msgid: "direct-image",
        chattype: "single",
        from: { userid: "direct-user" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      }),
    );
    client.emit(
      "message.file",
      frame("ignored", {
        msgid: "direct-file",
        chattype: "single",
        from: { userid: "direct-user" },
        msgtype: "file",
        file: { url: "https://example.invalid/file" },
        quote: { msgtype: "image", image: { url: "https://example.invalid/image-quote" } },
      }),
    );
    client.emit(
      "message.text",
      frame(" ", {
        msgid: "direct-quote",
        chattype: "single",
        from: { userid: "direct-user" },
        quote: {
          msgtype: "file",
          file: { url: "https://example.invalid/quote-only" },
        },
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(4));

    const directMixed = messages.find(
      (message) => message.messageId === "direct-mixed",
    );
    const directImage = messages.find(
      (message) => message.messageId === "direct-image",
    );
    const directFile = messages.find(
      (message) => message.messageId === "direct-file",
    );
    const directQuote = messages.find(
      (message) => message.messageId === "direct-quote",
    );
    expect(directMixed?.conversation).toEqual({
      providerId: "wecom",
      type: "direct",
      address: "direct-user",
    });
    expect(directMixed?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-photo\.png\]\n请读这张图$/u,
    );
    expect(directImage?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-photo\.png\]\n请查看我上传的文件$/u,
    );
    expect(directFile?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-report\.pdf, uploads\/wecom-[a-f0-9]{12}-2-photo\.png\]\n请查看我上传的文件$/u,
    );
    expect(directQuote?.text).toMatch(
      /^\[Uploaded files: uploads\/wecom-[a-f0-9]{12}-1-report\.pdf\]\n请回应引用的附件。$/u,
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
    await collectMessage(
      provider,
      client,
      frame("@Steve 请在另一个群回复", { chatid: "other-group" }),
    );

    await expect(
      provider.reply(
        replyTarget("message-1", "other-group"),
        "结果见 `uploads/result.pdf`",
      ),
    ).resolves.toEqual({
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
      { chatId: "other-group", mediaType: "file", mediaId: "media-1" },
    ]);
    await expect(
      provider.send(
        groupConversation(),
        "定时结果见 `uploads/result.pdf`",
      ),
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
      second.provider.reply(
        replyTarget("message-1"),
        "结果见 `uploads/result.pdf`",
      ),
    ).resolves.toEqual({ status: "delivered" });
    second.provider.dispose();
    provider.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  it("uses the original frame for replies and the requested conversation for proactive sends", async () => {
    const { client, provider } = createHarness();
    await collectMessage(provider, client, frame());

    await expect(provider.reply(replyTarget("message-1"), "已完成")).resolves.toEqual({
      status: "delivered",
    });
    expect(client.replyStreamCalls).toHaveLength(1);
    expect(client.replyStreamCalls[0]).toMatchObject({
      frame: { headers: { req_id: "request-1" } },
      content: "已完成",
      finish: true,
    });
    expect(client.replyStreamCalls[0]?.streamId).toMatch(/^dscode_/u);

    await expect(provider.send(groupConversation(), "定时结果")).resolves.toEqual({
      status: "delivered",
    });
    expect(client.sendMessageCalls).toEqual([
      {
        chatId: "group-1",
        body: { msgtype: "markdown", markdown: { content: "定时结果" } },
      },
    ]);
    await expect(provider.reply(replyTarget("unknown"), "重试")).resolves.toEqual({
      status: "permanent_failure",
    });
    provider.dispose();
  });

  it("redacts private Web UI URLs before sending reply or proactive text", async () => {
    const { client, provider } = createHarness();
    await collectMessage(provider, client, frame());
    const text =
      "结果见 https://example.com/share/k9x7q2m4v8w1z5t3/uploads/result.pdf；文档说明见 https://example.com/docs。";

    await expect(provider.reply(replyTarget("message-1"), text)).resolves.toEqual({
      status: "delivered",
    });
    expect(client.replyStreamCalls[0]?.content).toBe(
      "结果见 [私密链接已隐藏]；文档说明见 https://example.com/docs。",
    );

    await expect(provider.send(groupConversation(), text)).resolves.toEqual({
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

    await expect(provider.reply(replyTarget("message-1"), "稍后")).resolves.toEqual({
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
    ).toThrow("IM_WECOM_SECRET, IM_WECOM_BOT_NAME");
    expect(() =>
      createWeComChatProviderFromEnv({
        IM_WECOM_BOT_ID: "bot-1",
        IM_WECOM_SECRET: "secret-1",
      }),
    ).toThrow("IM_WECOM_BOT_NAME");

    const provider = createWeComChatProviderFromEnv({
      IM_WECOM_BOT_ID: "bot-1",
      IM_WECOM_SECRET: "secret-1",
      IM_WECOM_BOT_NAME: "Steve",
    });
    provider?.dispose();
  });
});
