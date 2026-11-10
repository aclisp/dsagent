import type { ChatTurnLifecycle } from "@aclisp/dsagent-chat-client";
import type { WeChatApi } from "./api.ts";
import { waitWeChat } from "./login.ts";

interface TypingRun { controller: AbortController; ticket?: string; task: Promise<void>; peer: string }
type WeChatTypingOptions = {
    api: WeChatApi; signal: AbortSignal; isPaused: () => boolean;
    onError: (error: unknown) => void; intervalMs?: number;
  };

export class WeChatTyping {
  private readonly runs = new Map<string, TypingRun>();
  private readonly tickets = new Map<string, { ticket: string; expires: number }>();
  private readonly options: WeChatTypingOptions;
  constructor(options: WeChatTypingOptions) { this.options = options;}

  start(event: ChatTurnLifecycle, token: string): void {
    if (!token || this.runs.has(event.turnId) || this.options.signal.aborted) return;
    const controller = new AbortController();
    const run: TypingRun = { controller, peer: event.conversation.address, task: Promise.resolve() };
    this.runs.set(event.turnId, run);
    run.task = this.loop(run, token).catch(error => {
      if (!controller.signal.aborted && !this.options.signal.aborted) this.options.onError(error);
    });
  }
  private async loop(run: TypingRun, token: string): Promise<void> {
    const signal = AbortSignal.any([run.controller.signal, this.options.signal]);
    let cached = this.tickets.get(run.peer);
    if (!cached || cached.expires <= Date.now()) {
      const ticket = await this.options.api.getTypingTicket(run.peer, token, signal);
      if (!ticket) return;
      cached = { ticket, expires: Date.now() + 24 * 60 * 60 * 1000 };
      this.tickets.set(run.peer, cached);
    }
    run.ticket = cached.ticket;
    while (!signal.aborted && !this.options.isPaused()) {
      try { await this.options.api.sendTyping(run.peer, run.ticket, 1, signal); }
      catch (error) { if (!signal.aborted) this.options.onError(error); }
      await waitWeChat(this.options.intervalMs ?? 5000, signal);
    }
  }
  async stop(turnId: string): Promise<void> {
    const run = this.runs.get(turnId);
    if (!run) return;
    this.runs.delete(turnId);
    run.controller.abort();
    await run.task;
    if (run.ticket && !this.options.isPaused() && ![...this.runs.values()].some(other => other.peer === run.peer)) {
      try { await this.options.api.sendTyping(run.peer, run.ticket, 2, AbortSignal.timeout(2000)); }
      catch (error) { this.options.onError(error); }
    }
  }
  async dispose(): Promise<void> { await Promise.allSettled([...this.runs.keys()].map(id => this.stop(id))); }
}
