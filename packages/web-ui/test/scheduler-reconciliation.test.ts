import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTaskScheduler, type TaskScheduler } from "../src/task-scheduler.ts";

vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  // Simulate a host that starts a watcher successfully but drops notifications.
  watch: () => Object.assign(new EventEmitter(), { close() {} }),
}));

const roots: string[] = [];
const schedulers: TaskScheduler[] = [];
const now = new Date("2026-08-24T12:00:00.000Z");

afterEach(async () => {
  try {
    await Promise.all(schedulers.splice(0).map(scheduler => scheduler.dispose()));
  } finally {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  }
});

function onceTask(id: string, at: string): string {
  return `version: 1\ntasks:\n  - id: ${id}\n    enabled: true\n    type: once\n    at: "${at}"\n    delivery: session\n    prompt: ${id}-prompt\n`;
}

async function fixture({ watch = true, startPaused = false, source = "" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-schedule-reconcile-"));
  roots.push(root);
  const directory = path.join(root, ".dscode"); await mkdir(directory);
  const scheduleFilePath = path.join(directory, "schedules.yaml");
  if (source) await writeFile(scheduleFilePath, source);
  const submitTurn = vi.fn(async () => ({ status: "accepted" as const, turnId: "scheduled" }));
  const error = vi.fn();
  const onStatusChange = vi.fn();
  const scheduler = await createTaskScheduler({ workspaceId: "fixture", workspacePath: root, timezone: "UTC",
    watch, startPaused, configPollIntervalMs: 20, logger: { error }, onStatusChange,
    sessionPort: { activate: async () => ({ sessionId: "fixture" }), submitTurn, subscribe: () => () => {} },
  });
  schedulers.push(scheduler);
  const readStatus = async () => JSON.parse(await readFile(scheduler.statusFilePath, "utf8"));
  return { scheduler, scheduleFilePath, submitTurn, error, onStatusChange, readStatus };
}

it("discovers new and edited tasks through polling when directory notifications are lost", async () => {
  // Keep real timers and filesystem polling, but never race a task deadline.
  const h = await fixture({ startPaused: true });
  const at = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await writeFile(h.scheduleFilePath, onceTask("discovered", at));
  await vi.waitFor(async () => expect(await h.readStatus()).toMatchObject({
    valid: true, taskCount: 1,
    tasks: [{ id: "discovered", scheduleStatus: "active", nextRunAt: at }],
  }), { timeout: 5000 });

  const editedAt = new Date(Date.parse(at) + 60_000).toISOString();
  await writeFile(h.scheduleFilePath, onceTask("discovered", editedAt));
  await vi.waitFor(async () => expect(await h.readStatus()).toMatchObject({
    valid: true, taskCount: 1,
    tasks: [{ id: "discovered", scheduleStatus: "active", nextRunAt: editedAt }],
  }), { timeout: 5000 });
  expect(h.submitTurn).not.toHaveBeenCalled();
  expect(h.error).not.toHaveBeenCalled();
});

it("submits a one-time task exactly once at its controlled deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  // Configuration is loaded before advancing time; Croner and Scheduler share
  // the fake clock, with no watcher or filesystem poll timers involved.
  const h = await fixture({ watch: false, source: onceTask("scheduled", "2026-08-24T12:00:01.000Z") });
  await vi.advanceTimersByTimeAsync(999);
  expect(h.submitTurn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(h.submitTurn).toHaveBeenCalledExactlyOnceWith(
    "fixture", "[Scheduled task: scheduled]\n\nscheduled-prompt", undefined,
  ), { timeout: 5000 });

  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.submitTurn).toHaveBeenCalledOnce();
  expect(await h.readStatus()).toMatchObject({
    tasks: [{ id: "scheduled", scheduleStatus: "paused", nextRunAt: null }],
  });
  expect(h.error).not.toHaveBeenCalled();
});

it.each(["overwritten", "deleted"] as const)("rebuilds %s derived status through polling without directory notifications", async damage => {
  const at = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const h = await fixture({ startPaused: true, source: onceTask("retained", at) });
  // Let the initial configuration reconciliation finish first, so it cannot
  // mask a broken status-file recovery path by rewriting the status itself.
  await vi.waitFor(() => expect(h.onStatusChange.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
  const expected = await h.readStatus();
  expect(expected).toMatchObject({ version: 1, tasks: [{ id: "retained", nextRunAt: at }] });
  if (damage === "overwritten") await writeFile(h.scheduler.statusFilePath, "{}");
  else await rm(h.scheduler.statusFilePath);

  await vi.waitFor(async () => expect(await h.readStatus()).toEqual(expected), { timeout: 5000 });
  expect(h.submitTurn).not.toHaveBeenCalled();
  expect(h.error).not.toHaveBeenCalled();
});
