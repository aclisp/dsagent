import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getLlmHttpTrace,
  withLlmHttpTrace,
  type LlmHttpTrace,
} from "./llm-metrics-transport.ts";

export type LlmMetricPhase =
  | "request_preparation"
  | "connection_setup"
  | "request_upload"
  | "first_content_wait";

type ContentKind = "thinking" | "text" | "toolcall";
type Outcome = "waiting" | "first_content" | "error" | "aborted" | "no_content";

interface Call {
  startedAt: number;
  endedAt?: number;
  firstContentAt?: number;
  firstContentKind?: ContentKind;
  provider: string;
  model: string;
  api: string;
  requestedTransport: string;
  status?: number;
  outcome: Outcome;
  trace: LlmHttpTrace;
}

interface Snapshot {
  startedAt: number;
  endedAt?: number;
  closed: boolean;
  compactionExcluded: boolean;
  outcome: Outcome;
  calls: Call[];
}

const collectors = new WeakMap<AbortSignal, LlmMetrics>();
let installed = false;

/** One in-memory report per extension/session; no prompts, headers, or content are retained. */
export class LlmMetrics {
  private latest: Snapshot | undefined;
  private signal: AbortSignal | undefined;
  private nextCallStartedAt = 0;
  private inFlight = false;

  begin(signal: AbortSignal | undefined): void {
    this.reset();
    const now = performance.now();
    this.latest = { startedAt: now, closed: false, compactionExcluded: false, outcome: "waiting", calls: [] };
    this.nextCallStartedAt = now;
    this.bind(signal);
  }

  turnStarted(signal: AbortSignal | undefined): void {
    if (!this.latest || this.latest.closed) return;
    // Keep initial user-message processing in preparation; only retries begin
    // at a later turn boundary. Otherwise the four phases omit the pre-turn gap.
    if (this.latest.calls.length) this.nextCallStartedAt = performance.now();
    this.bind(signal);
  }

  private bind(signal: AbortSignal | undefined): void {
    if (this.signal) collectors.delete(this.signal);
    this.signal = signal;
    if (signal) collectors.set(signal, this);
  }

  compactionStarted(): void {
    if (this.latest && !this.latest.closed) this.latest.compactionExcluded = true;
  }

  settle(aborted: boolean): void {
    const snapshot = this.latest;
    if (!snapshot || snapshot.closed) return;
    snapshot.closed = true;
    snapshot.endedAt = performance.now();
    if (aborted) snapshot.outcome = "aborted";
    else if (snapshot.outcome === "waiting") snapshot.outcome = "no_content";
    for (const call of snapshot.calls) call.trace.active = false;
    this.bind(undefined);
  }

  reset(): void {
    if (this.latest) for (const call of this.latest.calls) call.trace.active = false;
    this.bind(undefined);
    this.latest = undefined;
    this.inFlight = false;
  }

  capture(model: Model<Api>, signal: AbortSignal, transport: string): {
    call: Call;
    observe: (event: AssistantMessageEvent) => void;
  } | undefined {
    const snapshot = this.latest;
    if (!snapshot || snapshot.closed || this.inFlight || this.signal !== signal) return;
    this.inFlight = true;
    const call: Call = {
      startedAt: this.nextCallStartedAt,
      provider: model.provider,
      model: model.id,
      api: model.api,
      requestedTransport: transport,
      outcome: "waiting",
      trace: { signal, active: true, payloadReady: false, attempts: [], omittedAttempts: 0 },
    };
    snapshot.calls.push(call);
    return {
      call,
      observe: (event) => {
        if (this.latest !== snapshot || !call.trace.active) return;
        const kind = firstContentKind(event);
        if (kind) {
          call.firstContentAt = performance.now();
          call.firstContentKind = kind;
          call.endedAt = call.firstContentAt;
          call.outcome = snapshot.outcome = "first_content";
          snapshot.endedAt = call.firstContentAt;
          snapshot.closed = true;
          call.trace.active = false;
          this.inFlight = false;
          this.bind(undefined);
        } else if (event.type === "done" || event.type === "error") {
          call.endedAt = performance.now();
          call.outcome = snapshot.outcome = event.type === "done" ? "no_content" : event.reason;
          call.trace.active = false;
          this.inFlight = false;
          // Errors before content may be retried by the session. A successful
          // empty response still completes the initial call; never capture tools' continuations.
          if (event.type === "done" || event.reason === "aborted") {
            snapshot.endedAt = call.endedAt;
            snapshot.closed = true;
            this.bind(undefined);
          }
        }
      },
    };
  }

