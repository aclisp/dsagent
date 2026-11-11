import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatProvider, ChatProviderListener, InboundChatMessage } from "@aclisp/dsagent-chat-client";
import type { SessionPort } from "@aclisp/dsagent-http-adapter";
import { afterEach, expect, it, vi } from "vitest";
import { acquireBackgroundResources } from "../src/background-resources.ts";
import { prepareBackgroundServices } from "../src/background-services.ts";

const roots: string[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-background-")); roots.push(root);
  const workspacePath = path.join(root, "workspace"); await mkdir(workspacePath);
  const coordinationDirectory = path.join(root, "locks");
  const sessionPort: SessionPort = {
    activate: vi.fn(async () => ({ sessionId: "current" })),
    submitTurn: vi.fn(async () => ({ status: "accepted" as const, turnId: "turn" })),
    subscribe: () => () => {}, subscribeTurnStarted: () => () => {},
  };
  const options = { workspaceId: "secret", workspacePath, coordinationDirectory, sessionPort,
    providers: [] as ChatProvider[], timezone: "UTC", strict: true,
    logger: { error: vi.fn() }, onOwnershipLost: vi.fn(),
  };
  const prepare = async (providers: ChatProvider[] = []) => {
    const services = await prepareBackgroundServices({ ...options, providers });
    cleanup.push(() => services.close()); return services;
  };
  return { root, workspacePath, coordinationDirectory, sessionPort, options, prepare };
}

class Provider implements ChatProvider {
  readonly providerId = "fixture";
  readonly resourceKey = "fixture:one-account";
  listener: ChatProviderListener | undefined;
  pending?: Promise<unknown>;
  disposed = false;
  private status = "connecting";
  private observer: ((status: string) => void) | undefined;
  constructor(privateInit: { fail?: boolean; emit?: boolean } = {}) { this.init = privateInit; }
  private readonly init: { fail?: boolean; emit?: boolean };
  readonly message: InboundChatMessage = {
    dedupeKey: "fixture-1", messageId: "one", text: "IM during initialization",
    conversation: { providerId: "fixture", type: "direct", address: "owner" },
    sender: { providerId: "fixture", address: "owner" },
  };
  subscribe(listener: ChatProviderListener) { this.listener = listener; return () => { this.listener = undefined; }; }
  subscribeStatus(listener: (status: string) => void) { this.observer = listener; return () => { this.observer = undefined; }; }
  getStatus() { return this.status; }
  setStatus(status: string) { this.status = status; this.observer?.(status); }
  start() {
    if (this.init.emit) this.pending = this.listener!(this.message).catch(() => undefined);
    if (this.init.fail) throw new Error("local failure");
  }
  dispose() { this.disposed = true; }
  async reply() { return { status: "delivered" as const }; }
  async send() { return { status: "delivered" as const }; }
}

it("holds startup input until commit without waiting for authentication", async () => {
  const h = await fixture(); const provider = new Provider({ emit: true });
  const service = await h.prepare([provider]);
  expect(h.sessionPort.submitTurn).not.toHaveBeenCalled();
  expect(service.status()).toContain("connecting");
  service.start(); await provider.pending;
  expect(h.sessionPort.submitTurn).toHaveBeenCalledExactlyOnceWith("secret", expect.stringContaining("IM during initialization"), expect.anything());
  await service.close(); expect(provider.disposed).toBe(true);
  expect(JSON.parse(await readFile(path.join(h.workspacePath, ".dscode/schedules.status.json"), "utf8")).operational).toBe(false);
});

it("rolls back every initialized provider and releases ownership when a later provider fails", async () => {
  const h = await fixture(); const first = new Provider({ emit: true }); const failing = new Provider({ fail: true });
  await expect(h.prepare([first, failing])).rejects.toThrow("Could not initialize fixture");
  await first.pending;
  expect(h.sessionPort.submitTurn).not.toHaveBeenCalled();
  expect(first.disposed && failing.disposed).toBe(true);
  const retry = await h.prepare([new Provider()]); retry.start();
});

it("rolls back invalid schedule configuration, then permits a corrected retry", async () => {
  const h = await fixture(); const directory = path.join(h.workspacePath, ".dscode"); await mkdir(directory);
  await writeFile(path.join(directory, "schedules.yaml"), "tasks: [broken");
  const provider = new Provider({ emit: true });
  await expect(h.prepare([provider])).rejects.toThrow("Invalid scheduled task configuration");
  await provider.pending;
  expect(provider.disposed).toBe(true); expect(h.sessionPort.submitTurn).not.toHaveBeenCalled();
  await writeFile(path.join(directory, "schedules.yaml"), "version: 1\ntasks: []\n");
  await h.prepare([new Provider()]);
});

