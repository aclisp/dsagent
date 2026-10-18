import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const resultSchema = z.object({
  rerank_score: z.number(),
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  summary: z.string(),
  content: z.string(),
  site_name: z.string().nullable(),
  site_icon: z.string().nullable(),
  date: z.string().nullable(),
  authority: z.number().int(),
});
const searchSchema = z.object({ results: z.array(resultSchema).max(50) });
const pageSchema = z.object({ title: z.string(), content: z.string().min(1) });
const shortQuestion = z.string().refine(
  (value) => value.trim().length > 0 && Array.from(value).length <= 128,
  "must contain 1–128 Unicode characters and cannot be blank",
);
const searchInput = z.object({
  query: shortQuestion,
  count: z.number().int().min(1).max(50).default(5),
  ori_question: shortQuestion.nullable().optional(),
  need_content: z.boolean().default(false),
});

export type WebSearchInput = z.input<typeof searchInput>;
export type WebSearchResult = z.infer<typeof resultSchema>;
export interface WebAuth {
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string | null>;
}

// Each process spaces requests independently for Search and Fetch. The server
// enforces account-wide limits across other processes and API keys via HTTP 429.
const nextRequest = new Map<string, number>();
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function validateWebUrl(value: string): string {
  if (Array.from(value).length > 8192) throw new Error("URL must be at most 8192 characters");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("URL must be an HTTP or HTTPS URL with a host"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("URL must be HTTP or HTTPS with a host and no username or password");
  }
  return url.href;
}

export function webEndpoint(baseUrl: string, operation: "search" | "fetch"): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid DeepSeek service base URL");
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix.endsWith("/v1") ? prefix : `${prefix}/v1`}/tools/${operation}`;
  return url.href;
}

export class DeepSeekWebClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async search(auth: WebAuth, input: WebSearchInput, signal?: AbortSignal) {
    const body = searchInput.parse(input);
    return searchSchema.parse(await this.request("search", auth, body, signal));
  }

  async fetchPage(auth: WebAuth, url: string, signal?: AbortSignal) {
    return pageSchema.parse(await this.request("fetch", auth, { url: validateWebUrl(url) }, signal));
  }

  private async request(operation: "search" | "fetch", auth: WebAuth, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const endpoint = webEndpoint(auth.baseUrl, operation);
    const rateKey = createHash("sha256").update(`${endpoint}\0${auth.apiKey}`).digest("hex");
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
    for (const [key, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers.set(key, value);
    }
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const now = Date.now();
      const start = Math.max(now, nextRequest.get(rateKey) ?? now);
      nextRequest.set(rateKey, start + 210);
      if (start > now) await delay(start - now, undefined, { signal });
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // Never forward provider credentials through a redirect to another origin.
      const response = await this.fetchImpl(endpoint, {
        method: "POST", headers, body: JSON.stringify(body), signal: requestSignal, redirect: "error",
      });
      if (response.ok) return JSON.parse(await readBody(response));
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const text = await readBody(response);
      if (retryable && attempt < 2) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryMs = retryAfter === null ? 0 : Number.isFinite(seconds)
          ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
        // Long server cooldowns are surfaced instead of retrying prematurely.
        if (!Number.isFinite(retryMs) || retryMs <= 30_000) {
          await delay(Math.max(250 * 2 ** attempt, retryMs || 0), undefined, { signal });
          continue;
        }
      }
      let message = text.slice(0, 500);
      try {
        const error = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof error.error?.message === "string") message = error.error.message.slice(0, 500);
      } catch { /* Non-JSON proxy errors still retain their HTTP status. */ }
      message = message.replaceAll(auth.apiKey, "[redacted]");
      throw new Error(`DeepSeek ${operation} failed (HTTP ${response.status}): ${message || response.statusText}`);
    }
  }
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("DeepSeek web response exceeds the 32 MiB limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
