import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import type { DSCodeSessionRuntime } from "../packages/core/src/session-handoff.ts";
import { getWebWorkspaceSettings, saveWebWorkspaceSettings } from "../packages/core/src/settings.ts";
import {
  parseWebArguments, resolveWebPreferences, webOrigin, WebContinuationController,
  type StartWebContinuationOptions, type WebContinuationService,
} from "../packages/core/src/web-continuation.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(root?: string) {
  if (!root) {
    root = await mkdtemp(path.join(os.tmpdir(), "dscode-handoff-"));
    roots.push(root);
  }
  vi.stubEnv("DSCODE_CONFIG_PATH", path.join(root, "config.json"));
  vi.stubEnv("DSCODE_HOME", root);
  const options = { ...parseRuntimeArgs(["--no-mcp"]).options, cwd: root };
  const runtime: DSCodeSessionRuntime = {
    sessionDir: path.join(root, "sessions"),
    assertIdle: vi.fn(), getPosition: vi.fn(() => null),
    getOptions: vi.fn(() => ({ ...options, effort: "high" as const, activeTools: ["read"], toolsExplicit: true })),
    restoreOptions: vi.fn(async () => {}),
  };
  const service: WebContinuationService = {
    url: "http://127.0.0.1:8899/chat/private-id", qr: "QR",
    prepareTakeback: vi.fn(() => null), close: vi.fn(async () => {}),
  };
  const start = vi.fn(async (_options: StartWebContinuationOptions) => service);
  const controller = new WebContinuationController(start);
  const commands = new Map<string, Pick<RegisteredCommand, "handler" | "getArgumentCompletions">>();
  const pi = { registerCommand: (name: string, command: typeof commands extends Map<string, infer T> ? T : never) => commands.set(name, command) } as unknown as ExtensionAPI;
  const ui = { notify: vi.fn(), setWidget: vi.fn() };
  const sessionManager = { getSessionName: vi.fn<() => string | undefined>() };
  const ctx = { mode: "tui", cwd: root, ui, sessionManager, newSession: vi.fn(async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
    controller.attach(runtime, ctx);
    await options?.withSession?.({ ...ctx, sendMessage: vi.fn(), sendUserMessage: vi.fn() });
    return { cancelled: false };
  }) } as unknown as ExtensionCommandContext;
  controller.register(pi, options);
  controller.attach(runtime, ctx);
  const run = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
  const completeWeb = (prefix: string) => commands.get("web")!.getArgumentCompletions!(prefix);
  return { root, options, runtime, service, start, controller, ctx, sessionManager, ui, run, completeWeb };
}

