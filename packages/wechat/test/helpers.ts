import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { SessionPort, SessionPortTurnContext, SessionPortTurnEvent, SessionPortTurnListener, SessionPortTurnSubmission } from "../../http-adapter/src/session-port.ts";
import { createConversationAliasRegistry, createHeadlessChatClient } from "../../chat-client/src/index.ts";
import type { WeChatApi } from "../src/api.ts";
import type { GetUpdatesResp, MessageItem, WeixinMessage } from "../src/protocol.ts";
import { WeChatChatProvider } from "../src/wechat-chat-provider.ts";

export class FakeWeChatApi implements WeChatApi {
  readonly responses: GetUpdatesResp[] = [];
  private wake: (() => void) | undefined;
  private serial = 0;
  readonly cursors: string[] = [];
  push(messages: WeixinMessage[]): void {
    this.responses.push({ ret: 0, msgs: messages, get_updates_buf: `cursor-${++this.serial}` });
    this.wake?.();
  }
  async getUpdates(cursor: string, signal: AbortSignal): Promise<GetUpdatesResp> {
    this.cursors.push(cursor);
    if (!this.responses.length) await new Promise<void>((resolve, reject) => {
      const abort = () => { this.wake = undefined; reject(signal.reason); };
      this.wake = () => { signal.removeEventListener("abort", abort); this.wake = undefined; resolve(); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    return this.responses.shift()!;
  }
  sendItem = vi.fn<WeChatApi["sendItem"]>(async () => `server-${++this.serial}`);
  download = vi.fn<WeChatApi["download"]>(async item => ({
    buffer: item.type === 2 ? Buffer.from([137,80,78,71,13,10,26,10]) : Buffer.from("input document"),
    name: item.file_item?.file_name ?? "image", kind: item.type === 2 ? "image" : "file",
  }));
  upload = vi.fn<WeChatApi["upload"]>(async (_peer, bytes, name, kind) => kind === "image"
    ? { type: 2, image_item: { media: { encrypt_query_param: "uploaded", aes_key: "key" } } }
    : { type: 4, file_item: { file_name: name, len: String(bytes.length), media: { encrypt_query_param: "uploaded", aes_key: "key" } } });
  getTypingTicket = vi.fn<WeChatApi["getTypingTicket"]>(async () => "typing-ticket");
  sendTyping = vi.fn<WeChatApi["sendTyping"]>(async () => undefined);
  notify = vi.fn<WeChatApi["notify"]>(async () => undefined);
}

export class FakeSessionPort implements SessionPort {
  readonly prompts: string[] = [];
  readonly contexts: (SessionPortTurnContext | undefined)[] = [];
  readonly listeners = new Set<SessionPortTurnListener>();
  busy = false;
  private serial = 0;
  async activate() { return { sessionId: "shared" }; }
  async submitTurn(_workspace: string, message: string, context?: SessionPortTurnContext): Promise<SessionPortTurnSubmission> {
    if (this.busy) return { status: "busy" };
    this.busy = true; this.prompts.push(message); this.contexts.push(context);
    return { status: "accepted", turnId: `turn-${++this.serial}` };
  }
  subscribe(listener: SessionPortTurnListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async emit(event: SessionPortTurnEvent) { this.busy = false; await Promise.all([...this.listeners].map(listener => listener(event))); }
}
export function raw(id: string, items: MessageItem[] = [{ type: 1, text_item: { text: "check work" } }]): WeixinMessage {
  return { message_id: id, message_type: 1, from_user_id: "owner", context_token: `context-${id}`, item_list: items };
}
export const image = (): MessageItem => ({ type: 2, image_item: { media: { encrypt_query_param: "signed", aes_key: "key" } } });
export const file = (name = "input.txt"): MessageItem => ({ type: 4, file_item: { file_name: name, media: { encrypt_query_param: "signed", aes_key: "key" } } });
export const text = (body: string): MessageItem => ({ type: 1, text_item: { text: body } });

export async function createHarness(existingRoot?: string, deferStart = false) {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "dscode-wechat-provider-"));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace, { recursive: true });
  const api = new FakeWeChatApi(); const port = new FakeSessionPort(); const logger = { error: vi.fn() };
  const provider = new WeChatChatProvider({ credentials: {
    accountId: "bot", ownerId: "owner", token: "secret-bot-token", baseUrl: "https://ilinkai.weixin.qq.com", savedAt: new Date().toISOString(),
  }, workspacePath: workspace, stateDirectory: path.join(root, "state"), api, logger,
    batchWindowMs: 15, minSendIntervalMs: 0, typingIntervalMs: 20 });
  const registry = await createConversationAliasRegistry({ filePath: path.join(root, "conversations.json") });
  const client = createHeadlessChatClient({ workspaceId: "main", providerId: "wechat", conversationRegistry: registry, sessionPort: port, delivery: provider, logger: { error: vi.fn() } });
  provider.subscribe(message => client.handleMessage(message));
  if (!deferStart) provider.start();
  return { root, workspace, api, port, logger, provider, client, async close(remove = true) {
    client.dispose(); await provider.dispose(); if (remove) await fs.rm(root, { recursive: true, force: true });
  } };
}