it("keeps the service alive and reports a runtime channel failure only once per state", async () => {
  const h = await fixture(); const provider = new Provider(); const notices = vi.fn();
  const service = await prepareBackgroundServices({ ...h.options, providers: [provider], onNotice: notices });
  cleanup.push(() => service.close()); service.start();
  provider.setStatus("failed (authentication)"); provider.setStatus("failed (authentication)");
  expect(notices).toHaveBeenCalledOnce(); expect(service.status()).toContain("failed (authentication)");
  expect(service.status()).toContain("Scheduler: running"); expect(provider.disposed).toBe(false);
});

it("does not execute a prepared scheduler until commit", async () => {
  const h = await fixture(); const directory = path.join(h.workspacePath, ".dscode"); await mkdir(directory);
  await writeFile(path.join(directory, "schedules.yaml"), `version: 1\ntasks:\n  - id: scheduled\n    enabled: true\n    type: once\n    at: "${new Date(Date.now() + 1400).toISOString()}"\n    delivery: session\n    prompt: scheduled-work\n`);
  const service = await h.prepare();
  expect(service.status()).toContain("prepared"); expect(h.sessionPort.submitTurn).not.toHaveBeenCalled();
  service.start();
  await vi.waitFor(() => expect(h.sessionPort.submitTurn).toHaveBeenCalledWith("secret", expect.stringContaining("scheduled-work"), undefined), { timeout: 3000 });
});

it("skips a one-time deadline crossed while the service was still prepared", async () => {
  const h = await fixture(); const directory = path.join(h.workspacePath, ".dscode"); await mkdir(directory);
  await writeFile(path.join(directory, "schedules.yaml"), `version: 1\ntasks:\n  - id: missed\n    enabled: true\n    type: once\n    at: "${new Date(Date.now() + 200).toISOString()}"\n    delivery: session\n    prompt: must-not-catch-up\n`);
  const service = await h.prepare();
  await new Promise(resolve => setTimeout(resolve, 250)); service.start();
  await vi.waitFor(async () => {
    const status = JSON.parse(await readFile(path.join(directory, "schedules.status.json"), "utf8"));
    expect(status.tasks[0].lastSkip.reason).toBe("late");
  });
  expect(h.sessionPort.submitTurn).not.toHaveBeenCalled();
});

it("coordinates workspace aliases and rolls back partially acquired account locks", async () => {
  const h = await fixture();
  const acquire = (workspace: string, account = "first") => acquireBackgroundResources({ workspace,
    directory: h.coordinationDirectory, accounts: [{ key: account, label: "test account" }], onCompromised: vi.fn() });
  const release = await acquire(h.workspacePath); cleanup.push(release);
  const alias = path.join(h.root, "alias"); await symlink(h.workspacePath, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(acquire(alias, "second")).rejects.toThrow("already in use");
  const other = path.join(h.root, "other"); await mkdir(other);
  const releaseOther = await acquire(other, "second"); cleanup.push(releaseOther);
  await expect(acquire(other, "first")).rejects.toThrow("already in use");
});

it("excludes another process and recovers a crashed owner's stale locks", async () => {
  const h = await fixture();
  const source = new URL("../src/background-resources.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireBackgroundResources } from ${JSON.stringify(source)};
    await acquireBackgroundResources({ workspace: ${JSON.stringify(h.workspacePath)}, directory: ${JSON.stringify(h.coordinationDirectory)}, accounts: [{ key: "cross-process", label: "test bot" }], onCompromised: () => {} });
    process.stdin.resume(); console.log("LOCKED");
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  await vi.waitFor(() => expect(output).toContain("LOCKED"));
  const other = path.join(h.root, "other"); await mkdir(other);
  const acquire = () => acquireBackgroundResources({ workspace: other, directory: h.coordinationDirectory,
    accounts: [{ key: "cross-process", label: "test bot" }], onCompromised: vi.fn() });
  await expect(acquire()).rejects.toThrow("test bot");
  child.kill("SIGKILL"); await exited;
  // Advance abandoned lock timestamps instead of making acceptance sleep 30s.
  for (const name of await readdir(h.coordinationDirectory)) {
    await utimes(path.join(h.coordinationDirectory, name), new Date(0), new Date(0));
  }
  const release = await acquire(); cleanup.push(release);
}, 10_000);
