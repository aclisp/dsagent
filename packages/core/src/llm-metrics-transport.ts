import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";

export interface LlmHttpAttempt {
  createdAt: number;
  headersSentAt?: number;
  uploadCompletedAt?: number;
  responseHeadersAt?: number;
  failedAt?: number;
  requestBytes?: number;
  status?: number;
  connectionReused?: boolean;
}

export interface LlmHttpTrace {
  signal: AbortSignal;
  active: boolean;
  payloadReady: boolean;
  attempts: LlmHttpAttempt[];
  omittedAttempts: number;
}

const context = new AsyncLocalStorage<LlmHttpTrace>();
const requests = new WeakMap<object, { trace: LlmHttpTrace; attempt: LlmHttpAttempt; socket?: Socket }>();
const EMPTY = Buffer.alloc(0);
const MAX_ATTEMPTS = 64;
let installed = false;

export const getLlmHttpTrace = (): LlmHttpTrace | undefined => context.getStore();

export function withLlmHttpTrace<T>(trace: LlmHttpTrace, callback: () => T): T {
  installHttpObservation();
  return context.run(trace, callback);
}

/** Passive request correlation: never replace fetch, dispatchers, headers, or payloads. */
function installHttpObservation(): void {
  if (installed || process.versions.bun) return;
  installed = true;

  channel("undici:request:create").subscribe((value) => {
    const trace = context.getStore();
    const { request } = value as { request: object & { method?: string; contentLength?: number } };
    // Auth refreshes and WebSocket upgrades are not LLM HTTP request attempts.
    if (!trace?.active || !trace.payloadReady || request.method !== "POST") return;
    if (trace.attempts.length >= MAX_ATTEMPTS) {
      trace.omittedAttempts++;
      return;
    }
    const attempt: LlmHttpAttempt = { createdAt: performance.now() };
    if (typeof request.contentLength === "number" && request.contentLength >= 0) {
      attempt.requestBytes = request.contentLength;
    }
    trace.attempts.push(attempt);
    requests.set(request, { trace, attempt });
  });

  channel("undici:client:sendHeaders").subscribe((value) => {
    const { request, socket } = value as { request: object; socket: Socket };
    const entry = requests.get(request);
    if (!entry?.trace.active) return;
    entry.socket = socket;
    entry.attempt.headersSentAt = performance.now();
    entry.attempt.connectionReused = socket.bytesWritten > 0;
  });

  channel("undici:request:bodySent").subscribe((value) => {
    const { request } = value as { request: object };
    const entry = requests.get(request);
    if (!entry?.trace.active || !entry.socket) return;
    const socket = entry.socket;
    const complete = (error?: Error | null): void => {
      if (!error && entry.trace.active) entry.attempt.uploadCompletedAt = performance.now();
      delete entry.socket;
    };
    // bodySent alone can mean "queued in the socket". A zero-byte write callback
    // follows the pending body writes without adding bytes to the HTTP request.
    // This measures local socket write completion, never acknowledgement by the peer.
    if (socket.writableLength === 0) complete();
    else if (!socket.destroyed && socket.writable) {
      try { socket.write(EMPTY, complete); } catch { /* Diagnostics must not affect the request. */ }
    }
  });

  channel("undici:request:headers").subscribe((value) => {
    const { request, response } = value as { request: object; response: { statusCode: number } };
    const entry = requests.get(request);
    if (!entry?.trace.active) return;
    entry.attempt.responseHeadersAt = performance.now();
    entry.attempt.status = response.statusCode;
  });

  channel("undici:request:error").subscribe((value) => {
    const { request } = value as { request: object };
    const entry = requests.get(request);
    if (entry?.trace.active) entry.attempt.failedAt = performance.now();
  });
}
