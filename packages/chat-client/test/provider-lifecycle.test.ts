import { afterEach, expect, it, vi } from "vitest";
import { createConversationAliasRegistry, createHeadlessChatClient, type ChatDelivery, type ChatDeliveryRequest, type InboundChatMessage } from "../src/index.ts";
import type { SessionPort, SessionPortTurnEvent, SessionPortTurnListener } from "../../http-adapter/src/session-port.ts";

afterEach(() => { vi.useRealTimers(); });
const message: InboundChatMessage = {
  messageId: "message", dedupeKey: "message", conversation: { providerId: "test", type: "direct", address: "peer" },
  sender: { providerId: "test", address: "peer" }, text: "work",
};
async function setup(delivery: ChatDelivery, immediate = false) {
  let listener: SessionPortTurnListener | undefined;
  const port: SessionPort = {
    activate: async () => ({ sessionId: "shared" }),
    submitTurn: vi.fn(async () => {
      if (immediate) await listener?.({ status: "completed", turnId: "turn", output: "immediate result" });
      return { status: "accepted" as const, turnId: "turn" };
    }),
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
  };
  const client = createHeadlessChatClient({ workspaceId: "workspace", providerId: "test", sessionPort: port,
    conversationRegistry: await createConversationAliasRegistry(), delivery, logger: { error() {} } });
  return { client, port, emit: (event: SessionPortTurnEvent) => listener?.(event) };
}
const legacy = (): ChatDelivery => ({ reply: vi.fn(async () => ({ status: "delivered" as const })), send: vi.fn(async () => ({ status: "delivered" as const })) });

it("prevents Agent submission if the Provider's durable admission fails", async () => {
  const h = await setup({ ...legacy(), beforeSubmit() { throw new Error("disk failure"); } });
  await expect(h.client.handleMessage(message)).rejects.toThrow("disk failure");
  expect(h.port.submitTurn).not.toHaveBeenCalled(); h.client.dispose();
});
it("handles completion before submitTurn resolves, preserving lifecycle order", async () => {
  const order: string[] = []; const delivery = legacy();
  const h = await setup({ ...delivery, onTurnStarted() { order.push("start"); }, onTurnFinished() { order.push("finish"); } }, true);
  await h.client.handleMessage(message);
  expect(order).toEqual(["start", "finish"]);
  expect(delivery.reply).toHaveBeenCalledWith({ messageId: "message", conversation: message.conversation }, "immediate result");
  h.client.dispose();
});
it.each(["failed", "aborted"] as const)("opts in to %s notifications with a stable delivery ID", async status => {
  const deliver = vi.fn(async (_request: ChatDeliveryRequest) => ({ status: "delivered" as const }));
  const settled = vi.fn(); const h = await setup({ ...legacy(), notifyOnFailure: true, deliver, onDeliverySettled: settled });
  await h.client.handleMessage(message); await h.emit({ status, turnId: "turn" });
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: "turn", kind: "reply", text: expect.stringContaining(status === "failed" ? "失败" : "中止") }));
  expect(settled).toHaveBeenCalledWith(deliver.mock.calls[0]![0], "delivered"); h.client.dispose();
});
it("cancels retry waits on disposal and settles the pending delivery as abandoned", async () => {
  vi.useFakeTimers(); const settled = vi.fn();
  const deliver = vi.fn(async () => ({ status: "retryable" as const, retryAfterMs: 160_000 }));
  const h = await setup({ ...legacy(), deliver, onDeliverySettled: settled });
  await h.client.handleMessage(message);
  const terminal = h.emit({ status: "completed", turnId: "turn", output: "result" });
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
  h.client.dispose(); await terminal;
  expect(deliver).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledWith(expect.anything(), "abandoned");
  expect(vi.getTimerCount()).toBe(0);
});
