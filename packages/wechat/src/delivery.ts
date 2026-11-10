import { createHash, randomUUID } from "node:crypto";
import {
  collectChatOutboundArtifacts, redactChatPrivateUrls, EMPTY_COMPLETION_REPLY,
  type ChatDeliveryRequest, type ChatDeliveryResult, type ChatOutboundArtifact,
} from "@aclisp/dsagent-chat-client";
import { WeChatApiError, type WeChatApi } from "./api.ts";
import type { MessageItem } from "./protocol.ts";
import type { WeChatStateStore } from "./state.ts";
import { waitWeChat } from "./login.ts";
import { formatWeChatText, splitWeChatText, textItem } from "./messages.ts";

interface Progress {
  text: string[]; textIndex: number; artifacts: ChatOutboundArtifact[]; fileIndex: number;
  uploaded: Map<number, MessageItem>; failed: Set<number>; peer: string; token: string;
  flight?: Promise<ChatDeliveryResult>;
}
export interface WeChatReplyReference { peer: string; token: string; ids: string[] }

type WeChatDeliveryOptions = {
    api: WeChatApi; state: WeChatStateStore; accountId: string; ownerId: string;
    workspace: string; signal: AbortSignal; minSendIntervalMs: number;
    isPaused: () => boolean; onError: (error: unknown) => void; onStorageError: () => void; log: (message: string) => void;
  };

export class WeChatDelivery {
  readonly replies = new Map<string, WeChatReplyReference>();
  private readonly progress = new Map<string, Progress>();
  private sendTail: Promise<void> = Promise.resolve();
  private lastSend = 0;
  private readonly options: WeChatDeliveryOptions;
  constructor(options: WeChatDeliveryOptions) { this.options = options;}

  async deliver(request: ChatDeliveryRequest): Promise<ChatDeliveryResult> {
    const conversation = request.kind === "reply" ? request.target.conversation : request.conversation;
    if (this.options.signal.aborted || this.options.isPaused() || conversation.providerId !== "wechat" ||
      conversation.type !== "direct" || conversation.address !== this.options.ownerId) return { status: "permanent_failure" };
    let progress = this.progress.get(request.id);
    if (!progress) {
      const reference = request.kind === "reply" ? this.replies.get(request.target.messageId) : undefined;
      if (request.kind === "reply" && reference?.peer !== conversation.address) return { status: "permanent_failure" };
      const token = reference?.token ?? this.options.state.contextToken(conversation.address);
      if (!token) return { status: "permanent_failure" };
      const safeText = redactChatPrivateUrls(request.text);
      const collected = await collectChatOutboundArtifacts(safeText, this.options.workspace);
      if (this.options.signal.aborted) return { status: "permanent_failure" };
      try { this.options.state.beginDelivery(request.id); }
      catch { this.options.onStorageError(); return { status: "permanent_failure" }; }
      progress = {
        text: splitWeChatText(formatWeChatText(safeText) || EMPTY_COMPLETION_REPLY), textIndex: 0,
        artifacts: collected.artifacts, fileIndex: 0, uploaded: new Map(), failed: new Set(),
        peer: conversation.address, token,
      };
      this.progress.set(request.id, progress);
      if (collected.skipped.some(item => item.reason === "too_large" || item.reason === "too_many")) {
        progress.text.push("部分文件超过发送大小或数量限制，请通过 Web UI 获取。");
      }
    }
    if (progress.flight) return progress.flight;
    const state = progress;
    const flight = this.advance(request.id, state);
    state.flight = flight;
    try { return await flight; } finally { delete state.flight; }
  }

