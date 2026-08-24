import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProactiveDeliveryListener } from "@thinkany/dscode-chat-client";
import type {
  SessionPort,
  SessionPortActivation,
  SessionPortTurnEvent,
  SessionPortTurnListener,
  SessionPortTurnSubmission,
} from "@thinkany/dscode-http-adapter/session-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertValidScheduleTimezone,
  createTaskScheduler,
  type ScheduledGroupDeliveryPort,
  type TaskScheduler,
} from "../src/task-scheduler.js";

class FakeSessionPort implements SessionPort {
  readonly submissions: Array<{ workspaceId: string; message: string }> = [];
  readonly results: SessionPortTurnSubmission[] = [];
  private readonly listeners = new Set<SessionPortTurnListener>();
  private turnNumber = 1;

  async activate(_workspaceId: string): Promise<SessionPortActivation> {
    return { sessionId: "session-1" };
  }

  async submitTurn(
    workspaceId: string,
    message: string,
  ): Promise<SessionPortTurnSubmission> {
    this.submissions.push({ workspaceId, message });
    return (
      this.results.shift() ?? {
        status: "accepted",
        turnId: `turn-${this.turnNumber++}`,
      }
    );
  }

  subscribe(listener: SessionPortTurnListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: SessionPortTurnEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

class FakeGroupDelivery implements ScheduledGroupDeliveryPort {
  readonly listeners = new Map<string, ProactiveDeliveryListener | undefined>();

  registerTurnForGroupDelivery(
    turnId: string,
    listener?: ProactiveDeliveryListener,
  ): boolean {
    if (this.listeners.has(turnId)) return false;
    this.listeners.set(turnId, listener);
    return true;
  }

  async emit(
    turnId: string,
    status: "delivered" | "failed" | "abandoned",
  ): Promise<void> {
    await this.listeners.get(turnId)?.({ turnId, status });
  }
}

const temporaryDirectories: string[] = [];
const schedulers: TaskScheduler[] = [];

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.dispose()));
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-scheduler-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, ".keep"), "");
  return directory;
}

async function writeSchedules(workspacePath: string, source: string): Promise<void> {
  const directory = path.join(workspacePath, ".dscode");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "schedules.yaml"), source);
}

async function readStatus(workspacePath: string): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(path.join(workspacePath, ".dscode", "schedules.status.json"), "utf8"),
  ) as Record<string, any>;
}

async function waitForSubmission(port: FakeSessionPort, count: number): Promise<void> {
  await vi.waitFor(() => expect(port.submissions).toHaveLength(count));
}

function logger() {
  return { error: vi.fn(), info: vi.fn() };
}

