import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDeepSeekFiles } from "../packages/core/src/deepseek-files.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = (data = PNG) => ({ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${data}` });
const payload = (...parts: unknown[]) => ({ model: "deepseek-flash", input: [{ role: "user", content: parts.length ? parts : [image()] }] });
const fileResponse = (id = "file-api-test") => Response.json({ id, expires_at: Math.floor(Date.now() / 1000) + 86_400 });

function harness() {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  registerDeepSeekFiles({ on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const notify = vi.fn();
  const auth = { ok: true as const, apiKey: "test-key", headers: {} };
  const ctx = {
    model: { provider: "deepseek", id: "deepseek-flash", api: "openai-responses", baseUrl: "https://api.deepseek.com" },
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => auth) }, ui: { notify },
  } as unknown as ExtensionContext;
  return {
    ctx, auth, notify,
    emit: async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    transform: async (value = payload()) => handlers.get("before_provider_request")!({ payload: value }, ctx) as Promise<ReturnType<typeof payload> | undefined>,
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("DeepSeek Files extension", () => {
  it("uploads once, deduplicates images, preserves history, and uses multipart expiration", async () => {
    const upload = vi.fn(async () => fileResponse());
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const source = payload(image(), image());
    const original = structuredClone(source);
    const result = await h.transform(source);
    expect(upload).toHaveBeenCalledOnce();
    const [url, options] = upload.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/files");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(options.headers).has("content-type")).toBe(false);
    const form = options.body as FormData;
    expect(form.get("purpose")).toBe("user_data");
    expect(form.get("expires_after[anchor]")).toBe("created_at");
    expect(form.get("expires_after[seconds]")).toBe("86400");
    expect(Buffer.from(await (form.get("file") as Blob).arrayBuffer())).toEqual(Buffer.from(PNG, "base64"));
    expect(result?.input[0]?.content).toEqual([
      { type: "input_image", detail: "auto", file_id: "file-api-test" },
      { type: "input_image", detail: "auto", file_id: "file-api-test" },
    ]);
    expect(source).toEqual(original);
    expect(await h.transform(source)).toEqual(result);
    expect(upload).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("handles user, developer, function and custom tool outputs without walking tool arguments", async () => {
    const upload = vi.fn(async () => fileResponse());
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const parts = [image(), { type: "input_image", image_url: "https://example.com/a.png" }];
    const source = {
      model: "deepseek-flash", input: [
        { role: "developer", content: parts },
        { type: "function_call_output", call_id: "call", output: parts },
        { type: "custom_tool_call_output", call_id: "call2", output: parts },
        { type: "function_call", arguments: { content: [image()] } },
      ], tools: [{ parameters: { content: [image()] } }],
    };
    const result = await h.emit("before_provider_request", { payload: source }) as typeof source;
    expect(upload).toHaveBeenCalledOnce();
    for (const item of result.input.slice(0, 3)) {
      expect((item.content ?? item.output)?.[0]).toMatchObject({ file_id: "file-api-test" });
      expect((item.content ?? item.output)?.[1]).toEqual(parts[1]);
    }
    expect(result.input[3]).toBe(source.input[3]);
    expect(result.tools).toBe(source.tools);
  });

  it.each([
    { provider: "openai" }, { id: "deepseek-v4-flash-vision-exp" }, { api: "openai-completions" },
    { baseUrl: "https://gateway.example.com" }, { baseUrl: "http://api.deepseek.com" },
    { baseUrl: "https://api.deepseek.com.evil.example" },
  ])("leaves unsupported models and endpoints alone: %j", async (change) => {
    const upload = vi.fn();
    vi.stubGlobal("fetch", upload);
    const h = harness();
    Object.assign(h.ctx.model!, change);
    expect(await h.transform()).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("respects endpoint overrides and leaves other model payloads alone", async () => {
    const upload = vi.fn();
    vi.stubGlobal("fetch", upload);
    const h = harness();
    expect(await h.emit("before_provider_request", { payload: { ...payload(), model: "other-model" } })).toBeUndefined();
    vi.mocked(h.ctx.modelRegistry.getApiKeyAndHeaders).mockResolvedValue({ ok: true, apiKey: "test", headers: {}, baseUrl: "https://gateway.example.com" });
    expect(await h.transform()).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it("reuploads before expiration, on credential changes, and after session reload", async () => {
    let count = 0;
    const upload = vi.fn(async () => fileResponse(`file-api-${++count}`));
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await h.transform();
    clock.mockReturnValue(now + 86_400_000 - 30_000);
    await h.transform();
    h.auth.apiKey = "different-account";
    await h.transform();
    await h.emit("session_start");
    await h.transform();
    expect(upload).toHaveBeenCalledTimes(4);
  });

  it("warns on actual failures, stays silent during cooldown and warns again on a failed retry", async () => {
    const upload = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockImplementation(async () => fileResponse());
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const source = payload();
    expect(await h.transform(source)).toBeUndefined();
    expect(await h.transform(source)).toBeUndefined();
    expect(upload).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Base64"), "warning");
    clock.mockReturnValue(now + 30_000);
    await h.emit("before_agent_start");
    await h.transform();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    clock.mockReturnValue(now + 60_001);
    await h.emit("before_agent_start");
    expect(await h.transform()).toBeUndefined();
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(now + 120_002);
    await h.emit("before_agent_start");
    expect(await h.transform()).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(source).toEqual(payload());
  });

  it("keeps successful uploads when another image fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(fileResponse()).mockResolvedValueOnce(new Response("", { status: 500 })));
    const h = harness();
    const first = image();
    const second = image(Buffer.from("second image").toString("base64"));
    const result = await h.transform(payload(first, second));
    expect(result?.input[0]?.content).toEqual([{ type: "input_image", detail: "auto", file_id: "file-api-test" }, second]);
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("limits the entire upload batch to 15 seconds and two concurrent uploads", async () => {
    vi.useFakeTimers();
    const upload = vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const operation = h.transform(payload(image(), image("YQ=="), image("Yg==")));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await operation).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledOnce();
    await h.emit("before_agent_start");
    await h.transform();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it.each(["user", "shutdown"])("aborts uploads on %s cancellation without a fallback warning", async (cause) => {
    const upload = vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", upload);
    const h = harness();
    const controller = new AbortController();
    Object.assign(h.ctx, { signal: controller.signal });
    const operation = h.transform();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    if (cause === "user") controller.abort();
    else await h.emit("session_shutdown");
    expect(await operation).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("clears references only on explicit file errors, without replaying the model request", async () => {
    const upload = vi.fn(async () => fileResponse());
    vi.stubGlobal("fetch", upload);
    const h = harness();
    await h.transform();
    const error = { role: "assistant", provider: "deepseek", model: "deepseek-flash", api: "openai-responses", stopReason: "error" };
    for (const errorMessage of ["Rate limit exceeded", "Invalid max_output_tokens for file_id requests"]) {
      await h.emit("message_end", { message: { ...error, errorMessage } });
    }
    await h.transform();
    expect(upload).toHaveBeenCalledOnce();
    await h.emit("message_end", { message: { ...error, errorMessage: "400: file_id file-api-test not found" } });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("retry your request"), "warning");
    expect(upload).toHaveBeenCalledOnce();
    await h.transform();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("falls back without exposing credentials or response bodies on malformed upload responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "file-api-test", error: "sensitive response body" })));
    const h = harness();
    expect(await h.transform()).toBeUndefined();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.notify.mock.calls)).not.toMatch(/test-key|sensitive response body/);
  });
});
