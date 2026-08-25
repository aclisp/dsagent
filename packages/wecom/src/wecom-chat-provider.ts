import { Buffer } from "node:buffer";
import {
  WSClient,
  generateReqId,
  type Logger,
  type BaseMessage,
  type FileContent,
  type ImageContent,
  type MixedContent,
  type MixedMsgItem,
  type QuoteContent,
  type TextContent,
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
import { redactWeComPrivateUrls } from "./wecom-url-redaction.js";
import {
  collectWeComOutboundArtifacts,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  sendWeComOutboundArtifacts,
  WeComMediaError,
  WeComMediaStore,
  type WeComMediaDownloadClient,
  type WeComMediaReference,
  type WeComMediaUploadClient,
} from "./wecom-media.js";

const MAX_MESSAGE_BYTES = 20_480;
const MAX_PENDING_REPLIES = 10_000;

type EventListener = (...args: unknown[]) => void;

export type WeComMessageBody = Partial<BaseMessage> & {
  text?: TextContent;
  image?: ImageContent;
  file?: FileContent;
  mixed?: MixedContent;
  quote?: QuoteContent;
};

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
  downloadFile?(
    url: string,
    aesKey?: string,
  ): Promise<{ buffer: Buffer; filename?: string }>;
  uploadMedia?(
    fileBuffer: Buffer,
    options: { type: "image" | "file"; filename: string },
  ): Promise<{ media_id: string }>;
  sendMediaMessage?(
    chatId: string,
    mediaType: "image" | "file",
    mediaId: string,
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
  workspacePath?: string;
  maxUploadBytes?: number;
  clientFactory?: WeComClientFactory;
  logger?: WeComChatProviderLogger;
}

export interface WeComChatProviderRuntimeOptions {
  workspacePath?: string;
  maxUploadBytes?: number;
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

interface ParsedWeComInboundMessage {
  message: InboundGroupMessage;
  media: WeComMediaReference[];
}

interface GroupMessageIdentity {
  body: WeComMessageBody;
  messageId: string;
  senderId: string;
}

function groupMessageIdentity(
  frame: WeComMessageFrame,
  options: Pick<CreateWeComChatProviderOptions, "botId" | "groupChatId">,
): GroupMessageIdentity | undefined {
  if (nonBlankText(frame.headers?.req_id) === undefined) return undefined;
  const body = frame.body;
  if (!body || body.aibotid !== options.botId) return undefined;
  if (body.chattype !== "group" || body.chatid !== options.groupChatId) {
    return undefined;
  }

  const messageId = nonBlankText(body.msgid);
  const senderId = nonBlankText(body.from?.userid);
  if (messageId === undefined || senderId === undefined) return undefined;
  if (senderId === options.botId || senderId === body.aibotid) return undefined;
  return { body, messageId, senderId };
}

function mediaReference(
  kind: WeComMediaReference["kind"],
  content: unknown,
): WeComMediaReference | undefined {
  if (content === null || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  const url = nonBlankText(record.url);
  if (url === undefined) return undefined;
  const aesKey = nonBlankText(record.aeskey);
  return aesKey === undefined ? { kind, url } : { kind, url, aesKey };
}

function parseMixedContent(
  mixed: unknown,
): { textParts: string[]; media: WeComMediaReference[] } {
  if (mixed === null || typeof mixed !== "object") {
    return { textParts: [], media: [] };
  }
  const items = (mixed as { msg_item?: unknown }).msg_item;
  if (!Array.isArray(items)) return { textParts: [], media: [] };

  const textParts: string[] = [];
  const media: WeComMediaReference[] = [];
  for (const item of items as MixedMsgItem[]) {
    if (item?.msgtype === "text") {
      const text = nonBlankText(item.text?.content);
      if (text !== undefined) textParts.push(text);
      continue;
    }
    if (item?.msgtype === "image") {
      const reference = mediaReference("image", item.image);
      if (reference !== undefined) media.push(reference);
    }
  }
  return { textParts, media };
}

function parseQuotedMedia(
  quote: unknown,
): { media: WeComMediaReference[] } {
  if (quote === undefined || quote === null || typeof quote !== "object") {
    return { media: [] };
  }
  const content = quote as QuoteContent;
  if (content.msgtype === "image") {
    const reference = mediaReference("image", content.image);
    return { media: reference === undefined ? [] : [reference] };
  }
  if (content.msgtype === "file") {
    const reference = mediaReference("file", content.file);
    return { media: reference === undefined ? [] : [reference] };
  }
  if (content.msgtype === "mixed") {
    const parsed = parseMixedContent(content.mixed);
    return { media: parsed.media };
  }
  return { media: [] };
}

function dedupeMediaReferences(
  references: readonly WeComMediaReference[],
): WeComMediaReference[] {
  const seen = new Set<string>();
  const result: WeComMediaReference[] = [];
  for (const reference of references) {
    const key = `${reference.kind}:${reference.url}:${reference.aesKey ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function parseWeComInboundMessage(
  frame: WeComMessageFrame,
  options: Pick<CreateWeComChatProviderOptions, "botId" | "botName" | "groupChatId">,
): ParsedWeComInboundMessage | undefined {
  const identity = groupMessageIdentity(frame, options);
  if (identity === undefined) return undefined;

  const { body, messageId } = identity;
  let textParts: string[] = [];
  let media: WeComMediaReference[] = [];
  if (body.msgtype === "text") {
    const text = nonBlankText(body.text?.content);
    if (text === undefined) return undefined;
    textParts = [text];
  } else if (body.msgtype === "mixed") {
    const parsed = parseMixedContent(body.mixed);
    textParts = parsed.textParts;
    media = parsed.media;
    if (textParts.length === 0 && media.length === 0) return undefined;
  } else {
    // The official protocol only delivers standalone image/file messages in
    // single chat. This Provider intentionally remains group-only.
    return undefined;
  }

  const quoted = parseQuotedMedia(body.quote);
  media = dedupeMediaReferences([...media, ...quoted.media]);

  const content = textParts.join("\n").trim();
  const parsedMention = parseWeComBotMention(content, options.botName);
  if (!parsedMention.matched) return undefined;
  if (parsedMention.text.length === 0 && media.length === 0) return undefined;

  return {
    message: {
      dedupeKey: `wecom:${messageId}`,
      groupChatId: options.groupChatId,
      messageId,
      text:
        parsedMention.text.length > 0
          ? parsedMention.text
          : "请查看我上传的文件",
    },
    media,
  };
}

function mediaFailureText(
  kind: WeComMediaReference["kind"],
): string {
  return kind === "image" ? "图片附件" : "文件附件";
}

function appendInboundMediaPrompt(
  message: InboundGroupMessage,
  storedPaths: readonly string[],
  failedKinds: readonly WeComMediaReference["kind"][],
): InboundGroupMessage {
  let text = message.text;
  if (storedPaths.length > 0) {
    text = `[Uploaded files: ${storedPaths.join(", ")}]\n${text}`;
  }
  if (failedKinds.length > 0) {
    const failures = failedKinds
      .map((kind) => `${mediaFailureText(kind)}下载失败，请基于可用内容继续处理。`)
      .join("\n");
    text = `${text}\n\n${failures}`;
  }
  return { ...message, text };
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
  private readonly workspacePath: string | undefined;
  private readonly mediaStore: WeComMediaStore | undefined;
  private readonly listeners = new Set<ChatProviderListener>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly inFlightMessages = new Set<string>();
  private readonly handleMessage = (frame: WeComMessageFrame): void => {
    void this.receive(frame);
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
    const workspacePath = options.workspacePath?.trim();
    this.workspacePath =
      workspacePath === undefined || workspacePath.length === 0
        ? undefined
        : workspacePath;
    this.mediaStore =
      this.workspacePath === undefined
        ? undefined
        : new WeComMediaStore({
            workspacePath: this.workspacePath,
            maxInboundBytes:
              options.maxUploadBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES,
          });
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
      this.handleMessage as unknown as EventListener,
    );
    this.client.on(
      "message.mixed",
      this.handleMessage as unknown as EventListener,
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
    const safeText = redactWeComPrivateUrls(text);
    if (this.disposed || !textFitsWeComLimit(safeText)) {
      return { status: "permanent_failure" };
    }
    const pending = this.pendingReplies.get(messageId);
    if (pending === undefined) return { status: "permanent_failure" };
    try {
      await this.client.replyStream(
        pending.frame,
        pending.streamId,
        safeText,
        true,
      );
      this.pendingReplies.delete(messageId);
      await this.deliverOutboundArtifacts(safeText);
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
    const safeText = redactWeComPrivateUrls(text);
    if (
      this.disposed ||
      groupChatId !== this.groupChatId ||
      !textFitsWeComLimit(safeText)
    ) {
      return { status: "permanent_failure" };
    }
    try {
      await this.client.sendMessage(groupChatId, {
        msgtype: "markdown",
        markdown: { content: safeText },
      });
      await this.deliverOutboundArtifacts(safeText, groupChatId);
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
    this.inFlightMessages.clear();
    this.client.off(
      "message.text",
      this.handleMessage as unknown as EventListener,
    );
    this.client.off(
      "message.mixed",
      this.handleMessage as unknown as EventListener,
    );
    this.client.off("error", this.handleClientError as EventListener);
    if (wasStarted) this.client.disconnect();
  }

  private async receive(frame: WeComMessageFrame): Promise<void> {
    if (this.disposed || !this.started) return;
    let parsed: ParsedWeComInboundMessage | undefined;
    try {
      parsed = parseWeComInboundMessage(frame, {
        botId: this.botId,
        botName: this.botName,
        groupChatId: this.groupChatId,
      });
    } catch {
      this.logger.error("WeCom inbound message parsing failed");
      return;
    }
    if (parsed === undefined) return;
    if (this.inFlightMessages.has(parsed.message.messageId)) return;
    this.inFlightMessages.add(parsed.message.messageId);

    try {
      if (this.pendingReplies.size >= MAX_PENDING_REPLIES) {
        const oldest = this.pendingReplies.keys().next().value;
        if (oldest !== undefined) this.pendingReplies.delete(oldest);
      }
      this.pendingReplies.set(parsed.message.messageId, {
        frame,
        streamId: generateReqId("dscode"),
      });

      let message = parsed.message;
      if (parsed.media.length > 0) {
        const storedPaths: string[] = [];
        const failedKinds: WeComMediaReference["kind"][] = [];
        const downloadClient = this.mediaDownloadClient();
        for (const [index, reference] of parsed.media.entries()) {
          if (this.mediaStore === undefined || downloadClient === undefined) {
            failedKinds.push(reference.kind);
            continue;
          }
          try {
            const stored = await this.mediaStore.downloadAndStore(
              downloadClient,
              reference,
              parsed.message.messageId,
              index,
            );
            storedPaths.push(stored.path);
          } catch (error) {
            const reason =
              error instanceof WeComMediaError ? error.reason : "download_failed";
            this.logger.error(
              `WeCom inbound ${reference.kind} attachment failed (${reason})`,
            );
            failedKinds.push(reference.kind);
          }
        }
        message = appendInboundMediaPrompt(message, storedPaths, failedKinds);
      }

      if (this.disposed) return;
      this.dispatch(message);
    } finally {
      this.inFlightMessages.delete(parsed.message.messageId);
    }
  }

  private dispatch(message: InboundGroupMessage): void {
    for (const listener of this.listeners) {
      try {
        const result: Promise<ChatMessageHandlingResult> = listener(message);
        void result.catch(() => undefined);
      } catch {
        // A listener failure must not break the SDK event loop or other listeners.
      }
    }
  }

  private mediaDownloadClient(): WeComMediaDownloadClient | undefined {
    if (typeof this.client.downloadFile !== "function") return undefined;
    return {
      downloadFile: this.client.downloadFile.bind(this.client),
    };
  }

  private mediaUploadClient(): WeComMediaUploadClient | undefined {
    if (
      typeof this.client.uploadMedia !== "function" ||
      typeof this.client.sendMediaMessage !== "function"
    ) {
      return undefined;
    }
    return {
      uploadMedia: this.client.uploadMedia.bind(this.client),
      sendMediaMessage: this.client.sendMediaMessage.bind(this.client),
    };
  }

  private async deliverOutboundArtifacts(
    text: string,
    groupChatId = this.groupChatId,
  ): Promise<void> {
    try {
      if (this.workspacePath === undefined) return;
      const collected = await collectWeComOutboundArtifacts(
        text,
        this.workspacePath,
      );
      for (const skipped of collected.skipped) {
        this.logger.error(
          `WeCom attachment skipped (${skipped.reason}): ${skipped.path}`,
        );
      }
      if (collected.artifacts.length === 0) return;
      const uploadClient = this.mediaUploadClient();
      if (uploadClient === undefined) {
        this.logger.error("WeCom media delivery is unavailable in the SDK client");
        return;
      }
      await sendWeComOutboundArtifacts(
        uploadClient,
        groupChatId,
        collected.artifacts,
        this.logger,
      );
    } catch {
      // Artifact delivery is best-effort and must never turn a delivered text
      // response into a retryable text delivery failure.
      this.logger.error("WeCom attachment delivery failed");
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
  runtime: WeComChatProviderRuntimeOptions = {},
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
    ...(runtime.workspacePath !== undefined
      ? { workspacePath: runtime.workspacePath }
      : {}),
    ...(runtime.maxUploadBytes !== undefined
      ? { maxUploadBytes: runtime.maxUploadBytes }
      : {}),
  });
}