describe("task scheduler", () => {
  it("requires an explicit IANA timezone and writes an empty healthy status", async () => {
    expect(() => assertValidScheduleTimezone("")).toThrow("TZ is required");
    expect(() => assertValidScheduleTimezone("Not/AZone")).toThrow(
      "valid IANA timezone",
    );
    const workspacePath = await workspace();
    const port = new FakeSessionPort();

    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      watch: false,
    });
    schedulers.push(scheduler);

    await expect(readStatus(workspacePath)).resolves.toMatchObject({
      version: 1,
      timezone: "UTC",
      valid: true,
      taskCount: 0,
      activeTaskCount: 0,
      groupDeliveryAvailable: false,
      operational: true,
      tasks: [],
    });
    expect(port.submissions).toEqual([]);
  });

  it("consumes a one-time private task before submitting and records completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: private-reminder
    enabled: true
    type: once
    at: "2026-08-24T12:00:01Z"
    delivery: session
    prompt: Check the contract
`,
    );
    const port = new FakeSessionPort();
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      watch: false,
    });
    schedulers.push(scheduler);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 1);
    expect(port.submissions).toEqual([
      {
        workspaceId: "main",
        message: "[Scheduled task: private-reminder]\n\nCheck the contract",
      },
    ]);
    await expect(
      readFile(path.join(workspacePath, ".dscode", "schedules.yaml"), "utf8"),
    ).resolves.toContain("enabled: false");

    await port.emit({ status: "completed", turnId: "turn-1", output: "Done" });
    const status = await readStatus(workspacePath);
    expect(status.tasks[0]).toMatchObject({
      id: "private-reminder",
      scheduleStatus: "paused",
      nextRunAt: null,
      lastRun: {
        status: "completed",
        deliveryStatus: "not_applicable",
        turnId: "turn-1",
      },
    });
    expect(status.tasks[0].currentRun).toBeUndefined();
  });

  it("retries a busy cron occurrence and tracks group delivery independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:04:59.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: group-report
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: group
    prompt: Write the report
`,
    );
    const port = new FakeSessionPort();
    port.results.push({ status: "busy" }, { status: "accepted", turnId: "scheduled-1" });
    const groupDelivery = new FakeGroupDelivery();
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      groupDelivery,
      logger: logger(),
      retryDelaysMs: [100],
      random: () => 0.5,
      watch: false,
    });
    schedulers.push(scheduler);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 1);
    await vi.advanceTimersByTimeAsync(100);
    await waitForSubmission(port, 2);
    expect(groupDelivery.listeners.has("scheduled-1")).toBe(true);

    await port.emit({
      status: "completed",
      turnId: "scheduled-1",
      output: "Report",
    });
    let status = await readStatus(workspacePath);
    expect(status.tasks[0].lastRun).toMatchObject({
      status: "completed",
      attempt: 2,
      deliveryStatus: "pending",
    });

    await groupDelivery.emit("scheduled-1", "delivered");
    status = await readStatus(workspacePath);
    expect(status.tasks[0].lastRun.deliveryStatus).toBe("delivered");
  });

  it("makes simultaneous initial submissions in YAML order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:04:59.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: first-once
    enabled: true
    type: once
    at: "2026-08-24T12:05:00Z"
    delivery: session
    prompt: First
  - id: second-cron
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: session
    prompt: Second
`,
    );
    const port = new FakeSessionPort();
    port.results.push(
      { status: "accepted", turnId: "first-turn" },
      { status: "busy" },
    );
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      retryDelaysMs: [],
      watch: false,
    });
    schedulers.push(scheduler);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 2);
    expect(port.submissions.map((submission) => submission.message)).toEqual([
      "[Scheduled task: first-once]\n\nFirst",
      "[Scheduled task: second-cron]\n\nSecond",
    ]);
  });

  it("skips a callback delayed by more than 60 seconds without submitting", async () => {
    vi.useFakeTimers();
    const systemStart = new Date("2026-08-24T12:00:00.000Z");
    vi.setSystemTime(systemStart);
    let logicalNow = systemStart;
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: late-task
    enabled: true
    type: once
    at: "2026-08-24T12:00:01Z"
    delivery: session
    prompt: Do not catch up
`,
    );
    const port = new FakeSessionPort();
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      now: () => logicalNow,
      watch: false,
    });
    schedulers.push(scheduler);
    logicalNow = new Date("2026-08-24T12:02:00.000Z");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => {
      const status = await readStatus(workspacePath);
      expect(status.tasks[0].lastSkip?.reason).toBe("late");
    });
    expect(port.submissions).toEqual([]);
    await expect(
      readFile(path.join(workspacePath, ".dscode", "schedules.yaml"), "utf8"),
    ).resolves.toContain("enabled: false");
  });

  it("keeps the last valid schedule active when a runtime edit is invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:04:59.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: retained-task
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: session
    prompt: Keep running
`,
    );
    const port = new FakeSessionPort();
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      watch: false,
    });
    schedulers.push(scheduler);
    await writeSchedules(workspacePath, "version: 1\ntasks: [\n");

    await scheduler.reload();
    expect(await readStatus(workspacePath)).toMatchObject({
      valid: false,
      activeTaskCount: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 1);
    expect(port.submissions[0]?.message).toContain("[Scheduled task: retained-task]");
  });

  it("cancels an unaccepted busy retry when the task is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:04:59.000Z"));
    const workspacePath = await workspace();
    const enabledSource = `version: 1
tasks:
  - id: pausable-task
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: session
    prompt: Retry while enabled
`;
    await writeSchedules(workspacePath, enabledSource);
    const port = new FakeSessionPort();
    port.results.push({ status: "busy" }, { status: "accepted", turnId: "too-late" });
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      retryDelaysMs: [10_000],
      random: () => 0.5,
      watch: false,
    });
    schedulers.push(scheduler);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 1);
    await writeSchedules(
      workspacePath,
      enabledSource.replace("enabled: true", "enabled: false"),
    );
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(port.submissions).toHaveLength(1);
    expect(await readStatus(workspacePath)).toMatchObject({
      tasks: [
        {
          id: "pausable-task",
          scheduleStatus: "paused",
          lastSkip: { reason: "configuration_changed" },
        },
      ],
    });
  });

  it("skips an overlapping cron occurrence while the previous Turn is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:04:59.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: overlap-task
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: session
    prompt: Long running work
`,
    );
    const port = new FakeSessionPort();
    const scheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: port,
      logger: logger(),
      watch: false,
    });
    schedulers.push(scheduler);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(port, 1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(async () => {
      const status = await readStatus(workspacePath);
      expect(status.tasks[0].lastSkip?.reason).toBe("overlap");
    });
    expect(port.submissions).toHaveLength(1);
    expect((await readStatus(workspacePath)).tasks[0].currentRun.status).toBe("running");
  });

  it("persists an interrupted run across restart without resubmitting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const workspacePath = await workspace();
    await writeSchedules(
      workspacePath,
      `version: 1
tasks:
  - id: interrupted-once
    enabled: true
    type: once
    at: "2026-08-24T12:00:01Z"
    delivery: group
    prompt: Run at most once
`,
    );
    const firstPort = new FakeSessionPort();
    const firstGroupDelivery = new FakeGroupDelivery();
    const firstScheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: firstPort,
      groupDelivery: firstGroupDelivery,
      logger: logger(),
      watch: false,
    });
    schedulers.push(firstScheduler);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSubmission(firstPort, 1);
    await firstScheduler.dispose();

    const secondPort = new FakeSessionPort();
    const secondScheduler = await createTaskScheduler({
      workspaceId: "main",
      workspacePath,
      timezone: "UTC",
      sessionPort: secondPort,
      logger: logger(),
      watch: false,
    });
    schedulers.push(secondScheduler);

    expect(secondPort.submissions).toEqual([]);
    expect(await readStatus(workspacePath)).toMatchObject({
      tasks: [
        {
          id: "interrupted-once",
          lastRun: {
            status: "interrupted",
            deliveryStatus: "abandoned",
          },
        },
      ],
    });
  });
});
