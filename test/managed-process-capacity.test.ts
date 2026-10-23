import { EventEmitter } from "node:events";
import os from "node:os";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

// Exercise the real registry without starting 64 operating-system processes in each test.
function createChild(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

const options = {
  cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
  yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "low",
} as const;

async function fill(registry: ManagedProcessRegistry) {
  return Promise.all(Array.from({ length: 64 }, () => registry.start("echo job", options)));
}

describe("managed process capacity", () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(createChild);
  });

  it("admits 64 parallel launches and rejects the next before spawning without evicting jobs", async () => {
    const registry = new ManagedProcessRegistry();
    const otherSession = new ManagedProcessRegistry();
    try {
      const started = await fill(registry);
      const jobs = registry.list();
      expect(started.every((result) => result.running)).toBe(true);
      expect(jobs).toHaveLength(64);
      await expect(registry.start("echo rejected", options)).rejects.toThrow(
        "Cannot start command: this session already has 64 running jobs.\nUse /jobs to inspect them, then wait for a job to finish or stop one with write_stdin using terminate: true.",
      );
      expect(spawn).toHaveBeenCalledTimes(64);
      expect(registry.list()).toEqual(jobs);
      for (const result of spawn.mock.results) {
        expect(result.value.kill).not.toHaveBeenCalled();
      }
      // The limit belongs to each registry rather than all sessions in this Node process.
      await expect(otherSession.start("echo separate session", options)).resolves.toMatchObject({ running: true });
      expect(spawn).toHaveBeenCalledTimes(65);
    } finally {
      await registry.dispose();
      await otherSession.dispose();
    }
  });

  it.each(["exit", "terminate", "spawn failure"])("admits a replacement after %s without reading other completed results", async (finish) => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await fill(registry);
      const child = spawn.mock.results[0]!.value as ChildProcessWithoutNullStreams;
      if (finish === "terminate") {
        await expect(registry.interact(started[0]!.processId, { terminate: true, yieldTimeMs: 100 }))
          .resolves.toMatchObject({ running: false });
      } else {
        if (finish === "spawn failure") child.emit("error", new Error("spawn EACCES"));
        child.emit("close", finish === "exit" ? 0 : null);
        expect(registry.list()).toContainEqual({ processId: started[0]!.processId, running: false, sandbox: "host" });
      }
      const replacement = await registry.start("echo replacement", options);
      expect(replacement).toMatchObject({ processId: "65", running: true });
      expect(registry.list().filter((job) => job.running)).toHaveLength(64);
      expect(spawn).toHaveBeenCalledTimes(65);
      await expect(registry.start("echo still full", options)).rejects.toThrow("64 running jobs");
      expect(spawn).toHaveBeenCalledTimes(65);
    } finally { await registry.dispose(); }
  });

  it("keeps 100 unread completed records separately from the 64 running slots", async () => {
    const registry = new ManagedProcessRegistry();
    const completed: string[] = [];
    try {
      for (let index = 0; index < 101; index++) {
        const job = await registry.start("echo completed", options);
        completed.push(job.processId);
        const child = spawn.mock.results.at(-1)!.value as ChildProcessWithoutNullStreams;
        child.stdout.emit("data", Buffer.from("done"));
        child.emit("close", 0);
      }
      expect(registry.list()).toHaveLength(100);
      expect(registry.list().some((job) => job.processId === completed[0])).toBe(false);
      await fill(registry);
      expect(registry.list()).toHaveLength(164);
      await expect(registry.start("echo full", options)).rejects.toThrow("64 running jobs");
      // Reading a completed result does not free a running slot.
      await expect(registry.interact(completed[1]!, { yieldTimeMs: 0 }))
        .resolves.toMatchObject({ running: false, exitCode: 0, output: "done" });
      await expect(registry.start("echo still full", options)).rejects.toThrow("64 running jobs");
      expect(registry.list().filter((job) => job.running)).toHaveLength(64);
    } finally { await registry.dispose(); }
  });

  it("retains the actual process error separately from its exit code and output", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start("echo job", options);
      const child = spawn.mock.results.at(-1)!.value as ChildProcessWithoutNullStreams;
      child.emit("error", new Error("spawn EACCES"));
      child.emit("close", -13);
      await expect(registry.interact(started.processId, { yieldTimeMs: 0 })).resolves.toMatchObject({
        running: false, exitCode: -13, processError: "spawn EACCES", output: "[error] spawn EACCES",
      });
    } finally { await registry.dispose(); }
  });
});
