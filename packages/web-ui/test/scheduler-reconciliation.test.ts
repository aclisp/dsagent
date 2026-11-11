import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTaskScheduler } from "../src/task-scheduler.ts";

vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  // Simulate a host that starts a watcher successfully but drops notifications.
  watch: () => Object.assign(new EventEmitter(), { close() {} }),
}));

it("reconciles task edits and derived status when directory notifications are lost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-schedule-reconcile-"));
  const directory = path.join(root, ".dscode"); await mkdir(directory);
  const submitTurn = vi.fn(async () => ({ status: "accepted" as const, turnId: "scheduled" }));
  const scheduler = await createTaskScheduler({ workspaceId: "fixture", workspacePath: root, timezone: "UTC",
    configPollIntervalMs: 20, logger: { error: vi.fn() },
    sessionPort: { activate: async () => ({ sessionId: "fixture" }), submitTurn, subscribe: () => () => {} },
  });
  try {
    await writeFile(path.join(directory, "schedules.yaml"), `version: 1\ntasks:\n  - id: recovered\n    enabled: true\n    type: once\n    at: "${new Date(Date.now() + 1200).toISOString()}"\n    delivery: session\n    prompt: recovered-from-missed-notification\n`);
    await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledOnce(), { timeout: 2500 });
    await writeFile(scheduler.statusFilePath, "{}");
    await vi.waitFor(async () => expect(JSON.parse(await readFile(scheduler.statusFilePath, "utf8")).version).toBe(1));
  } finally { await scheduler.dispose(); await rm(root, { recursive: true, force: true }); }
});
