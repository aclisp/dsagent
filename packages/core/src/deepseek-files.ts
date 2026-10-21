import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const UPLOAD_BUDGET_MS = 15_000;
const COOLDOWN_MS = 60_000;
const FILE_LIFETIME_SECONDS = 86_400;
const EXPIRY_MARGIN_MS = 60_000;
const UPLOAD_CONCURRENCY = 2;
const FALLBACK_NOTICE = "DeepSeek image upload failed or timed out; some images will be sent inline (Base64). This request may be slower. Files API uploads are paused for 60 seconds.";

type RecordValue = Record<string, unknown>;
interface CachedFile { id: string; expiresAt: number }
interface InlineImage { key: string; data: string; mimeType: string; parts: RecordValue[] }

/** Request-only optimization: image bytes and provider-independent history stay canonical. */
export function registerDeepSeekFiles(pi: ExtensionAPI): void {
  const cache = new Map<string, CachedFile>();
  const pending = new Set<AbortController>();
  let scope: string | undefined;
  let generation = 0;
  let cooldownUntil = 0;
  let fallbackNotified = false;
  let usedReferences = new Set<string>();

  const reset = (): void => {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
    cache.clear();
    scope = undefined;
    cooldownUntil = 0;
    fallbackNotified = false;
    usedReferences.clear();
  };
  const notifyFallback = (ctx: ExtensionContext): void => {
    if (fallbackNotified) return;
    fallbackNotified = true;
    ctx.ui.notify(FALLBACK_NOTICE, "warning");
  };
  const pauseUploads = (ctx: ExtensionContext): void => {
    if (Date.now() < cooldownUntil) return;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    notifyFallback(ctx);
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", () => { fallbackNotified = false; });
  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "deepseek" || model.id !== "deepseek-flash" ||
      model.api !== "openai-responses" || !officialBaseUrl(model.baseUrl) ||
      !isRecord(event.payload) || event.payload.model !== "deepseek-flash") return;

    usedReferences = new Set();
    const images = collectImages(event.payload);
    if (!images.length || ctx.signal?.aborted) return;
    const requestGeneration = generation;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (requestGeneration !== generation || ctx.signal?.aborted) return;
    // A credential resolver can override the endpoint as well as the key.
    if (auth.ok && !officialBaseUrl(auth.baseUrl ?? model.baseUrl)) return;
    if (!auth.ok) {
      pauseUploads(ctx);
      return;
    }
    const headers = new Headers();
    if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
    for (const source of [model.headers, auth.headers]) {
      for (const [name, value] of Object.entries(source ?? {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
    }
    // FormData supplies its own boundary and byte count.
    headers.delete("content-type");
    headers.delete("content-length");
    if (!headers.get("authorization")) {
      pauseUploads(ctx);
      return;
    }
    const requestScope = hash(`${new URL(auth.baseUrl ?? model.baseUrl).origin}\n${headers.get("authorization")}`);
    if (scope !== requestScope) {
      cache.clear();
      cooldownUntil = 0;
      scope = requestScope;
    }

    const missing: InlineImage[] = [];
    for (const image of images) {
      const file = cache.get(image.key);
      if (!file || file.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) {
        cache.delete(image.key);
        missing.push(image);
      }
    }
    if (missing.length && Date.now() >= cooldownUntil) {
      const controller = new AbortController();
      pending.add(controller);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      const timeout = setTimeout(() => controller.abort(), UPLOAD_BUDGET_MS);
      let cursor = 0;
      try {
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, async () => {
          while (!signal.aborted && Date.now() >= cooldownUntil) {
            const image = missing[cursor++];
            if (!image) break;
            try {
              const file = await uploadImage(image, headers, signal);
              if (!signal.aborted && requestGeneration === generation && scope === requestScope) cache.set(image.key, file);
            } catch {
              if (!ctx.signal?.aborted && requestGeneration === generation && scope === requestScope) {
                pauseUploads(ctx);
              }
            }
          }
        }));
      } finally {
        clearTimeout(timeout);
        pending.delete(controller);
        if (controller.signal.aborted && !ctx.signal?.aborted && requestGeneration === generation && scope === requestScope) {
          pauseUploads(ctx);
        }
      }
    }
    if (requestGeneration !== generation || scope !== requestScope || ctx.signal?.aborted) return;

    const replacements = new Map<RecordValue, RecordValue>();
    for (const image of images) {
      const file = cache.get(image.key);
      if (!file) continue;
      usedReferences.add(image.key);
      for (const part of image.parts) {
        const { image_url: _imageUrl, ...rest } = part;
        replacements.set(part, { ...rest, file_id: file.id });
      }
    }
    if (!replacements.size) return;
    return replaceImages(event.payload, replacements);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "deepseek" ||
      message.model !== "deepseek-flash" || message.api !== "openai-responses" ||
      message.stopReason !== "error" || !usedReferences.size ||
      !isInvalidFileError(message.errorMessage ?? "")) return;
    for (const key of usedReferences) cache.delete(key);
    usedReferences.clear();
    ctx.ui.notify("DeepSeek rejected an expired or invalid image file reference. Cached references were cleared; retry your request to upload the images again.", "warning");
  });
}

function officialBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://api.deepseek.com" && !url.username && !url.password &&
      ["", "/", "/v1", "/v1/"].includes(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visit actual Responses image parts, never arbitrary tool arguments or schemas. */
function imageParts(item: unknown): unknown[] | undefined {
  if (!isRecord(item)) return;
  if ((item.role === "user" || item.role === "developer") && Array.isArray(item.content)) return item.content;
  if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && Array.isArray(item.output)) return item.output;
}

function collectImages(payload: RecordValue): InlineImage[] {
  if (!Array.isArray(payload.input)) return [];
  const images = new Map<string, InlineImage>();
  for (const item of payload.input) {
    for (const part of imageParts(item) ?? []) {
      if (!isRecord(part) || part.type !== "input_image" || typeof part.image_url !== "string" || part.file_id) continue;
      const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(part.image_url);
      if (!match) continue;
      const mimeType = match[1]!;
      const data = match[2]!.replace(/[\r\n]/g, "");
      const key = hash(`${mimeType}\n${data}`);
      const existing = images.get(key);
      if (existing) existing.parts.push(part);
      else images.set(key, { key, data, mimeType, parts: [part] });
    }
  }
  return [...images.values()];
}

function replaceImages(payload: RecordValue, replacements: Map<RecordValue, RecordValue>): RecordValue {
  return { ...payload, input: (payload.input as unknown[]).map((item) => {
    const parts = imageParts(item);
    if (!parts || !isRecord(item)) return item;
    const key = Array.isArray(item.content) ? "content" : "output";
    return { ...item, [key]: parts.map((part) => isRecord(part) ? replacements.get(part) ?? part : part) };
  }) };
}

async function uploadImage(image: InlineImage, headers: Headers, signal: AbortSignal): Promise<CachedFile> {
  const body = new FormData();
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6);
  body.set("file", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `${image.key}.${extension}`);
  body.set("purpose", "user_data");
  body.set("expires_after[anchor]", "created_at");
  body.set("expires_after[seconds]", String(FILE_LIFETIME_SECONDS));
  const response = await fetch("https://api.deepseek.com/files", { method: "POST", headers, body, signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Files API upload failed");
  }
  const file: unknown = await response.json();
  if (!isRecord(file) || typeof file.id !== "string" || !/^file-api-[\w-]+$/.test(file.id) ||
    typeof file.expires_at !== "number" || !Number.isSafeInteger(file.expires_at) ||
    file.expires_at * 1000 <= Date.now() + EXPIRY_MARGIN_MS) throw new Error("Invalid Files API response");
  return { id: file.id, expiresAt: file.expires_at * 1000 };
}

function isInvalidFileError(message: string): boolean {
  // Avoid treating unrelated validation errors that merely mention files as stale references.
  return [
    /(?:file[_ -]?id|file-api-[\w-]+|\bfile\b)[^\n]{0,160}(?:not[_ -]?(?:be[_ -]?)?found|does not exist|expired|deleted)/i,
    /(?:invalid|unknown|no such)[ _-]+file(?:[_ -]?id)?\b/i,
    /file[_ -]?id[^\n]{0,80}is invalid|file[_ -](?:not[_ -]?found|expired|deleted)/i,
    /文件[^\n]{0,80}(?:不存在|过期|删除|无效)/i,
  ].some((pattern) => pattern.test(message));
}
