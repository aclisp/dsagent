import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { parseDocument } from "yaml";

const MAX_SCHEDULE_FILE_BYTES = 1024 * 1024;
const MAX_TASKS = 100;
const MAX_PROMPT_BYTES = 32 * 1024;
const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC3339_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type ScheduleDelivery = "session" | "source";

interface ScheduleTaskBase {
  id: string;
  enabled: boolean;
  delivery: ScheduleDelivery;
  prompt: string;
}

export interface OnceScheduleTask extends ScheduleTaskBase {
  type: "once";
  at: string;
  atDate: Date;
}

export interface CronScheduleTask extends ScheduleTaskBase {
  type: "cron";
  cron: string;
  nextRunAt: Date | null;
}

export type ScheduleTask = OnceScheduleTask | CronScheduleTask;

export interface ScheduleValidationError {
  path: string;
  message: string;
}

export interface ValidScheduleConfig {
  valid: true;
  contentHash: string;
  raw: string | null;
  tasks: ScheduleTask[];
}

export interface InvalidScheduleConfig {
  valid: false;
  contentHash: string;
  raw: string;
  errors: ScheduleValidationError[];
}

export type ScheduleConfig = ValidScheduleConfig | InvalidScheduleConfig;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function definitionValue(task: ScheduleTask): Record<string, unknown> {
  return task.type === "once"
    ? {
        id: task.id,
        type: task.type,
        at: task.at,
        delivery: task.delivery,
        prompt: task.prompt,
      }
    : {
        id: task.id,
        type: task.type,
        cron: task.cron,
        delivery: task.delivery,
        prompt: task.prompt,
      };
}