describe("Web network preferences", () => {
  it("guides argument entry without overwriting previous options or requiring example values", async () => {
    const { completeWeb } = await setup();
    expect((await completeWeb(""))?.map(item => item.label)).toEqual(["--host", "--port", "--url", "status"]);
    expect((await completeWeb("--ho"))?.[0]?.value).toBe("--host ");
    expect((await completeWeb("--host "))?.map(item => item.label)).toContain("127.0.0.1");
    expect((await completeWeb("--host ::1 --port=8"))?.[0]?.value).toBe("--host ::1 --port=8899");
    expect((await completeWeb("--port 8899")) ?? []).toEqual([]);
    expect((await completeWeb("--port 9123")) ?? []).toEqual([]);
    expect((await completeWeb("--host ::1 --port 9123 "))?.map(item => item.label)).toEqual(["--url"]);
    expect(await completeWeb("status")).toBeNull();
  });

  it("orders matching values by source and deduplicates them in favor of the highest priority", async () => {
    const { root, completeWeb } = await setup();
    await writeFile(path.join(root, "config.json"), JSON.stringify({ web: {
      host: "[::1]", port: 9000, url: "https://global.example",
      workspaces: { [realpathSync(root)]: { host: "::1", port: 8900, url: "https://workspace.example/" } },
    } }));

    expect(await completeWeb("--port ")).toEqual([
      { label: "8900", value: "--port 8900", description: "Saved for this workspace" },
      { label: "9000", value: "--port 9000", description: "Global default" },
      { label: "8899", value: "--port 8899", description: "Built-in default" },
    ]);
    expect((await completeWeb("--host ::1 --port=8"))?.map(item => item.value)).toEqual([
      "--host ::1 --port=8900", "--host ::1 --port=8899",
    ]);
    expect((await completeWeb("--host "))?.map(({ label, description }) => [label, description])).toEqual([
      ["::1", "Saved for this workspace"], ["127.0.0.1", "Built-in default"],
    ]);
    expect((await completeWeb("--url "))?.map(item => item.label)).toEqual([
      "https://workspace.example", "https://global.example",
    ]);
  });

  it("explains the derived browser origin without offering it as a value", async () => {
    const { completeWeb } = await setup();
    expect(await completeWeb("--u")).toEqual([
      { label: "--url", value: "--url ", description: "Browser origin (derived from host and port if unset)" },
    ]);
    expect(await completeWeb("--url ")).toEqual([]);
  });

  it("prioritizes the browser origin when the effective host is a wildcard and no URL is configured", async () => {
    const { root, completeWeb } = await setup();
    const prefix = "--host=0.0.0.0 --port 8900 ";
    expect((await completeWeb(prefix))?.[0]).toMatchObject({ label: "--url", description: expect.stringContaining("192.168.1.20:8900") });
    expect(await completeWeb(`${prefix}--url `)).toEqual([]);
    const file = path.join(root, "config.json");
    await writeFile(file, JSON.stringify({ web: { host: "::" } }));
    expect((await completeWeb(""))?.[0]?.label).toBe("--url");
    await writeFile(file, JSON.stringify({ web: { host: "::", url: "https://saved.example" } }));
    expect((await completeWeb(""))?.[0]?.label).toBe("--host");
    await writeFile(file, JSON.stringify({ web: { host: "::", workspaces: {
      [realpathSync(root)]: { url: "https://workspace.example" },
    } } }));
    expect((await completeWeb(""))?.[0]?.label).toBe("--host");
  });

  it("uses explicit, saved, then default parameters and separates origin from binding", () => {
    expect(resolveWebPreferences({}, {})).toEqual({ host: "127.0.0.1", port: 8899 });
    const saved = { host: "0.0.0.0", port: 1234, url: "https://agent.example.com/" };
    const resolved = resolveWebPreferences(saved, parseWebArguments("--port=8899") as object);
    expect(resolved).toEqual({ host: "0.0.0.0", port: 8899, url: "https://agent.example.com" });
    expect(webOrigin(resolved)).toBe("https://agent.example.com");
    expect(webOrigin(resolveWebPreferences({}, { host: "::1" }))).toBe("http://[::1]:8899");
    expect(() => resolveWebPreferences({}, { host: "::" })).toThrow("requires --url");
    for (const url of ["ftp://host", "https://host/path", "https://host/?secret=1", "https://user:pass@host"]) {
      expect(() => resolveWebPreferences({}, { url })).toThrow();
    }
    for (const args of ["--port 0", "--port NaN", "--port 65536"]) {
      expect(() => resolveWebPreferences({}, parseWebArguments(args) as object)).toThrow("port");
    }
    expect(() => parseWebArguments("--host")).toThrow("requires a value");
    expect(() => parseWebArguments("--wat yes")).toThrow("Usage");
  });

  it("resolves workspace aliases to the same saved ID and network parameters", async () => {
    const { root } = await setup();
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const id = "a".repeat(32);
    await saveWebWorkspaceSettings({ cwd: alias, id, overrides: { port: 8900, url: "https://workspace.example" } });
    const expected = { id, workspace: { port: 8900, url: "https://workspace.example" }, needsMigration: false };
    expect(getWebWorkspaceSettings(workspace)).toMatchObject(expected);
    expect(getWebWorkspaceSettings(alias)).toMatchObject(expected);
    expect(getWebWorkspaceSettings(root)).toMatchObject({ id: undefined, workspace: {} });
    if (process.platform !== "win32") expect((await stat(path.join(root, "config.json"))).mode & 0o777).toBe(0o600);
    const key = realpathSync(workspace);
    const invalidSettings = [
      { workspaces: [] }, { workspaces: "invalid" }, { workspaces: { [key]: { id: "invalid" } } },
      { workspaceIds: { [key]: "invalid" } },
    ];
    for (const web of invalidSettings) {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ web }));
      expect(() => getWebWorkspaceSettings(workspace)).toThrow();
    }
  });
});

