import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disableScheduleTask,
  loadScheduleConfig,
  parseScheduleSource,
  scheduleDefinitionHash,
} from "../src/schedule-config.js";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-08-24T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-schedules-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "schedules.yaml");
}

describe("schedule configuration", () => {
  it("accepts once tasks and Croner-native 5, 6, and 7 part patterns", () => {
    const source = `version: 1
tasks:
  - id: once-task
    enabled: true
    type: once
    at: "2027-01-01T09:00:00+08:00"
    delivery: session
    prompt: Run once
  - id: five-part
    enabled: true
    type: cron
    cron: "*/5 * * * *"
    delivery: source
    prompt: Every five minutes
  - id: six-part
    enabled: true
    type: cron
    cron: "0 0 9 * * MON-FRI"
    delivery: session
    prompt: Weekdays
  - id: finite-seven-part
    enabled: true
    type: cron
    cron: "0 0 9 1 JAN * 2027"
    delivery: session
    prompt: Finite
`;

    const result = parseScheduleSource(source, "Asia/Shanghai", NOW);

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("Expected valid schedules");
    expect(result.tasks.map((task) => task.id)).toEqual([
      "once-task",
      "five-part",
      "six-part",
      "finite-seven-part",
    ]);
    expect(result.tasks[3]).toMatchObject({
      type: "cron",
      nextRunAt: new Date("2027-01-01T01:00:00.000Z"),
    });
  });

  it("rejects frequent schedules, duplicate keys, aliases, and unknown fields", () => {
    const frequent = parseScheduleSource(
      `version: 1
tasks:
  - id: too-often
    enabled: true
    type: cron
    cron: "*/4 * * * *"
    delivery: session
    prompt: Too often
`,
      "UTC",
      NOW,
    );
    expect(frequent).toMatchObject({
      valid: false,
      errors: [
        {
          path: "tasks[0].cron",
          message: "Adjacent Cron occurrences must be at least 5 minutes apart",
        },
      ],
    });

    const duplicate = parseScheduleSource(
      "version: 1\nversion: 1\ntasks: []\n",
      "UTC",
      NOW,
    );
    expect(duplicate).toMatchObject({
      valid: false,
      errors: [{ path: "$", message: "Duplicate YAML key" }],
    });

    const alias = parseScheduleSource(
      `version: 1
tasks:
  - &task
    id: aliased-task
    enabled: true
    type: cron
    cron: "0 * * * *"
    delivery: session
    prompt: Original
  - *task
`,
      "UTC",
      NOW,
    );
    expect(alias).toMatchObject({
      valid: false,
      errors: [{ path: "$", message: "YAML aliases are not supported" }],
    });

    const legacyDelivery = parseScheduleSource(
      `version: 1
tasks:
  - id: legacy-delivery
    enabled: true
    type: once
    at: "2027-01-01T09:00:00+08:00"
    delivery: group
    prompt: Legacy values are not accepted
`,
      "Asia/Shanghai",
      NOW,
    );
    expect(legacyDelivery).toMatchObject({
      valid: false,
      errors: [
        {
          path: "tasks[0].delivery",
          message: "Expected session or source",
        },
      ],
    });
  });

  it("treats a missing file as an empty valid configuration", async () => {
    const filePath = await temporaryFile();

    await expect(loadScheduleConfig(filePath, "UTC", NOW)).resolves.toMatchObject({
      valid: true,
      raw: null,
      tasks: [],
    });
  });

  it("auto-disables the matching definition while preserving comments and other edits", async () => {
    const filePath = await temporaryFile();
    const source = `# managed schedules
version: 1
tasks:
  - id: one-time # keep this comment
    enabled: true
    type: once
    at: "2027-01-01T09:00:00+08:00"
    delivery: session
    prompt: Run once
  - id: another-task
    enabled: true
    type: cron
    cron: "0 * * * *"
    delivery: source
    prompt: Keep me
`;
    await writeFile(filePath, source);
    const loaded = await loadScheduleConfig(filePath, "Asia/Shanghai", NOW);
    if (!loaded.valid) throw new Error("Expected valid schedules");
    const task = loaded.tasks[0];
    if (!task) throw new Error("Missing task");

    const result = await disableScheduleTask(
      filePath,
      "Asia/Shanghai",
      task.id,
      scheduleDefinitionHash(task),
      NOW,
    );

    expect(result.status).toBe("disabled");
    const updated = await readFile(filePath, "utf8");
    expect(updated).toContain("# managed schedules");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain("enabled: false");
    expect(updated).toContain("id: another-task");
  });

  it("does not disable a task whose definition changed", async () => {
    const filePath = await temporaryFile();
    const original = `version: 1
tasks:
  - id: one-time
    enabled: true
    type: once
    at: "2027-01-01T09:00:00+08:00"
    delivery: session
    prompt: Original
`;
    await writeFile(filePath, original);
    const loaded = await loadScheduleConfig(filePath, "Asia/Shanghai", NOW);
    if (!loaded.valid) throw new Error("Expected valid schedules");
    const task = loaded.tasks[0];
    if (!task) throw new Error("Missing task");
    await writeFile(filePath, original.replace("Original", "Changed"));

    await expect(
      disableScheduleTask(
        filePath,
        "Asia/Shanghai",
        task.id,
        scheduleDefinitionHash(task),
        NOW,
      ),
    ).resolves.toEqual({ status: "changed" });
    await expect(readFile(filePath, "utf8")).resolves.toContain("enabled: true");
  });
});
