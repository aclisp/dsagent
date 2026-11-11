import { randomUUID } from "node:crypto";
import type {
  ChatConversation, ChatDeliveryRequest, ChatDeliveryResult, ChatProvider, ChatProviderListener,
  ChatReplyTarget, ChatTurnLifecycle, InboundChatMessage,
} from "@aclisp/dsagent-chat-client";
import { WeChatApiClient, WeChatApiError, type WeChatApi } from "./api.ts";
import { loadWeChatCredentials, validateWeChatCredentials, weChatDirectory, type WeChatCredentials } from "./credentials.ts";
import { WeChatStateStore, type WeChatInboundRecord } from "./state.ts";
import { WeChatDelivery, type WeChatReplyReference } from "./delivery.ts";
import { WeChatTyping } from "./typing.ts";
import { prepareWeChatBatch, WeChatPreparationError, weChatHasAttachments } from "./messages.ts";
import { waitWeChat } from "./login.ts";

export interface WeChatChatProviderOptions {
  credentials: WeChatCredentials;
  workspacePath: string;
  stateDirectory: string;
  maxUploadBytes?: number;
  api?: WeChatApi;
  logger?: { error(message: string): void };
  batchWindowMs?: number;
  minSendIntervalMs?: number;
  typingIntervalMs?: number;
}

