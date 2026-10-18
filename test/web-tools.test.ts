import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { DeepSeekWebClient } from "../packages/core/src/web-client.ts";
import { WebSnapshotStore } from "../packages/core/src/web-snapshots.ts";
import { registerWebTools } from "../packages/core/src/web-tools.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const searchResult = (content = "") => ({
  title: "Documentation", url: "https://example.org/docs", summary: "Useful summary", snippet: "Short snippet", content,
  rerank_score: 0.5, authority: -1, site_name: null, site_icon: null, date: null,
});

async function harness({ persistent = false, args = [], root: existingRoot, session: existingSession }: {
  persistent?: boolean; args?: string[]; root?: string; session?: SessionManager;
} = {}) {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "dscode-web-"));
  if (!existingRoot) roots.push(root);
  const session = existingSession ?? (persistent ? SessionManager.create(root, path.join(root, "sessions")) : SessionManager.inMemory(root));
  if (!existingSession) session.appendMessage({ role: "user", content: "Read the web", timestamp: 0 });
  const definitions = new Map<string, ToolDefinition<any, any>>();
  let active: string[] = [];
  const getAuth = vi.fn(async () => ({ auth: { apiKey: "secret", baseUrl: "https://proxy.example/v1" } }) as { auth: { apiKey: string; baseUrl: string } } | undefined);
  const ctx = { sessionManager: session, modelRegistry: { getProviderAuth: getAuth } } as unknown as ExtensionToolContext;
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) { definitions.set(tool.name, tool); },
    appendEntry(type: string, data: unknown) { session.appendCustomEntry(type, data); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ title: "Docs", content: "line one\nline two\nline three" }));
  const options = parseRuntimeArgs(["--provider", "anthropic", "--base-url", "https://configured.example", ...args]).options;
  const store = new WebSnapshotStore(path.join(root, "snapshots"));
  let networkEnabled = true;
  const controller = registerWebTools(pi, options, () => networkEnabled, new DeepSeekWebClient(fetchImpl), store);
  await controller.sync(ctx);
  return {
    root, session, ctx, definitions, getAuth, fetchImpl, controller, pi, store,
    setNetworkEnabled: (value: boolean) => { networkEnabled = value; },
    async call(name: string, input: unknown, signal?: AbortSignal) {
      return definitions.get(name)!.execute("test-call", input, signal, undefined, ctx);
    },
  };
}

