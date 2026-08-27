import type {
  SessionPort,
  SessionPortTurnContext,
  SessionPortTurnEvent,
} from "@thinkany/dscode-http-adapter/session-port";
import type {
  ConversationAddress,
  ConversationAliasRegistry,
  ConversationReference,
  SenderAddress,
  SenderReference,
} from "./conversation-registry.js";
import { DedupeCache } from "./dedupe-cache.js";

export const GROUP_BUSY_REPLY =
  "我正在处理其他工作，刚才的请求没有被记录。请稍后重新 @我发送一次。";
export const DIRECT_BUSY_REPLY =
  "我正在处理其他工作，刚才的请求没有被记录。请稍后重新发送一次。";
export const EMPTY_COMPLETION_REPLY = "任务已经完成";

const DELIVERY_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000];

/** Provider-normalized conversation identity. The address stays inside the
 * Provider/Chat Client boundary and is never included in a Prompt. */
export type ChatConversation = ConversationAddress;

/** Provider-normalized sender identity. */
export type ChatSender = SenderAddress;

export interface InboundChatMessage {
  dedupeKey: string;
  messageId: string;
  conversation: ChatConversation;
  sender: ChatSender;
  text: string;
}

export interface ChatReplyTarget {
  messageId: string;
  conversation: ChatConversation;
}

export type ChatDeliveryResult =
  | { status: "delivered" }
  | { status: "retryable"; retryAfterMs?: number }
  | { status: "permanent_failure" };

export interface ChatDelivery {
  reply(target: ChatReplyTarget, text: string): Promise<ChatDeliveryResult>;
  send(
    conversation: ChatConversation,
    text: string,
  ): Promise<ChatDeliveryResult>;
}

export interface ChatClientLogger {
  error(
    context: {
      attempt: number;
      delivery: "reply" | "send";
      dedupeKey?: string;
      turnId?: string;
      providerId?: string;
      conversationAlias?: string;
    },
    message: string,
  ): void;
}

export interface CreateHeadlessChatClientOptions {
  workspaceId: string;
  providerId: string;
  conversationRegistry: ConversationAliasRegistry;
  sessionPort: SessionPort;
  delivery: ChatDelivery;
  logger?: ChatClientLogger;
}

export type ChatMessageHandlingResult =
  | { status: "ignored" }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "accepted"; turnId: string };

export type ChatProviderListener = (
  message: InboundChatMessage,
) => Promise<ChatMessageHandlingResult>;

/**
 * Protocol-neutral inbound/outbound chat Provider contract.
 *
 * A Provider owns protocol parsing, credentials, mention checks, and the raw
 * reply reference. The Chat Client owns aliases, shared Session submission,
 * prompt markers, dedupe, and delivery retry policy.
 */