  report(): string {
    const snapshot = this.latest;
    if (!snapshot) return "No LLM metrics available. Submit a user message first. Metrics are kept in memory for this session only.";
    const last = snapshot.calls.at(-1);
    const elapsed = (snapshot.endedAt ?? performance.now()) - snapshot.startedAt;
    const lines = [
      "LLM metrics — initial call only (Node.js)",
      `Status: ${snapshot.outcome}${last?.firstContentKind ? ` (${last.firstContentKind})` : ""}`,
      `${snapshot.outcome === "first_content" ? "Time to first content" : "Elapsed without first content"}: ${ms(elapsed)}`,
    ];
    if (snapshot.compactionExcluded) lines.push("Compaction excluded; elapsed time may include compaction gaps.");
    if (!snapshot.calls.length) lines.push("No LLM call observed.");
    let attemptNumber = 0;
    for (const [callIndex, call] of snapshot.calls.entries()) {
      lines.push(`Provider/model: ${call.provider}/${call.model}`, `API: ${call.api}`);
      if (callIndex > 0) lines.push(`Agent retry gap: ${ms(duration(snapshot.calls[callIndex - 1]?.endedAt, call.startedAt))}`);
      if (!call.trace.attempts.length) {
        lines.push(`Transport: unavailable (requested: ${call.requestedTransport}; network breakdown unavailable)`);
        lines.push(`Attempt ${++attemptNumber}: ${call.outcome}`);
        for (const phase of PHASES) lines.push(`  ${phase}: unavailable`);
        if (call.status !== undefined) lines.push(`  http_status: ${call.status}`);
      } else {
        lines.push("Transport: HTTP (Undici)");
        call.trace.attempts.forEach((attempt, index) => {
          const final = index === call.trace.attempts.length - 1 && call.trace.omittedAttempts === 0;
          lines.push(`Attempt ${++attemptNumber}: ${final ? call.outcome : "retried"}`);
          const phases: Record<LlmMetricPhase, number | undefined> = {
            request_preparation: index === 0 ? duration(call.startedAt, attempt.createdAt) : undefined,
            // Includes waiting for a writable pooled connection, DNS, TCP, and TLS.
            connection_setup: duration(attempt.createdAt, attempt.headersSentAt),
            request_upload: duration(attempt.headersSentAt, attempt.uploadCompletedAt),
            first_content_wait: final ? duration(attempt.uploadCompletedAt, call.firstContentAt) : undefined,
          };
          for (const phase of PHASES) lines.push(`  ${phase}: ${ms(phases[phase])}`);
          if (!final) {
            const end = attempt.failedAt ?? attempt.responseHeadersAt;
            lines.push(`  retry_gap: ${ms(duration(end, call.trace.attempts[index + 1]?.createdAt))}`);
          }
          lines.push(`  request_bytes: ${attempt.requestBytes ?? "unavailable"}`);
          lines.push(`  connection_reused: ${attempt.connectionReused ?? "unavailable"}`);
          if (attempt.status !== undefined) lines.push(`  http_status: ${attempt.status}`);
        });
        if (call.trace.omittedAttempts) lines.push(`Additional attempts omitted: ${call.trace.omittedAttempts}`);
      }
    }
    lines.push("Upload ends at local socket write completion, not provider acknowledgement.");
    lines.push("Overall latency includes phases whose individual timings are unavailable.");
    return lines.join("\n");
  }
}

const PHASES: readonly LlmMetricPhase[] = ["request_preparation", "connection_setup", "request_upload", "first_content_wait"];
const ms = (value: number | undefined): string => value === undefined ? "unavailable" : `${value.toFixed(1)} ms`;
const duration = (start: number | undefined, end: number | undefined): number | undefined =>
  start === undefined || end === undefined || end < start ? undefined : end - start;

function firstContentKind(event: AssistantMessageEvent): ContentKind | undefined {
  if (event.type === "text_delta" && event.delta.length) return "text";
  if (event.type === "thinking_delta" && event.delta.length) return "thinking";
  if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
    const block = event.partial.content[event.contentIndex];
    if (block?.type === "toolCall" && (block.name.length || (event.type === "toolcall_delta" && event.delta.length))) return "toolcall";
  }
  if (event.type === "done") {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text.length) return "text";
      if (block.type === "thinking" && block.thinking.length) return "thinking";
      if (block.type === "toolCall" && block.name.length) return "toolcall";
    }
  }
  return undefined;
}

/**
 * Pi's CLI does not expose a session-construction callback. Intercept its public
 * ModelRuntime entry once, scoped by the agent's AbortSignal. Summaries and cache
 * warming use different signals and cannot consume the initial-call slot.
 */
function installRuntimeObservation(): void {
  if (installed || process.versions.bun) return;
  installed = true;
  const original = ModelRuntime.prototype.streamSimple;
  ModelRuntime.prototype.streamSimple = function (model, context, options) {
    const signal = options?.signal;
    const collector = signal && collectors.get(signal);
    if (!collector || !signal || getLlmHttpTrace()?.signal === signal) return original.call(this, model, context, options);
    const capture = collector.capture(model, signal, options?.transport ?? "provider default");
    if (!capture) return original.call(this, model, context, options);
    const { call, observe } = capture;
    const stream = withLlmHttpTrace(call.trace, () => original.call(this, model, context, {
      ...options,
      onPayload: async (payload, actualModel) => {
        const result = await options?.onPayload?.(payload, actualModel);
        call.provider = actualModel.provider;
        call.model = actualModel.id;
        call.api = actualModel.api;
        call.trace.payloadReady = true;
        return result;
      },
      onResponse: async (response, actualModel) => {
        call.status = response.status;
        await options?.onResponse?.(response, actualModel);
      },
    }));
    const push = stream.push;
    stream.push = function (event) {
      observe(event);
      push.call(this, event);
      if (!call.trace.active) this.push = push;
    };
    return stream;
  };
}

export function registerLlmMetrics(pi: ExtensionAPI): void {
  installRuntimeObservation();
  const metrics = new LlmMetrics();
  pi.on("session_start", () => metrics.reset());
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") metrics.begin(ctx.signal);
  });
  pi.on("turn_start", (_event, ctx) => metrics.turnStarted(ctx.signal));
  pi.on("session_before_compact", () => metrics.compactionStarted());
  pi.on("agent_settled", (event) => metrics.settle(event.aborted));
  pi.on("session_shutdown", () => metrics.reset());
  pi.registerCommand("x-metrics", {
    description: "Show initial LLM call latency for the last user request",
    handler: async (_args, ctx) => {
      ctx.ui.notify(process.versions.bun ? "LLM metrics require the Node.js runtime." : metrics.report(), "info");
    },
  });
}