describe("native web tools and snapshots", () => {
  it("rejects stale direct calls and snapshot reads when network access is disabled", async () => {
    const h = await harness();
    const snapshot = (await h.call("web_fetch", { url: "https://example.org/docs" })).structuredContent as any;
    const search = h.definitions.get("web_search")!;
    const fetchPage = h.definitions.get("web_fetch")!;
    h.setNetworkEnabled(false);
    h.getAuth.mockClear();
    await h.controller.sync(h.ctx);
    expect(h.definitions.get("web_search")?.exposure).toBe("hidden");
    expect(h.definitions.get("web_fetch")?.exposure).toBe("hidden");
    for (const [tool, input] of [
      [search, { query: "docs" }],
      [fetchPage, { url: "https://example.org/new" }],
      [fetchPage, { snapshot_id: snapshot.snapshot_id }],
    ] as const) {
      const result = await tool.execute("stale", input, undefined, undefined, h.ctx);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { message: expect.stringContaining("network access is disabled") } });
    }
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(h.getAuth).not.toHaveBeenCalled();
  });

  it("cancels an outstanding request when network access is revoked", async () => {
    const h = await harness();
    h.fetchImpl.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const pending = h.call("web_search", { query: "docs" });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce());
    h.setNetworkEnabled(false);
    await h.controller.sync(h.ctx);
    expect((await pending).isError).toBe(true);
    expect(h.store.references(h.ctx)).toHaveLength(0);
  });

  it("uses DeepSeek credentials with another chat provider and hides tools when unavailable", async () => {
    const h = await harness();
    expect([...h.definitions.keys()]).toEqual(["web_search", "web_fetch"]);
    const result = await h.call("web_fetch", { url: "https://example.org/docs" });
    expect(result.isError).not.toBe(true);
    expect(h.fetchImpl.mock.calls[0]![0]).toBe("https://proxy.example/v1/tools/fetch");
    expect(h.getAuth).toHaveBeenCalledWith("deepseek");
    h.getAuth.mockResolvedValue(undefined);
    await h.controller.sync(h.ctx);
    expect(h.definitions.get("web_search")?.exposure).toBe("hidden");
    const disabled = await harness({ args: ["--no-tools"] });
    expect(disabled.definitions.size).toBe(0);
    expect(disabled.getAuth).not.toHaveBeenCalled();
  });

  it("reuses immutable versions, refreshes explicitly, and keeps full text out of session entries", async () => {
    const h = await harness();
    const first = await h.call("web_fetch", { url: "https://example.org/docs", limit: 1 });
    const initial = first.structuredContent as any;
    expect(initial).toMatchObject({ content: "1: line one", next_offset: 2, total_lines: 3 });
    await h.call("web_fetch", { snapshot_id: initial.snapshot_id, offset: 2, limit: 1 });
    await h.call("web_fetch", { url: "https://example.org/docs" });
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    h.fetchImpl.mockResolvedValueOnce(Response.json({ title: "Changed", content: "new version" }));
    const refreshed = await h.call("web_fetch", { url: "https://example.org/docs", refresh: true });
    expect((refreshed.structuredContent as any).snapshot_id).not.toBe(initial.snapshot_id);
    expect((await h.call("web_fetch", { snapshot_id: initial.snapshot_id })).structuredContent).toMatchObject({ content: "1: line one\n2: line two\n3: line three" });
    expect(JSON.stringify(h.session.getEntries())).not.toContain("line one");
    await expect(fs.stat(path.join(h.root, "snapshots"))).rejects.toThrow();
    const reloaded = await harness({ root: h.root, session: h.session });
    expect((await reloaded.call("web_fetch", { snapshot_id: initial.snapshot_id })).structuredContent).toMatchObject({ content: "1: line one\n2: line two\n3: line three" });
    expect(reloaded.fetchImpl).not.toHaveBeenCalled();
  });

  it("restores persistent snapshots after reload and in forked sessions without network or auth", async () => {
    const h = await harness({ persistent: true });
    const first = await h.call("web_fetch", { url: "https://example.org/docs", limit: 1 });
    const id = (first.structuredContent as any).snapshot_id;
    const transcript = h.session.getSessionFile()!;
    const fork = SessionManager.forkFrom(transcript, h.root, path.join(h.root, "sessions"));
    for (const session of [SessionManager.open(transcript), fork]) {
      const restored = await harness({ root: h.root, session });
      restored.getAuth.mockRejectedValue(new Error("Auth must not be needed to read a snapshot"));
      const read = await restored.call("web_fetch", { snapshot_id: id, offset: 2 });
      expect(read.structuredContent).toMatchObject({ content: "2: line two\n3: line three", next_offset: null });
      expect(restored.fetchImpl).not.toHaveBeenCalled();
    }
    const unrelated = await harness({ root: h.root });
    expect((await unrelated.call("web_fetch", { snapshot_id: id })).isError).toBe(true);
  });

  it("performs fresh searches, preserves low-scoring results, and snapshots search bodies for offline reading", async () => {
    const h = await harness();
    h.fetchImpl.mockImplementation(async () => Response.json({ results: [searchResult("full search body"), { ...searchResult(), url: "https://example.org/other" }] }));
    const first = await h.call("web_search", { query: "docs", need_content: true });
    const results = (first.structuredContent as any).results;
    expect(results.map((result: any) => result.url)).toEqual(["https://example.org/docs", "https://example.org/other"]);
    expect(results[0]).toMatchObject({ rerank_score: 0.5, authority: -1, summary: "Useful summary" });
    expect(results[0]).not.toHaveProperty("content");
    expect(results[1].snapshot_id).toBeNull();
    const page = await h.call("web_fetch", { snapshot_id: results[0].snapshot_id });
    expect(page.structuredContent).toMatchObject({ content: "1: full search body", source: "search" });
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    await h.call("web_search", { query: "docs", need_content: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.store.references(h.ctx)).toHaveLength(2);
  });

  it("reads every character of a huge single-line Unicode page within the output limit", async () => {
    const h = await harness();
    const body = "😀中文".repeat(20_000);
    h.fetchImpl.mockResolvedValueOnce(Response.json({ title: "Long", content: body }));
    let result = await h.call("web_fetch", { url: "https://example.org/long" });
    let reconstructed = "";
    while (true) {
      const page = result.structuredContent as any;
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(50 * 1024);
      reconstructed += page.content.split("\n").map((line: string) => line.replace(/^\d+: /, "")).join("");
      if (page.next_offset === null) break;
      result = await h.call("web_fetch", { snapshot_id: page.snapshot_id, offset: page.next_offset });
    }
    expect(reconstructed).toBe(body);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects invalid reads before network and returns fetch errors without local fallback", async () => {
    const h = await harness();
    for (const args of [{}, { url: "https://example.org", snapshot_id: "bad" }, { snapshot_id: "../private" }, { url: "https://example.org", limit: 0 }, { url: "file:///etc/passwd" }]) {
      expect((await h.call("web_fetch", args)).isError).toBe(true);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.fetchImpl.mockResolvedValueOnce(Response.json({ error: { message: "Unavailable page" } }, { status: 404 }));
    const failed = await h.call("web_fetch", { url: "https://example.org/missing" });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ error: { message: expect.stringContaining("HTTP 404") } });
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(h.store.references(h.ctx)).toHaveLength(0);
  });

  it("does not save results from a cancelled or replaced session", async () => {
    for (const replaced of [false, true]) {
      const h = await harness();
      let complete!: (response: Response) => void;
      h.fetchImpl.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
      const controller = new AbortController();
      const pending = h.call("web_fetch", { url: "https://example.org" }, controller.signal);
      await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce());
      if (replaced) {
        h.getAuth.mockResolvedValue(undefined);
        await h.controller.sync(h.ctx);
      } else {
        controller.abort(new Error("cancelled"));
      }
      complete(Response.json({ title: "Late page", content: "must not be appended" }));
      expect((await pending).isError).toBe(true);
      expect(h.store.references(h.ctx)).toHaveLength(0);
    }
  });
});
