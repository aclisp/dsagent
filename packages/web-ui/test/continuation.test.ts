import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionPosition } from "../../core/src/session-handoff.ts";
import { createAgentSessionHost, type AgentSessionHost } from "../../http-adapter/src/agent-session-host.ts";
import type { HttpSessionControl } from "../../http-adapter/src/http-server.ts";
import { createWebUiServer } from "../src/web-ui-server.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "deepseek", model: "deepseek-flash", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-web-continuation-"));
  roots.push(root);
  vi.stubEnv("DSCODE_HOME", path.join(root, "home"));
  vi.stubEnv("DSCODE_CONFIG_PATH", path.join(root, "home/config.json"));
  vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("DEEPSEEK_API_KEY", "offline-fixture");
  vi.stubEnv("DSCODE_CREDENTIALS_STORE", "file");
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(root, "home/settings.json"), JSON.stringify({ cacheWarming: "off" }));
  const tui = await createAgentSessionHost({ cwd: root,
    runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-flash", "--sandbox", "read-only", "--no-mcp"],
    session: { type: "persistent" },
  });
  return { root, tui };
}

describe("Web continuation composition", () => {
  it("keeps the source runtime's project trust instead of enabling project resources by default", async () => {
    const { root, tui } = await setup();
    let web: AgentSessionHost | undefined;
    try {
      await mkdir(path.join(root, ".pi/extensions"), { recursive: true });
      await writeFile(path.join(root, ".pi/extensions/must-not-load.js"), 'throw new Error("UNTRUSTED_PROJECT_EXTENSION_LOADED");');
      web = await createAgentSessionHost({ cwd: root, session: { type: "persistent" },
        runtimeOptions: { ...tui.handoff.getOptions(), projectTrusted: false } });
      expect(web.session.settingsManager.isProjectTrusted()).toBe(false);
      expect(web.handoff.getOptions().projectTrusted).toBe(false);
      expect(web.diagnostics.some(item => item.message.includes("UNTRUSTED_PROJECT_EXTENSION_LOADED"))).toBe(false);
    } finally { await web?.dispose(); await tui.dispose(); }
  });

  it("resumes a null root position and an explicit session directory without choosing other history", async () => {
    const { root, tui } = await setup();
    let web: AgentSessionHost | undefined;
    try {
      const directory = path.join(root, "custom-sessions");
      const saved = SessionManager.create(root, directory);
      saved.appendMessage({ role: "user", content: "different branch", timestamp: 1 });
      saved.appendMessage(assistant("not the selected root"));
      saved.resetLeaf();
      const position = { sessionId: saved.getSessionId(), sessionFile: saved.getSessionFile()!, leafId: null };
      web = await createAgentSessionHost({ cwd: root, runtimeOptions: tui.handoff.getOptions(), sessionDir: directory,
        session: { type: "resume", id: position.sessionId, position } });
      expect(web.session.messages).toEqual([]);
      // SDK startup may append its own model/effort entries at the selected root.
      expect(web.session.sessionManager.getBranch().some(entry => entry.type === "message")).toBe(false);
      expect(web.handoff.sessionDir).toBe(directory);
      expect(web.handoff.getPosition()).toMatchObject({ sessionId: position.sessionId, sessionFile: position.sessionFile });
      const receiving = SessionManager.create(root, directory);
      loadSessionPosition(receiving, position);
      expect(receiving.getLeafId()).toBeNull();
      expect(receiving.buildSessionContext().messages).toEqual([]);
    } finally { await web?.dispose(); await tui.dispose(); }
  });

  it("continues the selected branch, accepts browser commands, and takes back the actual Web position", async () => {
    const { root, tui } = await setup();
    let web: AgentSessionHost | undefined;
    let control: HttpSessionControl | undefined;
    const manager = tui.session.sessionManager;
    manager.appendMessage({ role: "user", content: "TUI before handoff", timestamp: 1 });
    const selected = manager.appendMessage(assistant("selected branch"));
    manager.appendMessage({ role: "user", content: "unrelated branch", timestamp: 2 });
    manager.appendMessage(assistant("must not choose this leaf"));
    manager.branch(selected);
    tui.session.refreshContext();
    await tui.session.setModel(tui.session.modelRuntime.getModel("deepseek", "deepseek-v4-pro")!);
    await tui.prompt("/effort high");
    await tui.prompt("/permissions ask");
    tui.session.setActiveToolsByName(["read", "apply_patch"]);
    const snapshot = tui.handoff.getOptions();
    const position = tui.handoff.getPosition()!;
    expect(snapshot).toMatchObject({ modelId: "deepseek-v4-pro", effort: "high", permission: "ask", sandbox: "read-only", network: false, activeTools: ["read", "apply_patch"] });
    // A broken scheduler config and a supplied provider must be ignored here.
    await writeFile(path.join(root, "schedules.yaml"), "not: valid: YAML");
    const provider = { providerId: "disabled", start: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() };
    const server = await createWebUiServer({
      workspaces: { secret: root }, runtimeOptions: snapshot,
      continuationMode: true, chatAgentName: "DSCode", maxUploadBytes: 1024,
      chatProviders: [provider as never],
      onSessionControl: value => { control = value; },
      createHost: async options => {
        web = await createAgentSessionHost(options);
        web.session.agent.streamFunction = () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: "stop", message: assistant("Web reply") });
            stream.end();
          });
          return stream;
        };
        return web;
      },
    });
    try {
      await control!.activate("secret", position);
      expect(web!.session.messages.map(message => JSON.stringify(message)).join(" ")).toContain("selected branch");
      expect(JSON.stringify(web!.session.messages)).not.toContain("unrelated branch");
      expect(web!.session.model?.id).toBe("deepseek-v4-pro");
      expect(web!.session.thinkingLevel).toBe("high");
      expect(web!.session.getActiveToolNames()).toEqual(["read", "apply_patch"]);
      expect(provider.start).not.toHaveBeenCalled();
      await expect(stat(path.join(root, ".dscode/conversations.json"))).rejects.toThrow();
      const id = position.sessionId;
      const turn = async (message: string) => {
        const result = await server.inject({ method: "POST", url: `/v1/sessions/${id}/turns`, payload: { message, clientId: "phone" } });
        expect(result.statusCode).toBe(202);
        await vi.waitFor(async () => {
          expect((await server.inject(`/v1/sessions/${id}`)).json().status).toBe("idle");
        });
      };
      await turn("/effort low");
      await turn("/permissions auto");
      await turn("message from phone");
      expect(web!.session.thinkingLevel).toBe("low");
      expect(tui.session.thinkingLevel).toBe("high");
      const taken = control!.prepareTakeback("secret");
      expect(taken?.sessionId).toBe(id);
      expect(taken?.leafId).not.toBe(position.leafId);
      expect((await server.inject({ method: "POST", url: `/v1/sessions/${id}/turns`, payload: { message: "too late" } })).statusCode).toBe(503);
      await server.close();
      const receiving = SessionManager.create(root, path.join(root, "sessions"));
      loadSessionPosition(receiving, taken!);
      expect(JSON.stringify(receiving.buildSessionContext().messages)).toContain("message from phone");
      expect(JSON.stringify(receiving.buildSessionContext().messages)).not.toContain("unrelated branch");
    } finally {
      await server.close();
      await tui.dispose();
    }
  });

  it("takes back /clear's new empty session, including an empty initial TUI", async () => {
    const { root, tui } = await setup();
    expect(tui.handoff.getPosition()).toBeNull();
    let control: HttpSessionControl | undefined;
    const server = await createWebUiServer({ workspaces: { secret: root }, runtimeOptions: tui.handoff.getOptions(), continuationMode: true,
      chatAgentName: "DSCode", maxUploadBytes: 1024, onSessionControl: value => { control = value; } });
    try {
      await control!.activate("secret", null);
      const initial = (await server.inject("/v1/sessions?workspaceId=secret")).json().sessions[0].session.id;
      expect((await server.inject({ method: "DELETE", url: `/v1/sessions/${initial}` })).statusCode).toBe(204);
      const created = await server.inject({ method: "POST", url: "/v1/sessions", payload: { workspaceId: "secret" } });
      expect(created.statusCode).toBe(201);
      expect(created.json().id).not.toBe(initial);
      // Reloading a freshly cleared session must not require a file that has
      // never been written or fall back to another saved conversation.
      const cleared = created.json().id;
      expect((await server.inject({ method: "DELETE", url: `/v1/sessions/${cleared}` })).statusCode).toBe(204);
      const reloaded = await server.inject({ method: "POST", url: "/v1/sessions", payload: { workspaceId: "secret", resumeSessionId: cleared } });
      expect(reloaded.statusCode).toBe(201);
      expect(reloaded.json().id).toBe(cleared);
      expect(control!.prepareTakeback("secret")).toBeNull();
    } finally { await server.close(); await tui.dispose(); }
  });

  it("rejects Web turns, approvals and managed jobs without shutting the service down", async () => {
    const { root, tui } = await setup();
    let control: HttpSessionControl | undefined;
    let web!: AgentSessionHost;
    const server = await createWebUiServer({ workspaces: { secret: root }, runtimeOptions: tui.handoff.getOptions(), continuationMode: true,
      chatAgentName: "DSCode", maxUploadBytes: 1024, onSessionControl: value => { control = value; },
      createHost: async options => web = await createAgentSessionHost(options) });
    try {
      await control!.activate("secret", null);
      const id = web.session.sessionId;
      const response = await server.inject({ method: "POST", url: `/v1/sessions/${id}/turns`, payload: { message: "/permissions full", clientId: "phone" } });
      expect(response.statusCode).toBe(202);
      expect(() => control!.prepareTakeback("secret")).toThrow("turn");
      expect((await server.inject("/health")).statusCode).toBe(200);
      await web.abort();
      await vi.waitFor(async () => expect((await server.inject(`/v1/sessions/${id}`)).json().status).toBe("idle"));
      const tool = web.session.agent.state.tools.find(tool => tool.name === "exec_command")!;
      // Use full permissions for the fixture job, independently of transient grants.
      const state = web.handoff.getOptions();
      // The underlying tool boundary still uses current runtime permissions.
      await web.handoff.restoreOptions({ ...state, permission: "full" });
      const job = await tool.execute("background", { cmd: `${process.execPath} -e 'setTimeout(()=>{},30000)'`, yield_time_ms: 0 }, undefined);
      expect(JSON.stringify(job)).toContain("running");
      expect(() => control!.prepareTakeback("secret")).toThrow("/jobs");
      expect((await server.inject("/health")).statusCode).toBe(200);
    } finally { await server.close(); await tui.dispose(); }
  });
});
