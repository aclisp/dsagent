// Protocol flow adapted from Tencent/openclaw-weixin@0ad1ae9 (MIT).
// Copyright (C) 2026 Tencent. See ../LICENSE.tencent.
import { createHash, randomBytes } from "node:crypto";
import { encryptAesEcb, decryptAesEcb } from "./aes-ecb.ts";
import { parseWeixinApiJson } from "./lossless-json.ts";
import type { GetUpdatesResp, MessageItem, WeixinMessage } from "./protocol.ts";

export const WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WECHAT_CDN_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const WECHAT_PROTOCOL_VERSION = "3.0.0-beta-0/dscode";

export class WeChatApiError extends Error {
  readonly code: number;
  readonly retryable: boolean;
  constructor(operation: string, code: number, retryable = false) {
    // Never include raw API bodies, signed URLs, tokens, or AES keys in errors.
    super(`WeChat ${operation} failed (code ${code})`);
    this.name = "WeChatApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WeChatDownloadedMedia { buffer: Buffer; name: string; kind: "image" | "file" }
export interface WeChatApi {
  getUpdates(cursor: string, signal: AbortSignal, timeoutMs?: number): Promise<GetUpdatesResp>;
  sendItem(peer: string, item: MessageItem, contextToken: string, clientId: string, signal: AbortSignal): Promise<string | undefined>;
  download(item: MessageItem, maxBytes: number, signal: AbortSignal): Promise<WeChatDownloadedMedia>;
  upload(peer: string, bytes: Buffer, name: string, kind: "image" | "file", signal: AbortSignal): Promise<MessageItem>;
  getTypingTicket(peer: string, contextToken: string, signal: AbortSignal): Promise<string>;
  sendTyping(peer: string, ticket: string, status: 1 | 2, signal: AbortSignal): Promise<void>;
  notify(status: "start" | "stop", signal: AbortSignal): Promise<void>;
}

export function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("WeChat endpoints must use HTTPS without URL credentials or fragments");
  }
  return url;
}