export interface ChatProvider extends ChatDelivery {
  readonly providerId: string;
  subscribe(listener: ChatProviderListener): () => void;
  start?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface HeadlessChatClient {
  handleMessage(message: InboundChatMessage): Promise<ChatMessageHandlingResult>;
  registerTurnForDelivery(
    turnId: string,
    conversation: ChatConversation,
    listener?: ProactiveDeliveryListener,
  ): boolean;
  dispose(): void;
}

export interface ProactiveDeliveryEvent {
  turnId: string;
  status: "delivered" | "failed" | "abandoned";
}

export type ProactiveDeliveryListener = (
  event: ProactiveDeliveryEvent,
) => void | Promise<void>;

type TurnDeliveryTarget =
  | {
      type: "reply";
      target: ChatReplyTarget;
      dedupeKey: string;
      conversationAlias: string;
    }
  | {
      type: "send";
      conversation: ChatConversation;
      listener?: ProactiveDeliveryListener;
    };

const defaultLogger: ChatClientLogger = {
  error(context, message) {
    console.error(message, context);
  },
};

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must not be blank`);
  }
  return value.trim();
}

function normalizeConversation(
  value: ChatConversation,
  providerId: string,
): ChatConversation {
  if (value === null || typeof value !== "object") {
    throw new Error("Conversation must be an object");
  }
  const conversation = value as ChatConversation;
  if (conversation.providerId !== providerId) {
    throw new Error("Conversation Provider does not match Chat Client Provider");
  }
  const address = requiredText(conversation.address, "Conversation address");
  if (conversation.type !== "group" && conversation.type !== "direct") {
    throw new Error("Conversation type must be group or direct");
  }
  return {
    providerId,
    type: conversation.type,
    address,
  };
}

function normalizeSender(value: ChatSender, providerId: string): ChatSender {
  if (value === null || typeof value !== "object") {
    throw new Error("Sender must be an object");
  }
  const sender = value as ChatSender;
  if (sender.providerId !== providerId) {
    throw new Error("Sender Provider does not match Chat Client Provider");
  }
  return {
    providerId,
    address: requiredText(sender.address, "Sender address"),
  };
}

function targetFromReference(
  reference: ConversationReference,
  messageId: string,
): ChatReplyTarget {
  return {
    messageId,
    conversation: {
      providerId: reference.providerId,
      type: reference.type,
      address: reference.address,
    },
  };
}

function formatPrompt(
  message: InboundChatMessage,
  conversation: ConversationReference,
  sender: SenderReference,
): string {
  const marker = `[IM message: ${conversation.type}=${conversation.alias}; sender=${sender.alias}]`;
  return `${marker}\n\n${message.text}`;
}

function fallbackDelay(attempt: number): number {
  const baseDelay = DELIVERY_RETRY_DELAYS_MS[attempt - 1];
  if (baseDelay === undefined) return 0;
  return Math.round(baseDelay * (0.8 + Math.random() * 0.4));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class DefaultHeadlessChatClient implements HeadlessChatClient {
  private readonly dedupe = new DedupeCache();
  private readonly turnTargets = new Map<string, TurnDeliveryTarget>();
  private readonly logger: ChatClientLogger;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(options: CreateHeadlessChatClientOptions) {
    const workspaceId = requiredText(options.workspaceId, "Workspace ID");
    const providerId = requiredText(options.providerId, "Provider ID");
    this.options = {
      ...options,
      workspaceId,
      providerId,
    };
    this.logger = options.logger ?? defaultLogger;
    this.unsubscribe = options.sessionPort.subscribe((event) =>
      this.handleTerminalEvent(event),
    );
  }

  private readonly options: CreateHeadlessChatClientOptions;

  async handleMessage(
    message: InboundChatMessage,
  ): Promise<ChatMessageHandlingResult> {
    this.assertActive();
    const conversation = normalizeConversation(
      message.conversation,
      this.options.providerId,
    );
    const sender = normalizeSender(message.sender, this.options.providerId);
    const dedupeKey = `${this.options.providerId}:${requiredText(
      message.dedupeKey,
      "Dedupe key",
    )}`;
    if (!this.dedupe.rememberIfNew(dedupeKey)) {
      return { status: "duplicate" };
    }

    let conversationReference: ConversationReference;
    let senderReference: SenderReference;
    try {
      conversationReference =
        await this.options.conversationRegistry.registerConversation(
          conversation,
        );
      senderReference = await this.options.conversationRegistry.registerSender(
        sender,
      );
    } catch {
      this.logger.error(
        {
          attempt: 1,
          delivery: "reply",
          dedupeKey,
          providerId: this.options.providerId,
        },
        "Chat identity registration failed",
      );
      return { status: "ignored" };
    }

    const target = targetFromReference(conversationReference, message.messageId);
    const context: SessionPortTurnContext = {
      source: {
        type: "im",
        conversationAlias: conversationReference.alias,
      },
    };
    const submission = await this.options.sessionPort.submitTurn(
      this.options.workspaceId,
      formatPrompt(message, conversationReference, senderReference),
      context,
    );
    if (submission.status === "busy") {
      await this.deliverWithRetry(
        "reply",
        () =>
          this.options.delivery.reply(
            target,
            conversation.type === "direct" ? DIRECT_BUSY_REPLY : GROUP_BUSY_REPLY,
          ),
        {
          dedupeKey,
          conversationAlias: conversationReference.alias,
        },
      );
      return { status: "busy" };
    }

    if (!this.disposed) {
      this.turnTargets.set(submission.turnId, {
        type: "reply",
        target,
        dedupeKey,
        conversationAlias: conversationReference.alias,
      });
    }
    return { status: "accepted", turnId: submission.turnId };
  }

  registerTurnForDelivery(
    turnId: string,
    conversation: ChatConversation,
    listener?: ProactiveDeliveryListener,
  ): boolean {
    this.assertActive();
    if (this.turnTargets.has(turnId)) return false;
    const normalized = normalizeConversation(conversation, this.options.providerId);
    this.turnTargets.set(turnId, {
      type: "send",
      conversation: normalized,
      ...(listener !== undefined ? { listener } : {}),
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const [turnId, target] of this.turnTargets) {
      if (target.type === "send") {
        this.notifyProactiveDelivery(target, { turnId, status: "abandoned" });
      }
    }
    this.turnTargets.clear();
    this.dedupe.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Headless Chat Client is disposed");
  }

  private async handleTerminalEvent(event: SessionPortTurnEvent): Promise<void> {
    if (this.disposed) return;
    const target = this.turnTargets.get(event.turnId);
    if (!target) return;
    this.turnTargets.delete(event.turnId);
    if (event.status !== "completed") return;

    const text = event.output?.length ? event.output : EMPTY_COMPLETION_REPLY;
    if (target.type === "reply") {
      await this.deliverWithRetry(
        "reply",
        () => this.options.delivery.reply(target.target, text),
        {
          dedupeKey: target.dedupeKey,
          turnId: event.turnId,
          providerId: this.options.providerId,
          conversationAlias: target.conversationAlias,
        },
      );
      return;
    }
    const status = await this.deliverWithRetry(
      "send",
      () => this.options.delivery.send(target.conversation, text),
      { turnId: event.turnId, providerId: this.options.providerId },
    );
    this.notifyProactiveDelivery(target, { turnId: event.turnId, status });
  }

  private notifyProactiveDelivery(
    target: Extract<TurnDeliveryTarget, { type: "send" }>,
    event: ProactiveDeliveryEvent,
  ): void {
    try {
      const result = target.listener?.(event);
      if (result) void result.catch(() => undefined);
    } catch {
      // Delivery outcome observers are diagnostic only and must not affect delivery.
    }
  }

  private async deliverWithRetry(
    delivery: "reply" | "send",
    deliver: () => Promise<ChatDeliveryResult>,
    context: {
      dedupeKey?: string;
      turnId?: string;
      providerId?: string;
      conversationAlias?: string;
    },
  ): Promise<ProactiveDeliveryEvent["status"]> {
    for (
      let attempt = 1;
      attempt <= DELIVERY_RETRY_DELAYS_MS.length + 1;
      attempt += 1
    ) {
      if (this.disposed) return "abandoned";
      let result: ChatDeliveryResult;
      try {
        result = await deliver();
      } catch {
        this.logger.error(
          { attempt, delivery, providerId: this.options.providerId, ...context },
          "Chat delivery failed without a classification",
        );
        return "failed";
      }

      if (result.status === "delivered") return "delivered";
      if (
        result.status === "permanent_failure" ||
        attempt > DELIVERY_RETRY_DELAYS_MS.length
      ) {
        this.logger.error(
          { attempt, delivery, providerId: this.options.providerId, ...context },
          "Chat delivery failed",
        );
        return "failed";
      }

      const retryAfterMs = result.retryAfterMs;
      const delay =
        retryAfterMs !== undefined &&
        Number.isFinite(retryAfterMs) &&
        retryAfterMs >= 0
          ? retryAfterMs
          : fallbackDelay(attempt);
      await sleep(delay);
    }
    return "failed";
  }
}

export function createHeadlessChatClient(
  options: CreateHeadlessChatClientOptions,
): HeadlessChatClient {
  return new DefaultHeadlessChatClient(options);
}
