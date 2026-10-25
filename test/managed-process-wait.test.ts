import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

const options = {
  cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
  yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "low", stdinOpen: true,
} as const;

describe("managed process wait windows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    spawn.mockReset();
    spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      killed: false, kill: vi.fn(() => true),
    }));
  });

  afterEach(() => {
    for (const child of spawn.mock.results) child.value.emit("close", 0);
    vi.useRealTimers();
  });

  async function start(timeoutMs = 0) {
    const registry = new ManagedProcessRegistry();
    const pending = registry.start("echo job", { ...options, timeoutMs });
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    const child = spawn.mock.results.at(-1)!.value as ChildProcessWithoutNullStreams;
    return { registry, result, child };
  }

  it.each([
    { action: {}, requested: 60_000, wait: 60_000 },
    { action: {}, requested: 300_000, wait: 120_000 },
    { action: { chars: "input" }, requested: 60_000, wait: 30_000 },
    { action: { eof: true }, requested: 60_000, wait: 30_000 },
    { action: { terminate: true }, requested: 60_000, wait: 30_000 },
  ])("waits $wait ms for $action (requested $requested ms)", async ({ action, requested, wait }) => {
    const { registry, result } = await start();
    let settled = false;
    const pending = registry.interact(result.processId, { ...action, yieldTimeMs: requested })
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ running: true });
  });

  it("retains the 30-second startup wait cap", async () => {
    const registry = new ManagedProcessRegistry();
    let settled = false;
    const pending = registry.start("echo job", { ...options, yieldTimeMs: 120_000 })
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ running: true });
  });

  it("returns completion before a long poll window ends", async () => {
    const { registry, result, child } = await start();
    const pending = registry.interact(result.processId, { yieldTimeMs: 120_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    child.stdout.emit("data", "done");
    child.emit("close", 0);
    expect(await pending).toMatchObject({ running: false, exitCode: 0, output: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a long poll immediately without stopping the process", async () => {
    const { registry, result, child } = await start();
    const controller = new AbortController();
    const pending = registry.interact(result.processId, { yieldTimeMs: 120_000, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.list()).toContainEqual({ processId: result.processId, running: true, sandbox: result.sandbox });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the process deadline independent of the poll window", async () => {
    const { registry, result, child } = await start(10_000);
    const pending = registry.interact(result.processId, { yieldTimeMs: 120_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalled();
    child.emit("close", null);
    expect(await pending).toMatchObject({ running: false, timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
