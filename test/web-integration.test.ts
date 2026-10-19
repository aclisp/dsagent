import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionHost, type AgentSessionHost } from "../packages/http-adapter/src/agent-session-host.ts";

const roots: string[] = [];
const hosts: AgentSessionHost[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(args: string[] = [], network = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-web-host-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  vi.stubEnv("DSCODE_HOME", agentDir);
  vi.stubEnv("DSCODE_CONFIG_PATH", path.join(agentDir, "config.json"));
  vi.stubEnv("DSCODE_CREDENTIALS_STORE", "file");
  vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(root, "sessions"));
  vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-web-test-key");
  vi.stubEnv("OPENAI_API_KEY", "different-chat-key");
  new ProjectTrustStore(agentDir).set(root, true);
  const requests: Array<{ path: string; authorization: string | undefined; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.url!.endsWith("/search") ? { results: [{
      title: "Fixture docs", url: "https://example.org/docs", summary: "Fixture summary", snippet: "Fixture snippet",
      content: "cached first line\ncached second line", rerank_score: 0.5, authority: -1, site_name: null, site_icon: null, date: null,
    }] } : { title: "Fetched docs", content: "fresh first line\nfresh second line" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as { port: number };
  const create = async (extra: string[] = []) => {
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--no-mcp", ...(network ? ["--network"] : []), "--base-url", `http://127.0.0.1:${address.port}/gateway/v1`, ...args, ...extra], session: { type: "persistent" } });
    hosts.push(host);
    return host;
  };
  return { root, agentDir, requests, create };
}

async function executeCode(host: AgentSessionHost, code: string): Promise<string> {
  const message = {
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id: "web-parent", name: "codemode", arguments: { code } }],
    api: host.session.model!.api, provider: host.session.model!.provider, model: host.session.model!.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" as const, timestamp: Date.now(),
  };
  host.session.agent.state.messages.push(message);
  host.session.sessionManager.appendMessage(message);
  const tool = host.session.agent.state.tools.find((tool) => tool.name === "codemode")!;
  const result = await tool.execute("web-parent", { code });
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function expectDeferredWebTools(host: AgentSessionHost) {
  for (const name of ["web_search", "web_fetch"]) {
    expect(host.session.getActiveToolNames()).not.toContain(name);
    expect(host.session.getCallableToolNames()).toContain(name);
    expect(host.session.getAllTools().find((tool) => tool.name === name)?.exposure).toBe("deferred");
  }
  const description = host.session.agent.state.tools.find((tool) => tool.name === "codemode")!.description;
  expect(description).not.toContain("need_content");
  expect(description).not.toContain("snapshot_id");
}

describe("web tools in the Pi session runtime", () => {
  it("discovers web definitions through codemode without declaring them, and allows native tool_search loading", async () => {
    const h = await setup();
    const host = await h.create(["--tools", "read,codemode,tool_search"]);
    expectDeferredWebTools(host);
    const discovery = await executeCode(host, 'console.log(await describeTool("web_search")); console.log(await searchTools("web_fetch"));');
    expect(discovery).toContain("need_content");
    expect(discovery).toContain("snapshot_id");
    expectDeferredWebTools(host);
    expect(h.requests).toHaveLength(0);

    const search = host.session.agent.state.tools.find((tool) => tool.name === "tool_search")!;
    await search.execute("discover-web", { query: "web_search", limit: 1 });
    expect(host.session.getActiveToolNames()).toContain("web_search");
    expect(host.session.getCallableToolNames()).toContain("web_search");
    await host.session.reload();
    expect(host.session.getActiveToolNames()).toContain("web_search");
    expect(host.session.getActiveToolNames()).not.toContain("web_fetch");
  }, 15_000);

  it("hides web tools without network access and updates both loadouts when permissions change", async () => {
    const h = await setup([], false);
    const blocked = await h.create(["--provider", "openai"]);
    expect(blocked.session.getActiveToolNames()).not.toContain("web_search");
    expect(blocked.session.getCallableToolNames()).not.toContain("web_fetch");
    await executeCode(blocked, 'console.log(await tools.web_search({query:"fixture"}));');
    expect(h.requests).toHaveLength(0);
    const host = await h.create(["--permission", "full"]);
    expectDeferredWebTools(host);
    await executeCode(host, 'console.log(await tools.web_search({query:"fixture"}));');
    expect(h.requests).toHaveLength(1);
    await host.prompt("/permissions auto");
    for (const name of ["web_search", "web_fetch"]) {
      expect(host.session.getActiveToolNames()).not.toContain(name);
      expect(host.session.getCallableToolNames()).not.toContain(name);
    }
    await executeCode(host, 'console.log(await tools.web_fetch({url:"https://example.org/docs"}));');
    expect(h.requests).toHaveLength(1);
    host.subscribe((event) => {
      if (event.type === "ui_request" && event.request.method === "confirm") {
        host.uiBroker.respond({ requestId: event.request.id, confirmed: true });
      }
    });
    await host.prompt("/permissions full");
    expectDeferredWebTools(host);
    await executeCode(host, 'console.log(await tools.web_search({query:"fixture"}));');
    expect(h.requests).toHaveLength(2);
  }, 15_000);

  it("supports structured codemode calls across providers and retains snapshots through reload", async () => {
    const h = await setup();
    const host = await h.create();
    expectDeferredWebTools(host);
    await host.session.setModel({ ...host.session.model!, provider: "openai", id: "web-fixture" });
    const calls: string[] = [];
    host.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.parentToolCallId) calls.push(event.toolName);
    });
    const text = await executeCode(host, 'const result = await tools.web_search({query:"fixture",need_content:true}); const page = await tools.web_fetch({snapshot_id:result.results[0].snapshot_id,limit:1}); console.log(JSON.stringify(page));');
    expect(text).toContain("cached first line");
    expect(calls).toEqual(["web_search", "web_fetch"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ path: "/gateway/v1/tools/search", authorization: "Bearer deepseek-web-test-key", body: { query: "fixture", count: 5, need_content: true } });
    const snapshotEntry = host.session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "dscode-web-snapshot");
    const id = (snapshotEntry as any).data.id;
    await host.session.reload();
    expectDeferredWebTools(host);
    expect(await executeCode(host, `console.log((await tools.web_fetch({snapshot_id:"${id}",offset:2})).content);`)).toContain("cached second line");
    expect(h.requests).toHaveLength(1);
    expect(await fs.readdir(path.join(h.agentDir, "web-snapshots"))).toHaveLength(1);
  }, 15_000);

  it("keeps web tools deferred after credentials appear and with explicit active tool selection", async () => {
    const h = await setup();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const unavailable = await h.create(["--provider", "openai"]);
    expect(unavailable.session.getCallableToolNames()).not.toContain("web_search");
    expect(unavailable.session.getActiveToolNames()).not.toContain("web_fetch");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-web-test-key");
    await unavailable.session.reload();
    expectDeferredWebTools(unavailable);
    const explicit = await h.create(["--tools", "read,codemode"]);
    expectDeferredWebTools(explicit);
    expect(await executeCode(explicit, 'console.log((await tools.web_search({query:"fixture"})).results[0].title);')).toContain("Fixture docs");
    const disabled = await h.create(["--no-tools"]);
    expect(disabled.session.getActiveToolNames()).toEqual([]);
    expect(disabled.session.getCallableToolNames()).toEqual([]);
    expect(h.requests).toHaveLength(1);
  }, 15_000);

  it("applies ask-mode approval to codemode web calls before issuing any HTTP request", async () => {
    const h = await setup(["--permission", "ask"]);
    const host = await h.create();
    const confirmations: string[] = [];
    host.subscribe((event) => {
      if (event.type === "ui_request" && event.request.method === "confirm") {
        confirmations.push(event.request.title);
        host.uiBroker.respond({ requestId: event.request.id, confirmed: event.request.title === "Enable full access?" });
      }
    });
    await executeCode(host, 'console.log(await tools.web_search({query:"fixture"}));');
    expect(confirmations).toEqual(["Allow web_search?"]);
    expect(h.requests).toHaveLength(0);
    await host.prompt("/permissions full");
    expect(await executeCode(host, 'console.log((await tools.web_search({query:"fixture"})).results[0].title);')).toContain("Fixture docs");
    expect(h.requests).toHaveLength(1);
  }, 15_000);
});
