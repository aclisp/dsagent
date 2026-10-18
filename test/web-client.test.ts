import { describe, expect, it, vi } from "vitest";
import { DeepSeekWebClient, validateWebUrl, webEndpoint } from "../packages/core/src/web-client.ts";

const auth = () => ({ apiKey: `test-${Math.random()}`, baseUrl: "https://proxy.example/deepseek/v1" });
const page = { title: "Docs", content: "# Documentation" };

describe("DeepSeek web client", () => {
  it("preserves proxy prefixes, avoids duplicate v1, and sends authenticated JSON without redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: [] }));
    const credentials = auth();
    const client = new DeepSeekWebClient(fetchImpl);
    await client.search(credentials, { query: "中文 site:example.org after:2026", ori_question: "原始问题" });
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://proxy.example/deepseek/v1/tools/search");
    expect(request?.redirect).toBe("error");
    expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${credentials.apiKey}`);
    expect(JSON.parse(request?.body as string)).toEqual({ query: "中文 site:example.org after:2026", ori_question: "原始问题", count: 5, need_content: false });
    expect(webEndpoint("https://api.deepseek.com/", "fetch")).toBe("https://api.deepseek.com/v1/tools/fetch");
  });

  it("counts Unicode characters and validates inputs before making requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: [] }));
    const client = new DeepSeekWebClient(fetchImpl);
    await client.search(auth(), { query: "😀".repeat(128), count: 50, need_content: true });
    for (const query of [" ", "😀".repeat(129)]) await expect(client.search(auth(), { query })).rejects.toThrow();
    await expect(client.search(auth(), { query: "hello", count: 51 })).rejects.toThrow();
    await expect(client.search(auth(), { query: "hello", ori_question: " " })).rejects.toThrow();
    for (const url of ["file:///etc/passwd", "https://user:secret@example.org", "not a URL"]) {
      await expect(client.fetchPage(auth(), url)).rejects.toThrow();
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(validateWebUrl("https://example.org/docs")).toBe("https://example.org/docs");
  });

  it.each([400, 401, 402, 403, 404])("does not retry HTTP %s or leak the key", async (status) => {
    const credentials = auth();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { message: `rejected ${credentials.apiKey}` } }, { status }));
    const request = new DeepSeekWebClient(fetchImpl).fetchPage(credentials, "https://example.org");
    await expect(request).rejects.toThrow(`HTTP ${status}`);
    await expect(request).rejects.not.toThrow(credentials.apiKey);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries transient errors and stops after the bounded retry count", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "busy" } }, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json(page));
    expect(await new DeepSeekWebClient(fetchImpl).fetchPage(auth(), "https://example.org")).toEqual(page);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const failed = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { message: "down" } }, { status: 503 }));
    await expect(new DeepSeekWebClient(failed).fetchPage(auth(), "https://example.org")).rejects.toThrow("HTTP 503");
    expect(failed).toHaveBeenCalledTimes(3);
  });

  it("honors cancellation and a request deadline without retrying network failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      request!.signal!.addEventListener("abort", () => reject(request!.signal!.reason), { once: true });
    }));
    const client = new DeepSeekWebClient(fetchImpl, 10);
    await expect(client.fetchPage(auth(), "https://example.org")).rejects.toThrow(/timeout/i);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(client.search(auth(), { query: "hello" }, controller.signal)).rejects.toThrow("cancelled");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects malformed successful responses rather than inventing an empty result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ title: "broken" }));
    await expect(new DeepSeekWebClient(fetchImpl).fetchPage(auth(), "https://example.org")).rejects.toThrow();
  });
});
