import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionHost, type AgentSessionHost } from "../src/agent-session-host.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("DeepSeek Files through a real session host", { concurrent: false }, () => {
  let root: string;
  let server: http.Server;
  let host: AgentSessionHost | undefined;
  let uploadFailure: boolean;
  let referenceFailure: boolean;
  let readImage: boolean;
  let holdUpload: boolean;
  const uploads: FormData[] = [];
  const requests: string[] = [];
  const notices: string[] = [];

  beforeEach(async () => {
    uploads.length = requests.length = notices.length = 0;
    uploadFailure = referenceFailure = readImage = holdUpload = false;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-deepseek-files-"));
    vi.stubEnv("DSCODE_HOME", path.join(root, "home"));
    vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
    vi.stubEnv("PI_OFFLINE", "1");
    await fs.mkdir(path.join(root, "home"));
    await fs.writeFile(path.join(root, "home", "settings.json"), JSON.stringify({
      cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
    }));
    server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (request.url === "/files") {
        const form = await new Response(body, { headers: { "content-type": request.headers["content-type"]! } }).formData();
        uploads.push(form);
        // Make preparation measurable independently of the Responses POST.
        if (holdUpload) await new Promise<void>((resolve) => response.once("close", resolve));
        else await delay(45);
        if (response.destroyed) return;
        response.writeHead(uploadFailure ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(uploadFailure ? { error: "upload unavailable" } : {
          id: `file-api-${uploads.length}`, expires_at: Math.floor(Date.now() / 1000) + 86_400,
        }));
        return;
      }
      requests.push(body.toString());
      if (referenceFailure) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "file_id file-api-1 not found", type: "invalid_request_error" } }));
        return;
      }
      respond(response, readImage && requests.length === 1);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const nativeFetch = globalThis.fetch;
    // Keep the official model URL and real HTTP I/O; no requests leave localhost.
    const routeFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://api.deepseek.com") throw new Error("Unexpected external request in test");
      const local = `http://127.0.0.1:${address.port}${url.pathname}`;
      return nativeFetch(input instanceof Request ? new Request(local, input) : local, init);
    };
    vi.stubGlobal("fetch", routeFetch);
    host = await createAgentSessionHost({
      cwd: root, runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-flash", "--transport", "responses", "--base-url", "https://api.deepseek.com", "--no-mcp", "--tools", "read"],
    });
    host.subscribe((event) => {
      if (event.type === "ui_event" && event.event.method === "notify") notices.push(event.event.message);
    });
    await host.session.modelRuntime.setRuntimeApiKey("deepseek", "test-only-key");
  });

  afterEach(async () => {
    await host?.dispose();
    host = undefined;
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reuses uploaded images across turns while keeping session bytes and metrics semantics", async () => {
    await host!.session.prompt("Inspect this image", { source: "rpc", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.get("expires_after[seconds]")).toBe("86400");
    expect(requests[0]).toContain('"file_id":"file-api-1"');
    expect(requests[0]).not.toContain(PNG);
    expect(host!.session.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image" && part.data === PNG))).toBe(true);
    await host!.prompt("/x-metrics");
    const metrics = notices.at(-1)!;
    expect(metrics).toContain(`request_bytes: ${Buffer.byteLength(requests[0]!)}`);
    expect(metrics.match(/Attempt \d+:/g)).toHaveLength(1);
    expect(Number(metrics.match(/request_preparation: (\d+\.\d) ms/)?.[1])).toBeGreaterThanOrEqual(40);
    await host!.prompt("Follow up without any new images");
    expect(uploads).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('"file_id":"file-api-1"');
    expect(requests[1]).not.toContain(PNG);
  });

  it("warns and sends inline images during an upload outage, without repeated upload attempts", async () => {
    uploadFailure = true;
    await host!.session.prompt("Inspect", { source: "rpc", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(uploads).toHaveLength(1);
    expect(requests[0]).toContain(PNG);
    expect(notices.some((notice) => notice.includes("Base64"))).toBe(true);
    await host!.prompt("Continue");
    expect(uploads).toHaveLength(1);
    expect(requests[1]).toContain(PNG);
    expect(notices.filter((notice) => notice.includes("Base64"))).toHaveLength(2);
  });

  it("uploads actual read-tool image output once and reuses it on the next user request", async () => {
    readImage = true;
    await fs.writeFile(path.join(root, "fixture.png"), Buffer.from(PNG, "base64"));
    await host!.prompt("Read fixture.png");
    expect(requests).toHaveLength(2);
    expect(uploads).toHaveLength(1);
    expect(requests[1]).toContain('"file_id":"file-api-1"');
    expect(requests[1]).not.toContain(PNG);
    expect(host!.session.messages.some((message) => message.role === "toolResult" && message.toolName === "read" && message.content.some((part) => part.type === "image" && part.data === PNG))).toBe(true);
    await host!.prompt("Continue without reading again");
    expect(uploads).toHaveLength(1);
    expect(requests[2]).toContain('"file_id":"file-api-1"');
  });

  it("invalidates rejected references and reuploads only on the next user request", async () => {
    await host!.session.prompt("Inspect", { source: "rpc", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    referenceFailure = true;
    await host!.prompt("Continue");
    expect(requests).toHaveLength(2);
    expect(uploads).toHaveLength(1);
    expect(notices.some((notice) => notice.includes("retry your request"))).toBe(true);
    referenceFailure = false;
    await host!.prompt("Retry");
    expect(requests).toHaveLength(3);
    expect(uploads).toHaveLength(2);
    expect(requests[2]).toContain('"file_id":"file-api-2"');
  });

  it("cancels a real in-flight upload without sending a fallback LLM request", async () => {
    holdUpload = true;
    const operation = host!.session.prompt("Inspect", { source: "rpc", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await host!.abort();
    await operation;
    expect(requests).toEqual([]);
    expect(notices.some((notice) => notice.includes("Base64"))).toBe(false);
    expect(host!.session.isIdle).toBe(true);
  });
});

function respond(response: http.ServerResponse, readImage = false): void {
  const event = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const item = readImage
    ? { type: "function_call", id: "fc_read", call_id: "read_1", name: "read", arguments: JSON.stringify({ path: "fixture.png" }), status: "completed" }
    : { type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  event({ type: "response.created", response: { id: "resp", status: "in_progress", output: [] } });
  event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  if (!readImage) event({ type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "answer" });
  event({ type: "response.output_item.done", output_index: 0, item });
  event({ type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage: {
    input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
  } } });
  response.end();
}
