import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createDSCodeRpcClient } from "../../core/src/rpc-client.ts";
import { createAgentSessionHost, type AgentSessionHost } from "../src/agent-session-host.ts";

describe("/x-metrics", { concurrent: false }, () => {
  let root: string;
  const servers: http.Server[] = [];
  const hosts: AgentSessionHost[] = [];
  const notices = new WeakMap<AgentSessionHost, string[]>();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-llm-metrics-"));
    vi.stubEnv("DSCODE_HOME", path.join(root, "home"));
    vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
    await fs.mkdir(path.join(root, "home"));
    await fs.writeFile(path.join(root, "home", "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false, provider: { maxRetries: 1 } },
    }));
  });

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
    await Promise.all(servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }));
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return `http://127.0.0.1:${address.port}`;
  }

  async function createHost(baseUrl: string, tools = false): Promise<AgentSessionHost> {
    const cwd = path.join(root, `workspace-${hosts.length}`);
    await fs.mkdir(cwd);
    const host = await createAgentSessionHost({
      cwd,
      runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-flash", "--transport", "responses", "--base-url", baseUrl,
        ...(tools ? ["--no-mcp", "--tools", "read"] : ["--no-tools"])],
    });
    hosts.push(host);
    const messages: string[] = [];
    notices.set(host, messages);
    host.subscribe((event) => {
      if (event.type === "ui_event" && event.event.method === "notify") messages.push(event.event.message);
    });
    await host.session.modelRuntime.setRuntimeApiKey("deepseek", "test-only-key");
    return host;
  }

  async function report(host: AgentSessionHost): Promise<string> {
    await host.prompt("/x-metrics");
    return notices.get(host)!.at(-1)!;
  }

  it("measures real DeepSeek Responses HTTP phases, ignores metadata, and freezes at first content", async () => {
    let requestCount = 0;
    let receivedBytes = 0;
    const url = await serve(async (request, response) => {
      requestCount++;
      for await (const chunk of request) receivedBytes += Buffer.byteLength(chunk);
      await delay(25);
      start(response);
      event(response, { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "" });
      await delay(70);
      text(response, "answer");
      await delay(100);
      finish(response);
    });
    const host = await createHost(url);
    expect(await report(host)).toContain("No LLM metrics available");
    let firstContent!: () => void;
    const seen = new Promise<void>((resolve) => { firstContent = resolve; });
    host.session.subscribe((message) => {
      if (message.type === "message_update" && message.assistantMessageEvent.type === "text_delta" && message.assistantMessageEvent.delta) firstContent();
    });
    const pending = host.prompt("A private prompt that must not appear in metrics");
    await seen;
    const during = await report(host);
    expect(during).toContain("Provider/model: deepseek/deepseek-flash");
    expect(during).toContain("API: openai-responses");
    expect(during).toContain("Status: first_content (text)");
    for (const phase of ["request_preparation", "connection_setup", "request_upload", "first_content_wait"]) {
      expect(during).toMatch(new RegExp(`${phase}: \\d+\\.\\d ms`));
    }
    const accounted = ["request_preparation", "connection_setup", "request_upload", "first_content_wait"]
      .reduce((sum, phase) => sum + phaseMs(during, phase), 0);
    expect(Math.abs(accounted - phaseMs(during, "Time to first content"))).toBeLessThanOrEqual(0.3);
    expect(phaseMs(during, "first_content_wait")).toBeGreaterThanOrEqual(65);
    expect(during).toContain(`request_bytes: ${receivedBytes}`);
    expect(during).toContain("http_status: 200");
    expect(during).not.toContain("private prompt");
    await pending;
    const transcript = structuredClone(host.session.messages);
    expect(await report(host)).toBe(during);
    expect(await report(host)).toBe(during);
    expect(host.session.messages).toEqual(transcript);
    expect(requestCount).toBe(1);
  });

  it("keeps retry attempts separate without treating the delay as server inference", async () => {
    let count = 0;
    const url = await serve(async (request, response) => {
      request.resume();
      await new Promise<void>((resolve) => request.on("end", resolve));
      if (++count === 1) {
        response.writeHead(503, { "content-type": "application/json", "retry-after-ms": "15" });
        response.end(JSON.stringify({ error: { message: "fixture unavailable" } }));
      } else {
        start(response);
        await delay(25);
        text(response, "recovered");
        finish(response);
      }
    });
    const host = await createHost(url);
    await host.prompt("Retry fixture");
    const output = await report(host);
    expect(count).toBe(2);
    expect(output).toContain("Attempt 1: retried");
    expect(output).toContain("Attempt 2: first_content");
    expect(output).toContain("http_status: 503");
    expect(output).toMatch(/retry_gap: \d+\.\d ms/);
    expect(output.match(/request_upload: \d+\.\d ms/g)).toHaveLength(2);
    expect(output).not.toContain("fixture unavailable");
  });

  it("does not capture tool continuations or overwrite the report with later compaction", async () => {
    let count = 0;
    const url = await serve(async (request, response) => {
      request.resume();
      await new Promise<void>((resolve) => request.on("end", resolve));
      if (++count === 1) {
        const item = { type: "function_call", id: "fc_read", call_id: "read_1", name: "read", arguments: JSON.stringify({ path: "fixture.txt" }), status: "completed" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        event(response, { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } });
        event(response, { type: "response.output_item.added", output_index: 0, item });
        event(response, { type: "response.output_item.done", output_index: 0, item });
        complete(response, [item]);
      } else {
        start(response);
        await delay(40);
        text(response, "followup");
        finish(response);
      }
    });
    const host = await createHost(url, true);
    await fs.writeFile(path.join(host.session.sessionManager.getCwd(), "fixture.txt"), "fixture\n");
    await host.prompt("Read fixture.txt");
    const initial = await report(host);
    expect(count).toBe(2);
    expect(initial).toContain("Status: first_content (toolcall)");
    expect(initial.match(/Attempt \d+:/g)).toHaveLength(1);
    await host.prompt("A second user turn to leave an older turn available for compaction");
    const beforeCompaction = await report(host);
    const beforeCompactionCount = count;
    await host.session.compact();
    expect(count).toBeGreaterThan(beforeCompactionCount);
    expect(await report(host)).toBe(beforeCompaction);
  });

  it("keeps agent-level retries in the same report", async () => {
    await fs.writeFile(path.join(root, "home", "settings.json"), JSON.stringify({
      cacheWarming: "off", compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10, provider: { maxRetries: 0 } },
    }));
    let count = 0;
    const url = await serve(async (request, response) => {
      request.resume();
      await new Promise<void>((resolve) => request.on("end", resolve));
      if (++count === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "server overloaded" } }));
      } else {
        start(response);
        text(response, "ok");
        finish(response);
      }
    });
    const host = await createHost(url);
    await host.prompt("Agent retry fixture");
    const output = await report(host);
    expect(count).toBe(2);
    expect(output).toContain("Attempt 1: error");
    expect(output).toContain("Attempt 2: first_content");
    expect(output).toContain("Status: first_content");
  });

  it("isolates simultaneous sessions and replaces only the latest user request", async () => {
    const sizes: number[] = [];
    const url = await serve(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      sizes.push(bytes.length);
      start(response);
      await delay(bytes.toString().includes("slow-session") ? 100 : 20);
      text(response, "ok");
      finish(response);
    });
    const slow = await createHost(url);
    const fast = await createHost(url);
    await Promise.all([slow.prompt("slow-session ".repeat(100)), fast.prompt("fast-session")]);
    const slowReport = await report(slow);
    const fastReport = await report(fast);
    expect(phaseMs(slowReport, "first_content_wait")).toBeGreaterThan(phaseMs(fastReport, "first_content_wait") + 50);
    expect(slowReport).toContain(`request_bytes: ${Math.max(...sizes)}`);
    expect(fastReport).toContain(`request_bytes: ${Math.min(...sizes)}`);
    await slow.prompt("new request");
    expect(await report(slow)).not.toBe(slowReport);
    expect((await report(slow)).match(/Attempt \d+:/g)).toHaveLength(1);
    expect(await report(fast)).toBe(fastReport);
  });

  it("reports cancellation before content with the observed network phases", async () => {
    let headersReceived!: () => void;
    const ready = new Promise<void>((resolve) => { headersReceived = resolve; });
    const url = await serve(async (request, response) => {
      request.resume();
      await new Promise<void>((resolve) => request.on("end", resolve));
      start(response);
      headersReceived();
    });
    const host = await createHost(url);
    const pending = host.prompt("Cancel this request");
    await ready;
    await host.abort();
    await pending;
    const output = await report(host);
    expect(output).toContain("Status: aborted");
    expect(output).toContain("first_content_wait: unavailable");
    expect(output).toMatch(/request_upload: \d+\.\d ms/);
    expect(output).not.toContain("Time to first content:");
  });

  it("keeps total first-content latency for providers without HTTP diagnostics", async () => {
    const host = await createHost("http://127.0.0.1:1");
    const runtime = host.session.modelRuntime;
    runtime.registerProvider("deepseek", {
      ...runtime.getRegisteredProviderConfig("deepseek")!,
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [{ type: "thinking", thinking: "" }], stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        void (async () => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
          await delay(25);
          message.content = [{ type: "thinking", thinking: "reasoning" }];
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        })();
        return stream;
      },
    });
    await host.prompt("Fixture provider");
    const output = await report(host);
    expect(output).toContain("Status: first_content (thinking)");
    expect(output).toMatch(/Time to first content: \d+\.\d ms/);
    expect(output).toContain("network breakdown unavailable");
    expect(output.match(/^  (?:request_preparation|connection_setup|request_upload|first_content_wait): unavailable$/gm)).toHaveLength(4);
  });

  it("works through the Node CLI/RPC entry without modifying the transcript", async () => {
    let count = 0;
    const url = await serve(async (request, response) => {
      request.resume();
      await new Promise<void>((resolve) => request.on("end", resolve));
      count++;
      start(response);
      await delay(20);
      text(response, "rpc");
      finish(response);
    });
    const client = createDSCodeRpcClient({
      cwd: root, model: "deepseek-flash",
      env: { DSCODE_HOME: path.join(root, "home"), DSCODE_SESSIONS_DIR: path.join(root, "sessions"), DEEPSEEK_API_KEY: "test-only-key", PI_OFFLINE: "1" },
      args: ["--base-url", url, "--transport", "responses", "--no-tools", "--no-session"],
    });
    const messages: string[] = [];
    client.onEvent((event) => {
      const value = event as unknown as { type: string; method?: string; message?: string };
      if (value.type === "extension_ui_request" && value.method === "notify" && value.message) messages.push(value.message);
    });
    try {
      await client.start();
      await client.promptAndWait("RPC fixture");
      const transcript = await client.getMessages();
      expect(await client.prompt("/x-metrics")).toBe("handled");
      expect(messages.at(-1)).toContain("API: openai-responses");
      expect(messages.at(-1)).toMatch(/request_upload: \d+\.\d ms/);
      expect(await client.getMessages()).toEqual(transcript);
      expect(count).toBe(1);
    } finally {
      await client.stop();
    }
  }, 15_000);
});

function event(response: http.ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function start(response: http.ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } });
  event(response, { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] } });
}

function text(response: http.ServerResponse, delta: string): void {
  event(response, { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta });
}

function finish(response: http.ServerResponse): void {
  const item = { type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }] };
  event(response, { type: "response.output_item.done", output_index: 0, item });
  complete(response, [item]);
}

function complete(response: http.ServerResponse, output: unknown[]): void {
  event(response, { type: "response.completed", response: {
    id: "resp", status: "completed", output,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  } });
  response.end();
}

function phaseMs(report: string, name: string): number {
  return Number(report.match(new RegExp(`${name}: (\\d+\\.\\d) ms`))?.[1] ?? NaN);
}
