import type {
  SessionPort,
  SessionPortActivation,
  SessionPortTurnEvent,
  SessionPortTurnListener,
  SessionPortTurnSubmission,
} from "@thinkany/dscode-http-adapter/session-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_REPLY,
  EMPTY_COMPLETION_REPLY,
  createHeadlessChatClient,
  type ChatClientLogger,
  type ChatDelivery,
  type ChatDeliveryResult,
  type InboundGroupMessage,
} from "../src/index.js";

class FakeSessionPort implements SessionPort {
  readonly activations: string[] = [];
  readonly submissions: Array<{ workspaceId: string; message: string }> = [];
  readonly results: SessionPortTurnSubmission[] = [];
  private readonly listeners = new Set<SessionPortTurnListener>();
  private nextTurn = 1;

  async activate(workspaceId: string): Promise<SessionPortActivation> {
    this.activations.push(workspaceId);
    return { sessionId: "session-1" };
  }

  async submitTurn(
    workspaceId: string,
    message: string,
  ): Promise<SessionPortTurnSubmission> {
    this.submissions.push({ workspaceId, message });
    return (
      this.results.shift() ?? {
        status: "accepted",
        turnId: `turn-${this.nextTurn++}`,
      }
    );
  }

  subscribe(listener: SessionPortTurnListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: SessionPortTurnEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeDelivery implements ChatDelivery {
  readonly replies: Array<{ messageId: string; text: string }> = [];
  readonly sends: Array<{ groupChatId: string; text: string }> = [];
  readonly replyResults: ChatDeliveryResult[] = [];
  readonly sendResults: ChatDeliveryResult[] = [];

  async reply(messageId: string, text: string): Promise<ChatDeliveryResult> {
    this.replies.push({ messageId, text });
    return this.replyResults.shift() ?? { status: "delivered" };
  }

  async send(groupChatId: string, text: string): Promise<ChatDeliveryResult> {
    this.sends.push({ groupChatId, text });
    return this.sendResults.shift() ?? { status: "delivered" };
  }
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

function createHarness() {
  const sessionPort = new FakeSessionPort();
  const delivery = new FakeDelivery();
  const logErrors: Array<{
    context: Parameters<ChatClientLogger["error"]>[0];
    message: string;
  }> = [];
  const client = createHeadlessChatClient({
    workspaceId: "main",
    groupChatId: "bound-group",
    sessionPort,
    delivery,
    logger: {
      error(context, message) {
        logErrors.push({ context, message });
      },
    },
  });
  return { client, sessionPort, delivery, logErrors };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HeadlessChatClient", () => {
  it("filters the bound group, deduplicates, and formats sender markers", async () => {
    const harness = createHarness();

    await expect(
      harness.client.handleMessage(
        inbound({ groupChatId: "another-group" }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    expect(harness.sessionPort.submissions).toEqual([]);

    await expect(harness.client.handleMessage(inbound())).resolves.toEqual({
      status: "accepted",
      turnId: "turn-1",
    });
    expect(harness.sessionPort.submissions).toEqual([
      {
        workspaceId: "main",
        message: "[Group message from 张三]\n\n检查当前工作",
      },
    ]);
    await expect(harness.client.handleMessage(inbound())).resolves.toEqual({
      status: "duplicate",
    });
    expect(harness.sessionPort.submissions).toHaveLength(1);

    await harness.client.handleMessage({
      dedupeKey: "event-2",
      groupChatId: "bound-group",
      messageId: "message-2",
      text: "生成总结",
    });
    expect(harness.sessionPort.submissions[1]).toEqual({
      workspaceId: "main",
      message: "[Group message]\n\n生成总结",
    });
  });

  it("replies with the fixed busy message and records no Turn", async () => {
    const harness = createHarness();
    harness.sessionPort.results.push({ status: "busy" });

    await expect(harness.client.handleMessage(inbound())).resolves.toEqual({
      status: "busy",
    });
    expect(harness.delivery.replies).toEqual([
      { messageId: "message-1", text: BUSY_REPLY },
    ]);
    await expect(harness.client.handleMessage(inbound())).resolves.toEqual({
      status: "duplicate",
    });
    expect(harness.delivery.replies).toHaveLength(1);
  });

  it("replies only to completed Turns that it submitted", async () => {
    const harness = createHarness();
    const accepted = await harness.client.handleMessage(inbound());
    if (accepted.status !== "accepted") throw new Error("Turn was not accepted");

    await harness.sessionPort.emit({
      status: "completed",
      turnId: "browser-turn",
      output: "Browser result",
    });
    expect(harness.delivery.replies).toEqual([]);

    await harness.sessionPort.emit({
      status: "completed",
      turnId: accepted.turnId,
      output: "检查完成",
    });
    expect(harness.delivery.replies).toEqual([
      { messageId: "message-1", text: "检查完成" },
    ]);
    await harness.sessionPort.emit({
      status: "completed",
      turnId: accepted.turnId,
      output: "Duplicate terminal event",
    });
    expect(harness.delivery.replies).toHaveLength(1);
  });

  it("uses the completion fallback and suppresses failed or aborted Turns", async () => {
    const harness = createHarness();

    const empty = await harness.client.handleMessage(inbound());
    const failed = await harness.client.handleMessage(
      inbound({ dedupeKey: "event-2", messageId: "message-2" }),
    );
    const aborted = await harness.client.handleMessage(
      inbound({ dedupeKey: "event-3", messageId: "message-3" }),
    );
    if (
      empty.status !== "accepted" ||
      failed.status !== "accepted" ||
      aborted.status !== "accepted"
    ) {
      throw new Error("Turns were not accepted");
    }

    await harness.sessionPort.emit({
      status: "completed",
      turnId: empty.turnId,
      output: null,
    });
    await harness.sessionPort.emit({ status: "failed", turnId: failed.turnId });
    await harness.sessionPort.emit({ status: "aborted", turnId: aborted.turnId });
    expect(harness.delivery.replies).toEqual([
      { messageId: "message-1", text: EMPTY_COMPLETION_REPLY },
    ]);
  });

  it("sends explicitly registered Turn output as a new group message", async () => {
    const harness = createHarness();

    expect(harness.client.registerTurnForGroupDelivery("scheduled-turn")).toBe(
      true,
    );
    expect(harness.client.registerTurnForGroupDelivery("scheduled-turn")).toBe(
      false,
    );
    await harness.sessionPort.emit({
      status: "completed",
      turnId: "scheduled-turn",
      output: "定时总结",
    });
    expect(harness.delivery.sends).toEqual([
      { groupChatId: "bound-group", text: "定时总结" },
    ]);

    await harness.sessionPort.emit({
      status: "completed",
      turnId: "unregistered-turn",
      output: "Should stay in Web UI",
    });
    expect(harness.delivery.sends).toHaveLength(1);
  });

  it("does not let proactive registration replace a reply target", async () => {
    const harness = createHarness();
    const accepted = await harness.client.handleMessage(inbound());
    if (accepted.status !== "accepted") throw new Error("Turn was not accepted");

    expect(harness.client.registerTurnForGroupDelivery(accepted.turnId)).toBe(
      false,
    );
    await harness.sessionPort.emit({
      status: "completed",
      turnId: accepted.turnId,
      output: "Reply result",
    });
    expect(harness.delivery.replies).toEqual([
      { messageId: "message-1", text: "Reply result" },
    ]);
    expect(harness.delivery.sends).toEqual([]);
  });

  it("retries temporary delivery failures five times with jittered backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const harness = createHarness();
    harness.sessionPort.results.push({ status: "busy" });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      harness.delivery.replyResults.push({ status: "retryable" });
    }

    const handling = harness.client.handleMessage(inbound());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.delivery.replies).toHaveLength(1);
    for (const delay of [10_000, 20_000, 40_000, 80_000, 160_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await expect(handling).resolves.toEqual({ status: "busy" });
    expect(harness.delivery.replies).toHaveLength(6);
    expect(harness.logErrors).toEqual([
      {
        context: {
          attempt: 6,
          delivery: "reply",
          dedupeKey: "event-1",
        },
        message: "Chat delivery failed",
      },
    ]);
  });

  it("prefers retryAfter and does not retry permanent failures", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.sessionPort.results.push({ status: "busy" });
    harness.delivery.replyResults.push(
      { status: "retryable", retryAfterMs: 123 },
      { status: "delivered" },
    );

    const handling = harness.client.handleMessage(inbound());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.delivery.replies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(122);
    expect(harness.delivery.replies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(handling).resolves.toEqual({ status: "busy" });
    expect(harness.delivery.replies).toHaveLength(2);

    harness.sessionPort.results.push({ status: "busy" });
    harness.delivery.replyResults.push({ status: "permanent_failure" });
    await expect(
      harness.client.handleMessage(
        inbound({ dedupeKey: "event-2", messageId: "message-2" }),
      ),
    ).resolves.toEqual({ status: "busy" });
    expect(harness.delivery.replies).toHaveLength(3);
    expect(harness.logErrors.at(-1)).toMatchObject({
      context: { attempt: 1, delivery: "reply", dedupeKey: "event-2" },
    });
  });

  it("unsubscribes and rejects new work after disposal", async () => {
    const harness = createHarness();
    expect(harness.sessionPort.listenerCount).toBe(1);

    harness.client.dispose();
    harness.client.dispose();
    expect(harness.sessionPort.listenerCount).toBe(0);
    await expect(harness.client.handleMessage(inbound())).rejects.toThrow(
      "disposed",
    );
    expect(() =>
      harness.client.registerTurnForGroupDelivery("turn-1"),
    ).toThrow("disposed");
  });
});