/** Bounded reads also cover the response body with the request's deadline. */
async function readBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new WeChatApiError("response_too_large", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new WeChatApiError("response_too_large", 413);
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseWeChatAesKey(value: string, hex = false): Buffer {
  if (hex || /^[0-9a-fA-F]{32}$/u.test(value)) {
    if (!/^[0-9a-fA-F]{32}$/u.test(value)) throw new WeChatApiError("invalid_media_key", 400);
    return Buffer.from(value, "hex");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new WeChatApiError("invalid_media_key", 400);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    throw new WeChatApiError("invalid_media_key", 400);
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new WeChatApiError("invalid_media_key", 400);
}

type WeChatApiClientOptions = { token?: string; baseUrl?: string; fetchImpl?: typeof fetch };

export class WeChatApiClient implements WeChatApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly options: WeChatApiClientOptions;
  constructor(options: WeChatApiClientOptions) { this.options = options;
    this.baseUrl = httpsUrl(options.baseUrl ?? WECHAT_BASE_URL).toString().replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** QR status deliberately omits bot-auth headers, matching Tencent's client. */
  async request<T>(endpoint: string, options: {
    signal: AbortSignal; body?: unknown; timeoutMs?: number; authenticated?: boolean; baseUrl?: string;
  }): Promise<T> {
    const { signal, body, timeoutMs = 15_000, authenticated = true } = options;
    const url = new URL(endpoint, `${options.baseUrl ?? this.baseUrl}/`);
    httpsUrl(url.toString());
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(3 << 16),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["AuthorizationType"] = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(randomBytes(4).readUInt32BE().toString()).toString("base64");
      if (authenticated && this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    }
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await this.fetchImpl(url, {
      method: body === undefined ? "GET" : "POST", headers, signal: combined,
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WeChatApiError("http", response.status,
        response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const bytes = await readBytes(response, 8 * 1024 * 1024);
    let data: Record<string, unknown>;
    try { data = parseWeixinApiJson<Record<string, unknown>>(bytes.toString("utf8")); }
    catch { throw new WeChatApiError("invalid_json", 502, true); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new WeChatApiError("invalid_response", 502, true);
    // ret=0 must not mask a nonzero errcode.
    for (const key of ["ret", "errcode"]) {
      const code = data[key];
      if (typeof code === "number" && code !== 0) throw new WeChatApiError("api", code, code === -2);
    }
    return data as T;
  }

  private post<T>(endpoint: string, body: object, signal: AbortSignal, timeoutMs = 15_000): Promise<T> {
    return this.request(`ilink/bot/${endpoint}`, {
      signal, timeoutMs, body: { ...body, base_info: {
        channel_version: WECHAT_PROTOCOL_VERSION, bot_agent: "DSCode/1.0.0",
      } },
    });
  }

  async getUpdates(cursor: string, signal: AbortSignal, timeoutMs = 40_000): Promise<GetUpdatesResp> {
    const result = await this.post<GetUpdatesResp>("getupdates", { get_updates_buf: cursor }, signal, timeoutMs);
    if ((result.msgs !== undefined && !Array.isArray(result.msgs)) ||
      (result.get_updates_buf !== undefined && typeof result.get_updates_buf !== "string")) {
      throw new WeChatApiError("invalid_updates", 502, true);
    }
    return result;
  }
  async sendItem(peer: string, item: MessageItem, contextToken: string, clientId: string, signal: AbortSignal): Promise<string | undefined> {
    if (!contextToken) throw new WeChatApiError("missing_context", 400);
    const response = await this.post<{ message_id?: string }>("sendmessage", { msg: {
      from_user_id: "", to_user_id: peer, client_id: clientId, message_type: 2, message_state: 2,
      item_list: [item], context_token: contextToken,
    } }, signal);
    return response.message_id;
  }
  async getTypingTicket(peer: string, contextToken: string, signal: AbortSignal): Promise<string> {
    const result = await this.post<{ typing_ticket?: string }>("getconfig", {
      ilink_user_id: peer, context_token: contextToken,
    }, signal, 10_000);
    return typeof result.typing_ticket === "string" ? result.typing_ticket : "";
  }
  async sendTyping(peer: string, ticket: string, status: 1 | 2, signal: AbortSignal): Promise<void> {
    await this.post("sendtyping", { ilink_user_id: peer, typing_ticket: ticket, status }, signal, 10_000);
  }
  async notify(status: "start" | "stop", signal: AbortSignal): Promise<void> {
    await this.post(`msg/notify${status}`, {}, signal, 5_000);
  }

  async download(item: MessageItem, maxBytes: number, signal: AbortSignal): Promise<WeChatDownloadedMedia> {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new WeChatApiError("invalid_media_limit", 400);
    const image = item.type === 2 ? item.image_item : undefined;
    const file = item.type === 4 ? item.file_item : undefined;
    const media = image?.media ?? file?.media;
    const url = media?.full_url ?? (media?.encrypt_query_param
      ? `${WECHAT_CDN_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : image?.url);
    if (!url) throw new WeChatApiError("missing_media", 400);
    const key = image?.aeskey ? parseWeChatAesKey(image.aeskey, true)
      : media?.aes_key ? parseWeChatAesKey(media.aes_key) : undefined;
    if (media?.encrypt_query_param && !key) throw new WeChatApiError("missing_media_key", 400);
    const response = await this.fetchImpl(httpsUrl(url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WeChatApiError("cdn_download", response.status, response.status >= 500 || response.status === 429);
    }
    const bytes = await readBytes(response, maxBytes + 16);
    let plain: Buffer;
    try { plain = key ? decryptAesEcb(bytes, key) : bytes; }
    catch { throw new WeChatApiError("media_decryption", 400); }
    if (plain.length > maxBytes) throw new WeChatApiError("media_too_large", 413);
    if (file?.md5 && createHash("md5").update(plain).digest("hex") !== file.md5.toLowerCase()) {
      throw new WeChatApiError("media_checksum", 400);
    }
    return { buffer: plain, name: file?.file_name || "image", kind: image ? "image" : "file" };
  }

  async upload(peer: string, bytes: Buffer, name: string, kind: "image" | "file", signal: AbortSignal): Promise<MessageItem> {
    const key = randomBytes(16);
    const hex = key.toString("hex");
    const filekey = randomBytes(16).toString("hex");
    const encrypted = encryptAesEcb(bytes, key);
    const result = await this.post<{ upload_full_url?: string; upload_param?: string }>("getuploadurl", {
      filekey, media_type: kind === "image" ? 1 : 3, to_user_id: peer,
      rawsize: bytes.length, rawfilemd5: createHash("md5").update(bytes).digest("hex"),
      filesize: encrypted.length, aeskey: hex, no_need_thumb: true,
    }, signal);
    const url = result.upload_full_url || (result.upload_param
      ? `${WECHAT_CDN_URL}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param)}&filekey=${filekey}` : undefined);
    if (!url) throw new WeChatApiError("missing_upload_url", 502, true);
    const response = await this.fetchImpl(httpsUrl(url), {
      method: "POST", headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(encrypted), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    const downloadParam = response.headers.get("x-encrypted-param");
    await response.body?.cancel();
    if (!response.ok) throw new WeChatApiError("cdn_upload", response.status, response.status >= 500 || response.status === 429);
    if (!downloadParam) throw new WeChatApiError("missing_download_param", 502, true);
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(hex).toString("base64"), encrypt_type: 1 };
    return kind === "image"
      ? { type: 2, image_item: { media, mid_size: encrypted.length } }
      : { type: 4, file_item: { media, file_name: name, len: String(bytes.length) } };
  }
}