describe("TUI Web ownership", () => {
  it("migrates legacy entries after a successful start without changing the workspace ID", async () => {
    const h = await setup();
    const key = realpathSync(h.root);
    const other = path.join(key, "other");
    const id = "a".repeat(32);
    const otherId = "b".repeat(32);
    const file = path.join(h.root, "config.json");
    const legacy = { web: {
      port: 8899,
      workspaceIds: { [key]: id, [other]: otherId },
      workspaceOverrides: { [key]: { port: 8900 }, [other]: { port: 8901 } },
    } };
    await writeFile(file, JSON.stringify(legacy));

    h.start.mockRejectedValueOnce(new Error("port is in use"));
    await h.run("web");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(legacy);

    await h.run("web");
    expect(h.start.mock.calls[1]![0]).toMatchObject({ workspaceId: id, network: { port: 8900 } });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ web: {
      port: 8899,
      workspaces: { [key]: { id, port: 8900 } },
      workspaceIds: { [other]: otherId },
      workspaceOverrides: { [other]: { port: 8901 } },
    } });
    await h.controller.close();
  });

  it("passes the current session name only when starting Web", async () => {
    const h = await setup();
    h.sessionManager.getSessionName.mockReturnValue("Backend refactor");
    await h.run("web");
    expect(h.start.mock.calls[0]![0].sessionName).toBe("Backend refactor");

    h.sessionManager.getSessionName.mockReturnValue(undefined);
    await h.run("web");
    expect(h.start).toHaveBeenCalledOnce();
    await h.run("tui");
    await h.run("web");
    expect(h.start.mock.calls[1]![0].sessionName).toBeUndefined();
    await h.controller.close();
  });

  it("remembers only explicit flags across takeback and restart, ahead of global defaults", async () => {
    const h = await setup();
    const file = path.join(h.root, "config.json");
    const key = realpathSync(h.root);
    const settings = { other: { enabled: true }, web: { future: true, host: "::1", port: 9123, url: "https://global.example/" } };
    await writeFile(file, JSON.stringify(settings));

    await h.run("web", "--port 8900 --url https://workspace.example");
    const { network, workspaceId } = h.start.mock.calls[0]![0];
    expect(network).toEqual({ host: "::1", port: 8900, url: "https://workspace.example" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...settings, web: { ...settings.web, workspaces: { [key]: { id: workspaceId, port: 8900, url: "https://workspace.example" } } },
    });

    await h.run("tui");
    await h.run("web", "--port 9000");
    const nextNetwork = { ...network, port: 9000 };
    expect(h.start.mock.calls[1]![0]).toMatchObject({ workspaceId, network: nextNetwork });
    await h.controller.close();

    const restarted = await setup(h.root);
    await restarted.run("web");
    expect(restarted.start.mock.calls[0]![0]).toMatchObject({ workspaceId, network: nextNetwork });
    await restarted.run("tui");

    const remembered = JSON.parse(await readFile(file, "utf8"));
    expect(remembered.web.workspaces[key]).toEqual({ id: workspaceId, port: 9000, url: "https://workspace.example" });
    remembered.web.workspaces[key] = { id: workspaceId };
    await writeFile(file, JSON.stringify(remembered));
    const globalNetwork = { host: "::1", port: 9123, url: "https://global.example" };
    await restarted.run("web");
    expect(restarted.start.mock.calls[1]![0]).toMatchObject({ workspaceId, network: globalNetwork });
    await restarted.run("tui");

    const other = path.join(h.root, "other");
    await mkdir(other);
    vi.mocked(restarted.runtime.getOptions).mockReturnValue({ ...restarted.options, cwd: other });
    await restarted.run("web");
    expect(restarted.start.mock.calls[2]![0].network).toEqual(globalNetwork);
    await restarted.controller.close();
  });

  it("rolls back a synchronous activation failure and keeps the TUI available", async () => {
    const h = await setup();
    h.service.activate = vi.fn(() => { throw new Error("transport initialization failed"); });
    await h.run("web");
    expect(h.service.close).toHaveBeenCalledOnce();
    expect(h.ui.notify).toHaveBeenLastCalledWith("transport initialization failed", "error");
    await h.run("web", "status");
    expect(h.ui.notify).toHaveBeenLastCalledWith("Web is stopped.", "info");
  });

  it("commits background admission only after rechecking TUI idleness and reports live component states", async () => {
    const h = await setup();
    h.service.activate = vi.fn();
    h.service.status = vi.fn(() => "Scheduler: running\nwechat: connecting");
    vi.mocked(h.runtime.assertIdle).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("TUI became busy"); });
    await h.run("web");
    expect(h.service.activate).not.toHaveBeenCalled(); expect(h.service.close).toHaveBeenCalledOnce();
    await h.run("web");
    expect(h.service.activate).toHaveBeenCalledOnce();
    await h.run("web", "status");
    expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("wechat: connecting"), "info");
    h.start.mock.calls.at(-1)![0].onNotice?.("wechat: paused (session expired)");
    expect(h.ui.notify).toHaveBeenLastCalledWith("wechat: paused (session expired)", "warning");
    await h.controller.close();
  });

  it("reuses the workspace ID across handoffs and TUI restarts while passing the current conversation", async () => {
    const first = await setup();
    await first.run("web");
    const id = first.start.mock.calls[0]![0].workspaceId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(getWebWorkspaceSettings(first.root).id).toBe(id);
    await first.run("tui");
    await first.run("web");
    expect(first.start.mock.calls[1]![0].workspaceId).toBe(id);
    await first.controller.close();

    const second = await setup(first.root);
    const position = { sessionId: "another-conversation", sessionFile: path.join(first.root, "another.jsonl"), leafId: "selected-leaf" };
    vi.mocked(second.runtime.getPosition).mockReturnValue(position);
    await second.run("web");
    expect(second.start.mock.calls[0]![0]).toMatchObject({ workspaceId: id, position });
    await second.controller.close();

    const otherWorkspace = path.join(first.root, "other");
    await mkdir(otherWorkspace);
    vi.mocked(second.runtime.getOptions).mockReturnValue({ ...second.options, cwd: otherWorkspace });
    await second.run("web");
    const otherId = second.start.mock.calls[1]![0].workspaceId;
    expect(otherId).not.toBe(id);
    expect(getWebWorkspaceSettings(first.root).id).toBe(id);
    expect(getWebWorkspaceSettings(otherWorkspace)).toMatchObject({ id: otherId, workspace: {} });
    await second.controller.close();
  });

  it("copies live parameters once, keeps the reminder across replacement, and keeps repeated /web read-only while busy", async () => {
    const h = await setup();
    await h.run("web");
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start.mock.calls[0]![0].runtimeOptions).toMatchObject({ effort: "high", activeTools: ["read"], noMcp: true });
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("dscode-web", [expect.stringContaining("Run /tui")]);
    h.controller.detach();
    h.controller.attach(h.runtime, h.ctx);
    vi.mocked(h.runtime.assertIdle).mockImplementation(() => { throw new Error("busy"); });
    await h.run("web");
    await h.run("web", "status");
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(h.service.url), "info");
    await h.run("web", "--port 9999");
    expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Run /tui"), "error");
    await h.run("tui");
    expect(h.service.close).not.toHaveBeenCalled();
    await h.controller.close();
    expect(h.service.close).toHaveBeenCalledOnce();
  });

  it("does not start or show a success reminder for busy or non-persistent sessions", async () => {
    const h = await setup();
    vi.mocked(h.runtime.assertIdle).mockImplementationOnce(() => { throw new Error("running /jobs"); });
    await h.run("web");
    vi.mocked(h.runtime.getPosition).mockImplementationOnce(() => { throw new Error("non-persistent"); });
    await h.run("web");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.ui.setWidget).toHaveBeenCalledExactlyOnceWith("dscode-web", undefined);
    expect(h.ui.notify).toHaveBeenLastCalledWith("non-persistent", "error");
  });

  it("leaves the TUI usable after startup failure and allows retry", async () => {
    const h = await setup();
    await h.run("web", "--port 8900");
    const { workspaceId } = h.start.mock.calls[0]![0];
    await h.run("tui");
    h.start.mockRejectedValueOnce(new Error("port is in use"));
    await h.run("web", "--port 9000");
    expect(h.ui.notify).toHaveBeenLastCalledWith("port is in use", "error");
    expect(getWebWorkspaceSettings(h.root)).toMatchObject({ id: workspaceId, workspace: { port: 8900 } });
    await h.run("web", "status");
    expect(h.ui.notify).toHaveBeenLastCalledWith("Web is stopped.", "info");
    await h.run("web");
    expect(h.start.mock.calls[2]![0].network.port).toBe(8900);
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("dscode-web", [expect.stringContaining("Run /tui")]);
    await h.controller.close();
  });

  it("keeps the service usable after a rejected takeback and restores the TUI's current settings on success", async () => {
    const h = await setup();
    await h.run("web");
    vi.mocked(h.service.prepareTakeback).mockImplementationOnce(() => { throw new Error("Web is busy"); });
    await h.run("tui");
    expect(h.service.close).not.toHaveBeenCalled();
    const current = { ...h.options, modelId: "deepseek-v4-pro", effort: "max" as const, permission: "ask" as const, activeTools: ["read", "apply_patch"] };
    vi.mocked(h.runtime.getOptions).mockReturnValue(current);
    await h.run("tui");
    expect(h.service.close).toHaveBeenCalledOnce();
    expect(h.runtime.restoreOptions).toHaveBeenCalledExactlyOnceWith(current);
    expect(h.options).toMatchObject(current);
    expect(h.ctx.newSession).toHaveBeenCalledOnce();
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("dscode-web", undefined);
  });

  it("keeps a successfully started service when saving workspace settings fails", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "config.json"), "{}");
    // Invalid JSON is introduced after preflight, so the save cannot overwrite it.
    h.start.mockImplementationOnce(async () => {
      await writeFile(path.join(h.root, "config.json"), "invalid JSON");
      return h.service;
    });
    await h.run("web");
    expect(h.service.close).not.toHaveBeenCalled();
    await h.run("web", "status");
    expect(h.ui.notify.mock.calls.some(([message, level]) => level === "warning" && String(message).includes("not saved"))).toBe(true);
    await h.controller.close();
  });

  it("clears the advisory reminder and points to /resume after unexpected shutdown", async () => {
    const h = await setup();
    await h.run("web");
    h.start.mock.calls[0]![0].onStopped(new Error("listener failed"));
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("dscode-web", undefined);
    expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Use /resume"), "error");
    await h.run("tui");
    expect(h.ui.notify).toHaveBeenLastCalledWith("Web is not running.", "info");
  });
});
