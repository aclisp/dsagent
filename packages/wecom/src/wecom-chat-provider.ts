import { Buffer } from "node:buffer";
import {
  WSClient,
  generateReqId,
  type Logger,
  type WSClientOptions,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type {
  ChatDeliveryResult,
  ChatMessageHandlingResult,
  InboundGroupMessage,
  ChatProvider,
  ChatProviderListener,
} from "@thinkany/dscode-chat-client";
import { parseWeComBotMention } from "./wecom-mention.js";

const MAX_MESSAGE_BYTES = 20_480;
const MAX_PENDING_REPLIES = 10_000;

type EventListener = (...args: unknown[]) => void;

export interface WeComMessageBody {
  msgid?: unknown;
  aibotid?: unknown;
  chatid?: unknown;
  chattype?: unknown;
  from?: { userid?: unknown };
  msgtype?: unknown;
  text?: { content?: unknown };
  quote?: unknown;
  [key: string]: unknown;
}

export type WeComMessageFrame = WsFrame<WeComMessageBody>;

export interface WeComMarkdownMessage {
  msgtype: "markdown";
  markdown: { content: string };
}

/**
 * The small part of the official SDK used by this Provider. Keeping this
 * seam injectable makes protocol filtering testable without opening a real
 * WebSocket connection.
 */
export interface WeComClient {
  on(event: string, listener: EventListener): this;
  off(event: string, listener: EventListener): this;
  connect(): unknown;
  disconnect(): void;
  replyStream(
    frame: Pick<WeComMessageFrame, "headers">,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  sendMessage(
    chatId: string,
    body: WeComMarkdownMessage,
  ): Promise<unknown>;
}

export type WeComClientFactory = (
  options: WSClientOptions,
) => WeComClient;

export interface WeComChatProviderLogger {
  error(message: string): void;
}

export interface CreateWeComChatProviderOptions {
  botId: string;
  secret: string;
  groupChatId: string;
  botName: string;
  wsUrl?: string;
  clientFactory?: WeComClientFactory;
  logger?: WeComChatProviderLogger;
}

export type WeComEnvironment = Readonly<
  Record<string, string | undefined>
>;

interface PendingReply {
  frame: Pick<WeComMessageFrame, "headers">;
  streamId: string;
}

const defaultLogger: WeComChatProviderLogger = {
  error(message) {
    console.error(message);
  },
};

const defaultClientFactory: WeComClientFactory = (options) =>
  new WSClient(options) as unknown as WeComClient;

function requiredOption(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`WeCom Chat Provider ${name} must not be blank`);
  }
  return normalized;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonBlankText(value: unknown): string | undefined {
  const text = textValue(value)?.trim();
  return text && text.length > 0 ? text : undefined;
}

/**
 * Convert a raw SDK message into the provider-neutral group message. The
 * WeCom protocol keeps the visible @ mention in text.content. The configured
 * bot name is required because the mention may occur anywhere in the text.
 */
export function normalizeWeComMessage(
  frame: WeComMessageFrame,
  options: Pick<CreateWeComChatProviderOptions, "botId" | "botName" | "groupChatId">,
): InboundGroupMessage | undefined {
  if (nonBlankText(frame.headers?.req_id) === undefined) return undefined;
  const body = frame.body;
  if (!body || body.msgtype !== "text") return undefined;
  if (body.aibotid !== options.botId) return undefined;
  if (body.chattype !== "group" || body.chatid !== options.groupChatId) {
    return undefined;
  }
  if (body.quote !== undefined) return undefined;

  const messageId = nonBlankText(body.msgid);
  const senderId = nonBlankText(body.from?.userid);
  const content = nonBlankText(body.text?.content);
  if (messageId === undefined || senderId === undefined || content === undefined) {
    return undefined;
  }
  if (senderId === options.botId || senderId === body.aibotid) return undefined;

  const parsedMention = parseWeComBotMention(content, options.botName);
  if (!parsedMention.matched) return undefined;
  const text = parsedMention.text;
  if (text.length === 0) return undefined;

  return {
    dedupeKey: `wecom:${messageId}`,
    groupChatId: options.groupChatId,
    messageId,
    text,
  };
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : undefined;
}

function classifyDeliveryError(error: unknown): ChatDeliveryResult {
  const record = errorRecord(error);
  const code = record?.code ?? record?.errcode;
  const retryAfterMs = record?.retryAfterMs;
  const retryAfter =
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
      ? retryAfterMs
      : undefined;

  if (
    (typeof code === "string" &&
      /AUTH|INVALID|PERMISSION|NOT_FOUND|EXHAUSTED/u.test(code)) ||
    (typeof code === "number" &&
      code >= 40_000 &&
      code < 50_000 &&
      code !== 45_009)
  ) {
    return { status: "permanent_failure" };
  }

  return retryAfter === undefined
    ? { status: "retryable" }
    : { status: "retryable", retryAfterMs: retryAfter };
}

function textFitsWeComLimit(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_MESSAGE_BYTES;
}

export class WeComChatProvider implements ChatProvider {
  readonly groupChatId: string;
  private readonly botId: string;
  private readonly botName: string;
  private readonly client: WeComClient;
  private readonly logger: WeComChatProviderLogger;
  private readonly listeners = new Set<ChatProviderListener>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly handleTextMessage = (frame: WeComMessageFrame): void => {
    this.receive(frame);
  };
  private readonly handleClientError = (error: unknown): void => {
    void error;
    this.logger.error("WeCom Chat Provider connection error");
  };
  private started = false;
  private disposed = false;

  constructor(options: CreateWeComChatProviderOptions) {
    this.botId = requiredOption("botId", options.botId);
    const secret = requiredOption("secret", options.secret);
    this.groupChatId = requiredOption("groupChatId", options.groupChatId);
    this.botName = requiredOption("botName", options.botName);
    this.logger = options.logger ?? defaultLogger;
    const providerLogger = this.logger;
    const sdkLogger: Logger = {
      debug() {},
      info() {},
      warn() {
        providerLogger.error("WeCom Chat Provider SDK warning");
      },
      error() {
        providerLogger.error("WeCom Chat Provider SDK error");
      },
    };
    const clientOptions: WSClientOptions = {
      botId: this.botId,
      secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 1,
      logger: sdkLogger,
      ...(options.wsUrl?.trim() ? { wsUrl: options.wsUrl.trim() } : {}),
    };
    this.client = (options.clientFactory ?? defaultClientFactory)(clientOptions);
    this.client.on(
      "message.text",
      this.handleTextMessage as unknown as EventListener,
    );
    this.client.on("error", this.handleClientError as EventListener);
  }

  start(): void {
    this.assertActive();
    if (this.started) return;
    this.started = true;
    try {
      this.client.connect();
    } catch (error) {
      this.started = false;
      this.client.disconnect();
      throw error;
    }
  }

  subscribe(listener: ChatProviderListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async reply(messageId: string, text: string): Promise<ChatDeliveryResult> {
    if (this.disposed || !textFitsWeComLimit(text)) {
      return { status: "permanent_failure" };
    }
    const pending = this.pendingReplies.get(messageId);
    if (pending === undefined) return { status: "permanent_failure" };
    try {
      await this.client.replyStream(
        pending.frame,
        pending.streamId,
        text,
        true,
      );
      this.pendingReplies.delete(messageId);
      return { status: "delivered" };
    } catch (error) {
      const result = classifyDeliveryError(error);
      if (result.status === "permanent_failure") {
        this.pendingReplies.delete(messageId);
      }
      return result;
    }
  }

  async send(groupChatId: string, text: string): Promise<ChatDeliveryResult> {
    if (
      this.disposed ||
      groupChatId !== this.groupChatId ||
      !textFitsWeComLimit(text)
    ) {
      return { status: "permanent_failure" };
    }
    try {
      await this.client.sendMessage(groupChatId, {
        msgtype: "markdown",
        markdown: { content: text },
      });
      return { status: "delivered" };
    } catch (error) {
      return classifyDeliveryError(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const wasStarted = this.started;
    this.started = false;
    this.listeners.clear();
    this.pendingReplies.clear();
    this.client.off(
      "message.text",
      this.handleTextMessage as unknown as EventListener,
    );
    this.client.off("error", this.handleClientError as EventListener);
    if (wasStarted) this.client.disconnect();
  }

  private receive(frame: WeComMessageFrame): void {
    if (this.disposed || !this.started) return;
    const message = normalizeWeComMessage(frame, {
      botId: this.botId,
      botName: this.botName,
      groupChatId: this.groupChatId,
    });
    if (message === undefined) return;

    if (this.pendingReplies.size >= MAX_PENDING_REPLIES) {
      const oldest = this.pendingReplies.keys().next().value;
      if (oldest !== undefined) this.pendingReplies.delete(oldest);
    }
    this.pendingReplies.set(message.messageId, {
      frame,
      streamId: generateReqId("dscode"),
    });

    for (const listener of this.listeners) {
      try {
        const result: Promise<ChatMessageHandlingResult> = listener(message);
        void result.catch(() => undefined);
      } catch {
        // A listener failure must not break the SDK event loop or other listeners.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("WeCom Chat Provider is disposed");
  }
}

export function createWeComChatProvider(
  options: CreateWeComChatProviderOptions,
): WeComChatProvider {
  return new WeComChatProvider(options);
}

function envValue(env: WeComEnvironment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function createWeComChatProviderFromEnv(
  env: WeComEnvironment = process.env,
): WeComChatProvider | undefined {
  const botId = envValue(env, "IM_WECOM_BOT_ID");
  const secret = envValue(env, "IM_WECOM_SECRET");
  const groupChatId = envValue(env, "IM_WECOM_GROUP_CHAT_ID");
  const botName = envValue(env, "IM_WECOM_BOT_NAME");
  const wsUrl = envValue(env, "IM_WECOM_WS_URL");
  const configured =
    botId !== undefined ||
    secret !== undefined ||
    groupChatId !== undefined ||
    botName !== undefined;
  if (!configured) return undefined;

  const missing = [
    ["IM_WECOM_BOT_ID", botId],
    ["IM_WECOM_SECRET", secret],
    ["IM_WECOM_GROUP_CHAT_ID", groupChatId],
    ["IM_WECOM_BOT_NAME", botName],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `WeCom Chat Provider requires ${missing.join(", ")} when IM_WECOM_* is configured`,
    );
  }

  return createWeComChatProvider({
    botId: botId as string,
    secret: secret as string,
    groupChatId: groupChatId as string,
    botName: botName as string,
    ...(wsUrl !== undefined ? { wsUrl } : {}),
  });
}