  private async advance(id: string, progress: Progress): Promise<ChatDeliveryResult> {
    try {
      while (progress.textIndex < progress.text.length) {
        await this.send(id, `text:${progress.textIndex}`, progress.peer, textItem(progress.text[progress.textIndex]!),
          progress.token, progress.text[progress.textIndex]!, []);
        progress.textIndex++;
      }
      while (progress.fileIndex < progress.artifacts.length) {
        const index = progress.fileIndex;
        const artifact = progress.artifacts[index]!;
        try {
          this.options.signal.throwIfAborted();
          if (this.options.isPaused()) return { status: "permanent_failure" };
          let item = progress.uploaded.get(index);
          if (!item) {
            item = await this.options.api.upload(progress.peer, artifact.buffer, artifact.name, artifact.kind, this.options.signal);
            progress.uploaded.set(index, item);
          }
          await this.send(id, `file:${index}`, progress.peer, item, progress.token, artifact.name, [artifact.path]);
          progress.fileIndex++;
        } catch (error) {
          this.options.onError(error);
          const result = this.classify(error);
          if (result.status === "retryable") return result;
          progress.failed.add(index);
          progress.fileIndex++;
        }
      }
      return { status: progress.failed.size ? "permanent_failure" : "delivered" };
    } catch (error) {
      this.options.onError(error);
      return this.classify(error);
    }
  }

  async settled(request: ChatDeliveryRequest, status: string): Promise<void> {
    const progress = this.progress.get(request.id);
    this.progress.delete(request.id);
    try { this.options.state.finishDelivery(request.id, status); }
    catch { this.options.onStorageError(); }
    if (request.kind === "reply" && request.target.conversation.providerId === "wechat" &&
      request.target.conversation.type === "direct" &&
      this.replies.get(request.target.messageId)?.peer === request.target.conversation.address) {
      this.replies.delete(request.target.messageId);
    }
    if (status === "failed" && progress && progress.textIndex === progress.text.length) {
      const missing = progress.artifacts.filter((_, index) => index >= progress.fileIndex || progress.failed.has(index));
      if (missing.length) await this.notice(progress.peer, progress.token,
        `文字结果已送达，但部分文件发送失败：${missing.map(file => file.name).join("、")}。请通过 Web UI 获取，或稍后让我重新发送。`);
    }
  }

  async notice(peer: string, token: string, message: string): Promise<void> {
    const id = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.send(id, "notice", peer, textItem(message), token, message, []); return; }
      catch (error) {
        this.options.onError(error);
        if (this.classify(error).status !== "retryable" || attempt === 2) {
          this.options.log("WeChat notice delivery failed"); return;
        }
        await waitWeChat(1000 * 2 ** attempt, this.options.signal).catch(() => undefined);
      }
    }
  }

  private classify(error: unknown): ChatDeliveryResult {
    if (this.options.signal.aborted || this.options.isPaused()) return { status: "permanent_failure" };
    if (error instanceof WeChatApiError) return error.retryable
      ? { status: "retryable", ...(error.code === -2 || error.code === 429 ? { retryAfterMs: 2000 } : {}) }
      : { status: "permanent_failure" };
    return { status: "retryable" };
  }

  private async send(id: string, part: string, peer: string, item: MessageItem, token: string, body: string, paths: string[]): Promise<void> {
    const previous = this.sendTail;
    let release!: () => void;
    this.sendTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      this.options.signal.throwIfAborted();
      if (this.options.isPaused()) throw new WeChatApiError("session_paused", -14);
      const wait = this.options.minSendIntervalMs - (Date.now() - this.lastSend);
      if (wait > 0) await waitWeChat(wait, this.options.signal);
      const clientId = `dscode-${createHash("sha256").update(JSON.stringify([this.options.accountId, id, part])).digest("hex").slice(0, 32)}`;
      this.lastSend = Date.now();
      const serverId = await this.options.api.sendItem(peer, item, token, clientId, this.options.signal);
      // A cache write failure must never resend an already-confirmed message.
      if (serverId) try { this.options.state.putQuote(peer, serverId, body, paths); }
      catch { this.options.log("WeChat outbound quote indexing failed"); }
    } finally { release(); }
  }
}
