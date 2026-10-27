import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import type { DSCodeSessionRuntime } from "../packages/core/src/session-handoff.ts";
import { getStoredWebPreferences, getStoredWebWorkspaceId, saveWebPreferences } from "../packages/core/src/settings.ts";
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
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const pi = { registerCommand: (name: string, command: typeof commands extends Map<string, infer T> ? T : never) => commands.set(name, command) } as unknown as ExtensionAPI;
  const ui = { notify: vi.fn(), setWidget: vi.fn() };
  const ctx = { mode: "tui", ui, newSession: vi.fn(async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
    controller.attach(runtime, ctx);
    await options?.withSession?.({ ...ctx, sendMessage: vi.fn(), sendUserMessage: vi.fn() });
    return { cancelled: false };
  }) } as unknown as ExtensionCommandContext;
  controller.register(pi, options);
  controller.attach(runtime, ctx);
  const run = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
  return { root, options, runtime, service, start, controller, ctx, ui, run };
}

describe("Web network preferences", () => {
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

  it("saves only network preferences while preserving unrelated user configuration", async () => {
    const { root } = await setup();
    const file = path.join(root, "config.json");
    await writeFile(file, JSON.stringify({ other: { enabled: true }, web: { future: true } }));
    await saveWebPreferences({ host: "127.0.0.1", port: 9123 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      other: { enabled: true }, web: { future: true, host: "127.0.0.1", port: 9123 },
    });
    expect(getStoredWebPreferences()).toEqual({ host: "127.0.0.1", port: 9123 });
  });

  it("resolves workspace aliases to the same stored ID and rejects invalid stored IDs", async () => {
    const { root } = await setup();
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const id = "a".repeat(32);
    await saveWebPreferences({ host: "127.0.0.1", port: 9123 }, { cwd: alias, id });
    expect(getStoredWebWorkspaceId(workspace)).toBe(id);
    expect(getStoredWebWorkspaceId(alias)).toBe(id);
    expect(getStoredWebWorkspaceId(root)).toBeUndefined();
    if (process.platform !== "win32") expect((await stat(path.join(root, "config.json"))).mode & 0o777).toBe(0o600);
    for (const workspaceIds of [[], "invalid", { [realpathSync(workspace)]: "invalid" }]) {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ web: { workspaceIds } }));
      expect(() => getStoredWebWorkspaceId(workspace)).toThrow();
    }
  });
});

describe("TUI Web ownership", () => {
  it("reuses the workspace ID across handoffs and TUI restarts while passing the current conversation", async () => {
    const first = await setup();
    await first.run("web");
    const id = first.start.mock.calls[0]![0].workspaceId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(getStoredWebWorkspaceId(first.root)).toBe(id);
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
    expect(getStoredWebWorkspaceId(first.root)).toBe(id);
    expect(getStoredWebWorkspaceId(otherWorkspace)).toBe(otherId);
    expect(getStoredWebPreferences()).toEqual({ host: "127.0.0.1", port: 8899 });
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
    h.start.mockRejectedValueOnce(new Error("port is in use"));
    await h.run("web");
    expect(h.ui.notify).toHaveBeenLastCalledWith("port is in use", "error");
    expect(getStoredWebWorkspaceId(h.root)).toBeUndefined();
    await h.run("web", "status");
    expect(h.ui.notify).toHaveBeenLastCalledWith("Web is stopped.", "info");
    await h.run("web");
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

  it("keeps a successfully started service when saving preferences fails", async () => {
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
