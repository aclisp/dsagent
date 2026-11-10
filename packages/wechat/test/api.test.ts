import { describe, expect, it, vi } from "vitest";
import { WeChatApiClient, WeChatApiError, parseWeChatAesKey, WECHAT_PROTOCOL_VERSION } from "../src/api.ts";
import { parseWeixinApiJson } from "../src/lossless-json.ts";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "../src/aes-ecb.ts";

const signal = () => new AbortController().signal;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("WeChat iLink protocol", () => {
  it("preserves uint64 identifiers without rewriting quoted user text", () => {
    const result = parseWeixinApiJson<Record<string, unknown>>('{"message_id":18446744073709551615,"create_time_ms":42,"ref_msg":{"svr_id":9007199254740993,"msg_id":10},"text":"\\\"message_id\\\":123"}');
    expect(result).toEqual({ message_id: "18446744073709551615", create_time_ms: 42,
      ref_msg: { svr_id: "9007199254740993", msg_id: "10" }, text: '"message_id":123' });
    expect(() => parseWeixinApiJson('{"message_id":1.5}')).toThrow();
  });

  it("authenticates bot POSTs and keeps reply context/client identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0,"message_id":18446744073709551615}'));
    const api = new WeChatApiClient({ token: "credential-secret", fetchImpl });
    expect(await api.sendItem("peer", { type: 1, text_item: { text: "hello" } }, "context-secret", "same-client-id", signal())).toBe("18446744073709551615");
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    const headers = request!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer credential-secret");
    expect(headers.AuthorizationType).toBe("ilink_bot_token");
    expect(Buffer.from(headers["X-WECHAT-UIN"]!, "base64").toString()).toMatch(/^\d+$/u);
    expect(JSON.parse(request!.body as string)).toMatchObject({
      base_info: { channel_version: WECHAT_PROTOCOL_VERSION },
      msg: { to_user_id: "peer", client_id: "same-client-id", message_type: 2, message_state: 2, context_token: "context-secret" },
    });
  });

  it("does not mask errcode=-14 with ret=0 and redacts raw backend errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ret: 0, errcode: -14, errmsg: "credential-secret context-secret" }));
    const api = new WeChatApiClient({ token: "credential-secret", fetchImpl });
    const error = await api.getUpdates("cursor", signal()).catch(error => error as WeChatApiError);
    expect(error).toMatchObject({ code: -14, retryable: false });
    expect(String(error)).not.toContain("secret");
  });

  it("keeps QR GET requests free of bot authorization and encodes client version", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ status: "wait" }));
    const api = new WeChatApiClient({ token: "never-leak", fetchImpl });
    await api.request("ilink/bot/get_qrcode_status?qrcode=opaque", { signal: signal(), authenticated: false });
    const request = fetchImpl.mock.calls[0]![1]!;
    expect(request.method).toBe("GET");
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(request.headers).not.toHaveProperty("AuthorizationType");
    expect(request.headers).toHaveProperty("iLink-App-ClientVersion", "196608");
  });

  it.each([408, 429, 500, 503])("classifies HTTP %i as retryable", async status => {
    const api = new WeChatApiClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status })) });
    await expect(api.getUpdates("", signal())).rejects.toMatchObject({ code: status, retryable: true });
  });
  it.each([400, 401, 403])("classifies HTTP %i as permanent", async status => {
    const api = new WeChatApiClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status })) });
    await expect(api.getUpdates("", signal())).rejects.toMatchObject({ code: status, retryable: false });
  });
  it("covers a stalled response body with the request deadline", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true }); },
    }));
    const api = new WeChatApiClient({ fetchImpl });
    await expect(api.request("test", { signal: signal(), body: {}, timeoutMs: 15 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("accepts observed key encodings and rejects invalid keys without exposing them", () => {
    const key = Buffer.from("0123456789abcdef");
    expect(parseWeChatAesKey(key.toString("base64"))).toEqual(key);
    expect(parseWeChatAesKey(Buffer.from(key.toString("hex")).toString("base64"))).toEqual(key);
    expect(parseWeChatAesKey(key.toString("hex"), true)).toEqual(key);
    expect(() => parseWeChatAesKey("invalid-key-secret")).toThrow("invalid_media_key");
    expect(() => parseWeChatAesKey("invalid-key-secret")).not.toThrow(/invalid-key-secret/u);
    const bytes = Buffer.from("你好🙂");
    expect(encryptAesEcb(bytes, key).length).toBe(aesEcbPaddedSize(bytes.length));
    expect(decryptAesEcb(encryptAesEcb(bytes, key), key)).toEqual(bytes);
  });

  it("prefers an image's top-level hex AES key and full download URL", async () => {
    const key = Buffer.from("0123456789abcdef");
    const bytes = Buffer.from("image data");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(encryptAesEcb(bytes, key))));
    const api = new WeChatApiClient({ fetchImpl });
    const result = await api.download({ type: 2, image_item: { aeskey: key.toString("hex"), media: {
      encrypt_query_param: "fallback", full_url: "https://cdn.weixin.qq.com/signed", aes_key: Buffer.alloc(16).toString("base64"),
    } } }, 100, signal());
    expect(result.buffer).toEqual(bytes);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://cdn.weixin.qq.com/signed");
    expect(fetchImpl.mock.calls[0]![1]!.headers).toBeUndefined();
  });

  it("bounds media before buffering and verifies file checksums", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("too big", { headers: { "content-length": "1000" } }));
    const api = new WeChatApiClient({ fetchImpl });
    const file = { type: 4, file_item: { file_name: "a.txt", md5: "wrong", media: { full_url: "https://cdn.weixin.qq.com/file" } } };
    await expect(api.download(file, 10, signal())).rejects.toMatchObject({ code: 413 });
    fetchImpl.mockResolvedValueOnce(new Response("bad checksum"));
    await expect(api.download(file, 100, signal())).rejects.toThrow("media_checksum");
  });

  it("encrypts uploads and uses upload_full_url plus the returned CDN parameter", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ upload_full_url: "https://cdn.weixin.qq.com/upload", upload_param: "ignored" }))
      .mockResolvedValueOnce(new Response(null, { headers: { "x-encrypted-param": "download-param" } }));
    const api = new WeChatApiClient({ token: "secret", fetchImpl });
    const plain = Buffer.from("artifact contents");
    const item = await api.upload("peer", plain, "report.txt", "file", signal());
    const metadata = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    const ciphertext = Buffer.from(fetchImpl.mock.calls[1]![1]!.body as Uint8Array);
    expect(metadata).toMatchObject({ media_type: 3, rawsize: plain.length, filesize: ciphertext.length, to_user_id: "peer", no_need_thumb: true });
    expect(decryptAesEcb(ciphertext, Buffer.from(metadata.aeskey, "hex"))).toEqual(plain);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://cdn.weixin.qq.com/upload");
    expect(item.file_item).toMatchObject({ file_name: "report.txt", len: String(plain.length), media: { encrypt_query_param: "download-param" } });
    expect(parseWeChatAesKey(item.file_item!.media!.aes_key!)).toEqual(Buffer.from(metadata.aeskey, "hex"));
  });
});