export class WeChatChatProvider implements ChatProvider {
  readonly providerId = "wechat";
  readonly notifyOnFailure = true;
  get resourceKey(): string { return `wechat:${this.credentials.accountId}`; }
  private status = "stopped";
  private readonly statusListeners = new Set<(status: string) => void>();
  getStatus(): string { return this.status; }
  subscribeStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }
  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) try { listener(status); } catch { /* Diagnostic observer. */ }
  }
  private readonly credentials: WeChatCredentials;
  private readonly api: WeChatApi;
  private readonly lifetime = new AbortController();
  private readonly processing = new Set<Promise<void>>();
  private readonly enqueued = new Set<string>();
  private readonly turns = new Map<string, WeChatReplyReference>();
  private state: WeChatStateStore | undefined;
  private delivery: WeChatDelivery | undefined;
  private typing: WeChatTyping | undefined;
  private listener: ChatProviderListener | undefined;
  private pollTask: Promise<void> | undefined;
  private batch: WeChatInboundRecord[] = [];
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private hardTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposed = false;
  private pausedUntil = 0;

  private readonly options: WeChatChatProviderOptions;
  constructor(options: WeChatChatProviderOptions) {
    this.options = options;
    this.credentials = validateWeChatCredentials({ ...options.credentials });
    if (!options.workspacePath.trim()) throw new Error("WeChat workspacePath must not be blank");
    this.api = options.api ?? new WeChatApiClient({ token: this.credentials.token, baseUrl: this.credentials.baseUrl });
  }
  private log = (message: string): void => { (this.options.logger ?? console).error(message); };
  private isPaused = (): boolean => Date.now() < this.pausedUntil;
  private onApiError = (error: unknown): void => {
    if (error instanceof WeChatApiError && error.code === -14) {
      this.pausedUntil = Date.now() + 60 * 60 * 1000;
      this.setStatus("paused (session expired; log in again)");
      this.log("WeChat session expired; paused for one hour. Log in again and restart to resume.");
    }
  };

  prepare(): () => void {
    if (this.disposed) throw new Error("WeChat Provider is disposed");
    if (this.state) return () => this.start();
    this.state = new WeChatStateStore(this.options.stateDirectory, this.credentials.accountId, this.credentials.ownerId);
    this.delivery = new WeChatDelivery({
      api: this.api, state: this.state, accountId: this.credentials.accountId, ownerId: this.credentials.ownerId,
      workspace: this.options.workspacePath, signal: this.lifetime.signal,
      minSendIntervalMs: this.options.minSendIntervalMs ?? 1000, isPaused: this.isPaused,
      onError: this.onApiError, onStorageError: () => this.stopForStorageError(), log: this.log,
    });
    this.typing = new WeChatTyping({ api: this.api, signal: this.lifetime.signal, isPaused: this.isPaused,
      onError: this.onApiError, ...(this.options.typingIntervalMs === undefined ? {} : { intervalMs: this.options.typingIntervalMs }) });
    return () => this.start();
  }

  start(): void {
    if (this.disposed) throw new Error("WeChat Provider is disposed");
    if (this.started) return;
    this.prepare();
    this.started = true;
    this.setStatus("connecting");
    const state = this.state!;
    if (state.interruptedCount) this.log(`WeChat retained ${state.interruptedCount} interrupted request(s).`);
    for (const record of state.pending()) this.enqueue(record);
    this.pollTask = this.poll();
    void this.api.notify("start", this.lifetime.signal).catch(this.onApiError);
  }

  subscribe(listener: ChatProviderListener): () => void {
    if (this.disposed) throw new Error("WeChat Provider is disposed");
    if (this.listener) throw new Error("WeChat Provider supports one shared Session consumer");
    this.listener = listener;
    if (this.started) for (const record of this.state!.pending()) this.enqueue(record);
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  beforeSubmit(target: ChatReplyTarget): void {
    const reference = this.delivery?.replies.get(target.messageId);
    if (!reference || reference.peer !== target.conversation.address) throw new Error("WeChat reply context is unavailable");
    try { this.state!.admit(reference.ids); }
    catch (error) { this.stopForStorageError(); throw error; }
  }
  onTurnStarted(event: ChatTurnLifecycle): void {
    if (this.disposed) return;
    const reference = event.messageId ? this.delivery?.replies.get(event.messageId) : undefined;
    if (reference) {
      this.turns.set(event.turnId, reference);
      try { this.state!.accepted(reference.ids, event.turnId); }
      catch (error) { this.stopForStorageError(); throw error; }
    }
    const token = reference?.token ?? this.state?.contextToken(event.conversation.address);
    if (token) this.typing?.start(event, token);
  }
  async onTurnFinished(event: ChatTurnLifecycle & { status: "completed" | "failed" | "aborted" }): Promise<void> {
    if (this.disposed) return;
    const reference = this.turns.get(event.turnId);
    this.turns.delete(event.turnId);
    try { if (reference) this.state!.finish(reference.ids, event.status); }
    catch (error) { this.stopForStorageError(); throw error; }
    finally { await this.typing?.stop(event.turnId); }
  }

  deliver(request: ChatDeliveryRequest): Promise<ChatDeliveryResult> {
    if (!this.started || this.disposed || this.lifetime.signal.aborted || !this.delivery) return Promise.resolve({ status: "permanent_failure" });
    return this.delivery.deliver(request);
  }
  async reply(target: ChatReplyTarget, text: string): Promise<ChatDeliveryResult> {
    return this.deliverOnce({ id: randomUUID(), kind: "reply", target, text });
  }
  async send(conversation: ChatConversation, text: string): Promise<ChatDeliveryResult> {
    return this.deliverOnce({ id: randomUUID(), kind: "send", conversation, text });
  }
  private async deliverOnce(request: ChatDeliveryRequest): Promise<ChatDeliveryResult> {
    const result = await this.deliver(request);
    await this.onDeliverySettled(request, result.status === "delivered" ? "delivered" : result.status === "permanent_failure" ? "failed" : "abandoned");
    return result;
  }
  async onDeliverySettled(request: ChatDeliveryRequest, status: string): Promise<void> {
    await this.delivery?.settled(request, status);
  }

  private async poll(): Promise<void> {
    const signal = this.lifetime.signal;
    let failures = 0;
    let timeout = 40_000;
    while (!signal.aborted) {
      try {
        if (this.isPaused()) { await waitWeChat(Math.min(this.pausedUntil - Date.now(), 60_000), signal); continue; }
        const response = await this.api.getUpdates(this.state!.cursor, signal, timeout);
        signal.throwIfAborted();
        if (!this.isPaused()) this.setStatus("connected");
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeout = Math.max(1000, Math.min(120_000, response.longpolling_timeout_ms + 5000));
        }
        let added: WeChatInboundRecord[];
        try { added = this.state!.accept(response.msgs ?? [], response.get_updates_buf); }
        catch { this.stopForStorageError(); break; }
        for (const record of added) this.enqueue(record);
        failures = 0;
        if (!response.msgs?.length) await waitWeChat(250, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) continue;
        this.onApiError(error);
        if (!this.isPaused()) {
          this.setStatus("reconnecting");
          this.log(`WeChat polling failed${error instanceof WeChatApiError ? ` (code ${error.code})` : ""}; reconnecting.`);
          await waitWeChat(++failures > 3 ? 30_000 : 5000, signal).catch(() => undefined);
        }
      }
    }
  }

  private enqueue(record: WeChatInboundRecord): void {
    if (this.enqueued.has(record.id) || this.lifetime.signal.aborted) return;
    this.enqueued.add(record.id);
    const window = this.options.batchWindowMs ?? 1000;
    if (this.batch.length) {
      this.batch.push(record);
      if (!weChatHasAttachments(record.message)) { this.flushBatch(); return; }
      clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => this.flushBatch(), window);
    } else if (weChatHasAttachments(record.message) && window > 0) {
      this.batch = [record];
      this.quietTimer = setTimeout(() => this.flushBatch(), window);
      this.hardTimer = setTimeout(() => this.flushBatch(), Math.max(window, 3000));
    } else this.runBatch([record]);
  }
  private flushBatch(): void {
    clearTimeout(this.quietTimer); clearTimeout(this.hardTimer);
    const records = this.batch; this.batch = [];
    if (records.length) this.runBatch(records);
  }
  private runBatch(records: WeChatInboundRecord[]): void {
    const task = this.processBatch(records).catch(() => {
      if (!this.lifetime.signal.aborted) this.log("WeChat inbound request handling failed.");
    }).finally(() => {
      this.processing.delete(task);
      for (const record of records) this.enqueued.delete(record.id);
    });
    this.processing.add(task);
  }

  private async processBatch(records: WeChatInboundRecord[]): Promise<void> {
    const listener = this.listener;
    if (!listener || this.lifetime.signal.aborted) return;
    const last = records.at(-1)!;
    const reference: WeChatReplyReference = {
      peer: last.message.from_user_id!, token: last.message.context_token!, ids: records.map(record => record.id),
    };
    this.delivery!.replies.set(last.id, reference);
    let accepted = false;
    try {
      if (records.some(record => (record.message.item_list ?? []).some(item => item.type === 3 && !item.voice_item?.text?.trim()))) {
        this.state!.finish(reference.ids, "unsupported");
        await this.delivery!.notice(reference.peer, reference.token, "语音没有转写，请改发文字。");
        return;
      }
      const text = await prepareWeChatBatch({
        messages: records.map(record => record.message), api: this.api, state: this.state!,
        workspace: this.options.workspacePath, maxBytes: this.options.maxUploadBytes ?? 100 * 1024 * 1024,
        signal: this.lifetime.signal,
      });
      if (!text) {
        this.state!.finish(reference.ids, "unsupported");
        await this.delivery!.notice(reference.peer, reference.token, "请发送文字、图片或文件。");
        return;
      }
      this.lifetime.signal.throwIfAborted();
      const message: InboundChatMessage = {
        messageId: last.id, dedupeKey: JSON.stringify([this.credentials.accountId, reference.ids]),
        conversation: { providerId: "wechat", type: "direct", address: reference.peer },
        sender: { providerId: "wechat", address: reference.peer }, text,
      };
      const result = await listener(message);
      accepted = result.status === "accepted";
      if (!accepted) this.state!.finish(reference.ids, result.status);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      if (error instanceof WeChatPreparationError) {
        this.state!.finish(reference.ids, "preparation_failed");
        await this.delivery!.notice(reference.peer, reference.token, error.message);
      } else {
        const admitted = reference.ids.some(id => ["admitting", "running"].includes(this.state!.status(id) ?? ""));
        this.state!.finish(reference.ids, admitted ? "interrupted" : "failed");
        await this.delivery!.notice(reference.peer, reference.token,
          admitted ? "执行结果未确认，请到 Web UI 查看。" : "消息处理失败，请重新发送。");
      }
    } finally {
      if (!accepted) this.delivery?.replies.delete(last.id);
    }
  }

  private stopForStorageError(): void {
    this.setStatus("failed (private state storage)");
    this.log("WeChat stopped: could not save private state.");
    this.lifetime.abort();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setStatus("stopped");
    this.statusListeners.clear();
    clearTimeout(this.quietTimer); clearTimeout(this.hardTimer);
    this.batch = [];
    this.lifetime.abort();
    await this.typing?.dispose();
    await Promise.allSettled([this.pollTask, ...this.processing]);
    if (this.started) await this.api.notify("stop", AbortSignal.timeout(2000)).catch(() => undefined);
    this.delivery?.replies.clear();
    this.listener = undefined;
    this.state?.close();
  }
}

export function createWeChatChatProviderFromHome(options: {
  homePath: string; workspacePath: string; maxUploadBytes?: number; enabled?: string;
  logger?: { error(message: string): void };
}): WeChatChatProvider | undefined {
  if (options.enabled && !/^(true|false|1|0)$/u.test(options.enabled)) throw new Error("IM_WECHAT_ENABLED must be true or false");
  if (options.enabled === "false" || options.enabled === "0") return undefined;
  const credentials = loadWeChatCredentials(options.homePath);
  if (!credentials) {
    if (options.enabled) throw new Error("WeChat is enabled but not bound; run dscode channels login wechat and restart");
    return undefined;
  }
  return new WeChatChatProvider({
    credentials, workspacePath: options.workspacePath, stateDirectory: weChatDirectory(options.homePath),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
  });
}
