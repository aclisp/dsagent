import type {
  SessionPort,
  SessionPortTurnEvent,
} from "@thinkany/dscode-http-adapter/session-port";
import { DedupeCache } from "./dedupe-cache.js";

export const BUSY_REPLY =
  "我正在处理其他工作，刚才的请求没有被记录。请稍后重新 @我发送一次。";
export const EMPTY_COMPLETION_REPLY = "任务已经完成";

const DELIVERY_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000];

export interface InboundGroupMessage {
  dedupeKey: string;
  groupChatId: string;
  messageId: string;
  senderName?: string;
  text: string;
}

export type ChatDeliveryResult =
  | { status: "delivered" }
  | { status: "retryable"; retryAfterMs?: number }
  | { status: "permanent_failure" };

export interface ChatDelivery {
  reply(messageId: string, text: string): Promise<ChatDeliveryResult>;
  send(groupChatId: string, text: string): Promise<ChatDeliveryResult>;
}

export interface ChatClientLogger {
  error(
    context: {
      attempt: number;
      delivery: "reply" | "send";
      dedupeKey?: string;
      turnId?: string;
    },
    message: string,
  ): void;
}

export interface CreateHeadlessChatClientOptions {
  workspaceId: string;
  groupChatId: string;
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
  message: InboundGroupMessage,
) => Promise<ChatMessageHandlingResult>;

/**
 * Protocol-neutral inbound/outbound chat provider contract.
 *
 * Concrete transports implement this interface; the headless chat client
 * owns message handling and delivery policy independently of that transport.
 */
export interface ChatProvider extends ChatDelivery {
  readonly groupChatId: string;
  subscribe(listener: ChatProviderListener): () => void;
  start?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface HeadlessChatClient {
  handleMessage(message: InboundGroupMessage): Promise<ChatMessageHandlingResult>;
  registerTurnForGroupDelivery(
    turnId: string,
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
  | { type: "reply"; messageId: string; dedupeKey: string }
  | { type: "send"; listener?: ProactiveDeliveryListener };

const defaultLogger: ChatClientLogger = {
  error(context, message) {
    console.error(message, context);
  },
};

function formatPrompt(message: InboundGroupMessage): string {
  const marker =
    message.senderName === undefined
      ? "[Group message]"
      : `[Group message from ${message.senderName}]`;
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

  constructor(private readonly options: CreateHeadlessChatClientOptions) {
    if (options.workspaceId.trim().length === 0) {
      throw new Error("Workspace ID must not be blank");
    }
    if (options.groupChatId.trim().length === 0) {
      throw new Error("Group chat ID must not be blank");
    }
    this.logger = options.logger ?? defaultLogger;
    this.unsubscribe = options.sessionPort.subscribe((event) =>
      this.handleTerminalEvent(event),
    );
  }

  async handleMessage(
    message: InboundGroupMessage,
  ): Promise<ChatMessageHandlingResult> {
    this.assertActive();
    if (message.groupChatId !== this.options.groupChatId) {
      return { status: "ignored" };
    }
    if (!this.dedupe.rememberIfNew(message.dedupeKey)) {
      return { status: "duplicate" };
    }

    const submission = await this.options.sessionPort.submitTurn(
      this.options.workspaceId,
      formatPrompt(message),
    );
    if (submission.status === "busy") {
      await this.deliverWithRetry(
        "reply",
        () => this.options.delivery.reply(message.messageId, BUSY_REPLY),
        { dedupeKey: message.dedupeKey },
      );
      return { status: "busy" };
    }

    if (!this.disposed) {
      this.turnTargets.set(submission.turnId, {
        type: "reply",
        messageId: message.messageId,
        dedupeKey: message.dedupeKey,
      });
    }
    return { status: "accepted", turnId: submission.turnId };
  }

  registerTurnForGroupDelivery(
    turnId: string,
    listener?: ProactiveDeliveryListener,
  ): boolean {
    this.assertActive();
    if (this.turnTargets.has(turnId)) return false;
    this.turnTargets.set(turnId, {
      type: "send",
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
        () => this.options.delivery.reply(target.messageId, text),
        { dedupeKey: target.dedupeKey, turnId: event.turnId },
      );
      return;
    }
    const status = await this.deliverWithRetry(
      "send",
      () => this.options.delivery.send(this.options.groupChatId, text),
      { turnId: event.turnId },
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
    context: { dedupeKey?: string; turnId?: string },
  ): Promise<ProactiveDeliveryEvent["status"]> {
    for (let attempt = 1; attempt <= DELIVERY_RETRY_DELAYS_MS.length + 1; attempt += 1) {
      if (this.disposed) return "abandoned";
      let result: ChatDeliveryResult;
      try {
        result = await deliver();
      } catch {
        this.logger.error(
          { attempt, delivery, ...context },
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
          { attempt, delivery, ...context },
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