export function scheduleDefinitionHash(task: ScheduleTask): string {
  return hashContent(JSON.stringify(definitionValue(task)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  basePath: string,
  errors: ScheduleValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${basePath}.${key}`, message: "Unknown field" });
    }
  }
}

function validRfc3339WithOffset(value: string): Date | undefined {
  const match = RFC3339_WITH_OFFSET.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fraction] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const milliseconds = Number(`0.${fraction ?? "0"}`) * 1000;
  const wallClock = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, milliseconds),
  );
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function cronSchedule(
  pattern: string,
  timezone: string,
  now: Date,
): { nextRunAt: Date | null } | { error: string } {
  let cron: Cron;
  try {
    cron = new Cron(pattern, { paused: true, timezone });
  } catch {
    return { error: "Invalid Croner pattern" };
  }
  try {
    const upcoming = cron.nextRuns(512, now);
    for (let index = 1; index < upcoming.length; index += 1) {
      const previous = upcoming[index - 1];
      const current = upcoming[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.getTime() - previous.getTime() < MIN_CRON_INTERVAL_MS
      ) {
        return { error: "Adjacent Cron occurrences must be at least 5 minutes apart" };
      }
    }
    return { nextRunAt: upcoming[0] ?? null };
  } catch {
    return { error: "Croner could not evaluate this pattern" };
  } finally {
    cron.stop();
  }
}

function parseTask(
  value: unknown,
  index: number,
  timezone: string,
  now: Date,
  errors: ScheduleValidationError[],
): ScheduleTask | undefined {
  const basePath = `tasks[${index}]`;
  if (!isRecord(value)) {
    errors.push({ path: basePath, message: "Task must be an object" });
    return undefined;
  }

  const type = value.type;
  const allowed =
    type === "once"
      ? new Set(["id", "enabled", "type", "at", "delivery", "prompt"])
      : new Set(["id", "enabled", "type", "cron", "delivery", "prompt"]);
  validateKnownKeys(value, allowed, basePath, errors);

  const id = value.id;
  if (typeof id !== "string" || id.length > 64 || !TASK_ID_PATTERN.test(id)) {
    errors.push({
      path: `${basePath}.id`,
      message: "ID must be 1-64 lowercase letters, digits, or hyphen-separated words",
    });
  }
  if (typeof value.enabled !== "boolean") {
    errors.push({ path: `${basePath}.enabled`, message: "Expected a boolean" });
  }
  if (value.delivery !== "session" && value.delivery !== "source") {
    errors.push({
      path: `${basePath}.delivery`,
      message: "Expected session or source",
    });
  }
  if (
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0 ||
    Buffer.byteLength(value.prompt, "utf8") > MAX_PROMPT_BYTES
  ) {
    errors.push({
      path: `${basePath}.prompt`,
      message: "Prompt must be non-blank and at most 32 KiB",
    });
  }
  if (type !== "once" && type !== "cron") {
    errors.push({ path: `${basePath}.type`, message: "Expected once or cron" });
    return undefined;
  }

  if (
    typeof id !== "string" ||
    typeof value.enabled !== "boolean" ||
    (value.delivery !== "session" && value.delivery !== "source") ||
    typeof value.prompt !== "string"
  ) {
    return undefined;
  }

  if (type === "once") {
    const at = value.at;
    const atDate = typeof at === "string" ? validRfc3339WithOffset(at) : undefined;
    if (typeof at !== "string" || !atDate) {
      errors.push({
        path: `${basePath}.at`,
        message: "Expected an RFC 3339 timestamp with an explicit offset",
      });
      return undefined;
    }
    return {
      id,
      enabled: value.enabled,
      type,
      at,
      atDate,
      delivery: value.delivery,
      prompt: value.prompt,
    };
  }

  if (typeof value.cron !== "string" || value.cron.trim().length === 0) {
    errors.push({ path: `${basePath}.cron`, message: "Expected a Croner pattern" });
    return undefined;
  }
  const schedule = cronSchedule(value.cron, timezone, now);
  if ("error" in schedule) {
    errors.push({ path: `${basePath}.cron`, message: schedule.error });
    return undefined;
  }
  return {
    id,
    enabled: value.enabled,
    type,
    cron: value.cron,
    nextRunAt: schedule.nextRunAt,
    delivery: value.delivery,
    prompt: value.prompt,
  };
}

export function parseScheduleSource(
  raw: string | null,
  timezone: string,
  now = new Date(),
): ScheduleConfig {
  if (raw === null) {
    return { valid: true, contentHash: hashContent(""), raw, tasks: [] };
  }
  const contentHash = hashContent(raw);
  if (Buffer.byteLength(raw, "utf8") > MAX_SCHEDULE_FILE_BYTES) {
    return {
      valid: false,
      contentHash,
      raw,
      errors: [{ path: "$", message: "Schedule file exceeds 1 MiB" }],
    };
  }

  const document = parseDocument(raw, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      valid: false,
      contentHash,
      raw,
      errors: document.errors.map((error) => ({
        path: "$",
        message:
          error.code === "DUPLICATE_KEY"
            ? "Duplicate YAML key"
            : "Invalid YAML syntax",
      })),
    };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      valid: false,
      contentHash,
      raw,
      errors: [{ path: "$", message: "YAML aliases are not supported" }],
    };
  }
  const errors: ScheduleValidationError[] = [];
  if (!isRecord(value)) {
    errors.push({ path: "$", message: "Root must be an object" });
  } else {
    validateKnownKeys(value, new Set(["version", "tasks"]), "$", errors);
    if (value.version !== 1) {
      errors.push({ path: "version", message: "Expected version 1" });
    }
    if (!Array.isArray(value.tasks)) {
      errors.push({ path: "tasks", message: "Expected an array" });
    } else if (value.tasks.length > MAX_TASKS) {
      errors.push({ path: "tasks", message: "At most 100 tasks are allowed" });
    }
  }

  const tasks: ScheduleTask[] = [];
  if (isRecord(value) && Array.isArray(value.tasks)) {
    const seenIds = new Set<string>();
    for (const [index, taskValue] of value.tasks.entries()) {
      const task = parseTask(taskValue, index, timezone, now, errors);
      if (!task) continue;
      if (seenIds.has(task.id)) {
        errors.push({ path: `tasks[${index}].id`, message: "Task ID must be unique" });
      } else {
        seenIds.add(task.id);
      }
      tasks.push(task);
    }
  }

  return errors.length > 0
    ? { valid: false, contentHash, raw, errors }
    : { valid: true, contentHash, raw, tasks };
}

export async function loadScheduleConfig(
  filePath: string,
  timezone: string,
  now = new Date(),
): Promise<ScheduleConfig> {
  let raw: string | null;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = null;
  }
  return parseScheduleSource(raw, timezone, now);
}

async function writeAtomic(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeAtomic(filePath, content, 0o600);
  return content;
}

export type DisableScheduleTaskResult =
  | { status: "disabled"; config: ValidScheduleConfig }
  | { status: "changed" | "missing" | "invalid" };

export async function disableScheduleTask(
  filePath: string,
  timezone: string,
  taskId: string,
  expectedDefinitionHash: string,
  now = new Date(),
): Promise<DisableScheduleTaskResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      throw error;
    }
    const config = parseScheduleSource(raw, timezone, now);
    if (!config.valid) return { status: "invalid" };
    const index = config.tasks.findIndex((task) => task.id === taskId);
    const task = config.tasks[index];
    if (
      task === undefined ||
      !task.enabled ||
      scheduleDefinitionHash(task) !== expectedDefinitionHash
    ) {
      return { status: "changed" };
    }

    const document = parseDocument(raw, {
      keepSourceTokens: true,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    document.setIn(["tasks", index, "enabled"], false);
    const updatedRaw = document.toString();

    const latestRaw = await readFile(filePath, "utf8");
    if (hashContent(latestRaw) !== config.contentHash) continue;
    const fileMode = (await stat(filePath)).mode & 0o777;
    await writeAtomic(filePath, updatedRaw, fileMode);
    const updated = parseScheduleSource(updatedRaw, timezone, now);
    if (!updated.valid) throw new Error("Auto-disabled schedule became invalid");
    return { status: "disabled", config: updated };
  }
  return { status: "changed" };
}
