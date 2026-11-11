import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpUiBroker, type HttpAdapterServerHost, type HttpUiBrokerListener } from "@aclisp/dsagent-http-adapter";
import { WeChatChatProvider } from "../../wechat/src/wechat-chat-provider.ts";
import { WeChatStateStore } from "../../wechat/src/state.ts";
import { FakeWeChatApi, raw } from "../../wechat/test/helpers.ts";
import { createWebUiServer } from "../src/web-ui-server.ts";

class ControlledHost implements HttpAdapterServerHost {
  readonly session = { messages: [] };
  readonly uiBroker = createHttpUiBroker();
  readonly prompts: string[] = [];
  private pending: ((value: string | undefined) => void) | undefined;
  async prompt(message: string): Promise<string | undefined> {
    this.prompts.push(message); return new Promise(resolve => { this.pending = resolve; });
  }
  complete(text: string) { this.pending?.(text); this.pending = undefined; }
  async abort() { this.pending?.(undefined); this.pending = undefined; }
  async waitForIdle() {}
  subscribe(listener: HttpUiBrokerListener) { return this.uiBroker.subscribe(listener); }
  async dispose() { await this.abort(); this.uiBroker.dispose(); }
}
const servers: FastifyInstance[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
async function fixture(scheduled = false, immediate = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-wechat-http-")); roots.push(root);
  const workspace = path.join(root, "workspace"); await mkdir(path.join(workspace, ".dscode"), { recursive: true });
  if (scheduled) {
    await writeFile(path.join(workspace, ".dscode/schedules.yaml"), `version: 1\ntasks:\n  - id: wechat-report\n    enabled: true\n    type: once\n    at: "2026-08-24T12:00:01Z"\n    delivery: source\n    prompt: 生成微信报告\n`);
    await writeFile(path.join(workspace, ".dscode/conversations.json"), JSON.stringify({ version: 1,
      conversations: [{ alias: "conv-wechat-owner", providerId: "wechat", type: "direct", address: "owner" }], senders: [] }));
    await writeFile(path.join(workspace, ".dscode/schedules.status.json"), JSON.stringify({ version: 1, timezone: "Asia/Shanghai",
      tasks: [{ id: "wechat-report", definitionHash: "persisted", delivery: "source", sourceAlias: "conv-wechat-owner" }] }));
    const state = new WeChatStateStore(path.join(root, "state"), "bot", "owner");
    state.accept([raw("bootstrap")], "saved-cursor"); state.finish(["bootstrap"], "completed"); state.close();
  }
  const api = new FakeWeChatApi(); const hosts: ControlledHost[] = [];
  const provider = new WeChatChatProvider({ credentials: { accountId: "bot", ownerId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", savedAt: new Date().toISOString() },
    workspacePath: workspace, stateDirectory: path.join(root, "state"), api, minSendIntervalMs: 0, logger: { error() {} } });
  const server = await createWebUiServer({ workspaces: { first_workspace_01: workspace }, chatAgentName: "Test", maxUploadBytes: 1024,
    logger: false, timezone: "Asia/Shanghai", chatProviders: [provider], listPersistedSessions: async () => [],
    createHost: async () => {
      const host = new ControlledHost();
      if (immediate) host.prompt = async message => { host.prompts.push(message); return "立即完成的报告"; };
      hosts.push(host); return host;
    } });
  servers.push(server); await server.ready(); return { server, api, hosts };
}

it("shares an actual HTTP Session between WeChat and browser, without echoing browser output", async () => {
  const h = await fixture(); h.api.push([raw("wechat")]);
  await vi.waitFor(() => expect(h.hosts[0]?.prompts).toHaveLength(1));
  const sessions = await h.server.inject({ method: "GET", url: "/v1/sessions?workspaceId=first_workspace_01" });
  const sessionId = sessions.json().sessions[0].session.id as string;
  const busy = await h.server.inject({ method: "POST", url: `/v1/sessions/${sessionId}/turns`, payload: { message: "browser" } });
  expect(busy.statusCode).toBe(409);
  h.hosts[0]!.complete("wechat result");
  await vi.waitFor(() => expect(h.api.sendItem.mock.calls.some(call => call[1].text_item?.text === "wechat result")).toBe(true));
  const browser = await h.server.inject({ method: "POST", url: `/v1/sessions/${sessionId}/turns`, payload: { message: "browser" } });
  expect(browser.statusCode).toBe(202); expect(h.hosts).toHaveLength(1);
  const count = h.api.sendItem.mock.calls.length;
  h.hosts[0]!.complete("browser result");
  await vi.waitFor(async () => {
    const response = await h.server.inject({ method: "GET", url: "/v1/sessions?workspaceId=first_workspace_01" });
    expect(response.json().sessions[0].session.status).toBe("idle");
  });
  expect(h.api.sendItem).toHaveBeenCalledTimes(count);
});

it("routes a real scheduled Turn to WeChat using restored source and context", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  const h = await fixture(true); await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(h.hosts[0]?.prompts[0]).toContain("[Scheduled task: wechat-report; source=conv-wechat-owner]"));
  h.hosts[0]!.complete("微信定时报告");
  await vi.waitFor(() => expect(h.api.sendItem).toHaveBeenCalledWith("owner", expect.objectContaining({ text_item: { text: "微信定时报告" } }), "context-bootstrap", expect.any(String), expect.anything()));
  expect(h.api.cursors[0]).toBe("saved-cursor");
});

it("delivers an immediately completing scheduled Turn", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  const h = await fixture(true, true); await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(h.api.sendItem.mock.calls.some(call => call[1].text_item?.text === "立即完成的报告")).toBe(true));
});
