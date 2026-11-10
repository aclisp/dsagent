import type {
  SessionPort,
  SessionPortTurnContext,
  SessionPortTurnEvent,
} from "@aclisp/dsagent-http-adapter/session-port";
import type {
  ConversationAddress,
  ConversationAliasRegistry,
  ConversationReference,
  SenderAddress,
  SenderReference,
} from "./conversation-registry.ts";
import { DedupeCache } from "./dedupe-cache.ts";

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

export type ChatDeliveryRequest =
  | { id: string; kind: "reply"; target: ChatReplyTarget; text: string }
  | { id: string; kind: "send"; conversation: ChatConversation; text: string };

export interface ChatTurnLifecycle {
  turnId: string;
  conversation: ChatConversation;
  messageId?: string;
}

export type ChatDeliveryResult =
  | { status: "delivered" }
  | { status: "retryable"; retryAfterMs?: number }
  | { status: "permanent_failure" };

export interface ChatDelivery {
  /** Opt-in lifecycle and stable delivery IDs; legacy Providers keep their behavior. */
  readonly notifyOnFailure?: boolean;
  beforeSubmit?(target: ChatReplyTarget): void | Promise<void>;
  onTurnStarted?(event: ChatTurnLifecycle): void | Promise<void>;
  onTurnFinished?(event: ChatTurnLifecycle & {
    status: SessionPortTurnEvent["status"];
  }): void | Promise<void>;
  deliver?(request: ChatDeliveryRequest): Promise<ChatDeliveryResult>;
  onDeliverySettled?(request: ChatDeliveryRequest, status: ProactiveDeliveryEvent["status"]): void | Promise<void>;
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

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

class DefaultHeadlessChatClient implements HeadlessChatClient {
  private readonly dedupe = new DedupeCache();
  private readonly turnTargets = new Map<string, TurnDeliveryTarget>();
  private readonly logger: ChatClientLogger;
  private readonly unsubscribe: () => void;
  private readonly lifetime = new AbortController();
  private readonly earlyEvents = new Map<string, SessionPortTurnEvent>();
  private pendingSubmissions = 0;
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
    // A Provider may durably record admission before the Agent can cause effects.
    // Failure here must prevent submission, rather than becoming a diagnostic hook.
    await this.options.delivery.beforeSubmit?.(target);
    this.pendingSubmissions++;
    let submission;
    try {
      submission = await this.options.sessionPort.submitTurn(
        this.options.workspaceId, formatPrompt(message, conversationReference, senderReference), context,
      );
    } catch (error) { this.finishSubmission(); throw error; }
    if (submission.status === "busy") {
      this.finishSubmission();
      await this.deliverRequest(
        { id: `busy:${message.messageId}`, kind: "reply", target,
          text: conversation.type === "direct" ? DIRECT_BUSY_REPLY : GROUP_BUSY_REPLY },
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
      const early = this.earlyEvents.get(submission.turnId);
      this.earlyEvents.delete(submission.turnId);
      this.finishSubmission();
      await this.lifecycle(() => this.options.delivery.onTurnStarted?.({
        turnId: submission.turnId, conversation, messageId: message.messageId,
      }));
      if (early) await this.handleTerminalEvent(early);
    } else this.finishSubmission();
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
    void this.lifecycle(() => this.options.delivery.onTurnStarted?.({ turnId, conversation: normalized }));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.unsubscribe();
    for (const [turnId, target] of this.turnTargets) {
      void this.lifecycle(() => this.options.delivery.onTurnFinished?.({
        turnId, status: "aborted",
        conversation: target.type === "reply" ? target.target.conversation : target.conversation,
        ...(target.type === "reply" ? { messageId: target.target.messageId } : {}),
      }));
      if (target.type === "send") {
        this.notifyProactiveDelivery(target, { turnId, status: "abandoned" });
      }
    }
    this.turnTargets.clear();
    this.dedupe.clear();
    this.earlyEvents.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Headless Chat Client is disposed");
  }

  private async handleTerminalEvent(event: SessionPortTurnEvent): Promise<void> {
    if (this.disposed) return;
    const target = this.turnTargets.get(event.turnId);
    if (!target) {
      // An immediately completing Agent can finish before submitTurn resolves.
      if (this.pendingSubmissions > 0 && this.earlyEvents.size < 1000) this.earlyEvents.set(event.turnId, event);
      return;
    }
    this.turnTargets.delete(event.turnId);
    await this.lifecycle(() => this.options.delivery.onTurnFinished?.({
      turnId: event.turnId, status: event.status,
      conversation: target.type === "reply" ? target.target.conversation : target.conversation,
      ...(target.type === "reply" ? { messageId: target.target.messageId } : {}),
    }));
    if (event.status !== "completed" && !this.options.delivery.notifyOnFailure) return;

    const text = event.status === "completed"
      ? (event.output?.length ? event.output : EMPTY_COMPLETION_REPLY)
      : event.status === "failed" ? "本次处理失败，请稍后重试。" : "本次处理已中止。";
    if (target.type === "reply") {
      await this.deliverRequest(
        { id: event.turnId, kind: "reply", target: target.target, text },
        {
          dedupeKey: target.dedupeKey,
          turnId: event.turnId,
          providerId: this.options.providerId,
          conversationAlias: target.conversationAlias,
        },
      );
      return;
    }
    const status = await this.deliverRequest(
      { id: event.turnId, kind: "send", conversation: target.conversation, text },
      { turnId: event.turnId, providerId: this.options.providerId },
    );
    this.notifyProactiveDelivery(target, { turnId: event.turnId, status });
  }

  private finishSubmission(): void {
    this.pendingSubmissions--;
    if (this.pendingSubmissions === 0) this.earlyEvents.clear();
  }

  private async lifecycle(callback: () => void | Promise<void> | undefined): Promise<void> {
    try { await callback(); } catch {
      this.logger.error({ attempt: 1, delivery: "reply", providerId: this.options.providerId }, "Chat Provider lifecycle notification failed");
    }
  }

  private async deliverRequest(
    request: ChatDeliveryRequest,
    context: { dedupeKey?: string; turnId?: string; providerId?: string; conversationAlias?: string },
  ): Promise<ProactiveDeliveryEvent["status"]> {
    const status = await this.deliverWithRetry(request.kind, () => {
      if (this.options.delivery.deliver) return this.options.delivery.deliver(request);
      return request.kind === "reply"
        ? this.options.delivery.reply(request.target, request.text)
        : this.options.delivery.send(request.conversation, request.text);
    }, context);
    await this.lifecycle(() => this.options.delivery.onDeliverySettled?.(request, status));
    return status;
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
      await sleep(delay, this.lifetime.signal);
    }
    return "failed";
  }
}

export function createHeadlessChatClient(
  options: CreateHeadlessChatClientOptions,
): HeadlessChatClient {
  return new DefaultHeadlessChatClient(options);
}
