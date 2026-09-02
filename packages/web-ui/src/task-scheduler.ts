import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProactiveDeliveryListener } from "@aclisp/dsagent-chat-client";
import type {
  SessionPort,
  SessionPortTurnContext,
  SessionPortTurnEvent,
  SessionPortTurnStartedEvent,
} from "@aclisp/dsagent-http-adapter/session-port";
import { Cron } from "croner";
import {
  disableScheduleTask,
  loadScheduleConfig,
  scheduleDefinitionHash,
  writeJsonAtomic,
  type ScheduleConfig,
  type ScheduleDelivery,
  type ScheduleTask,
  type ScheduleValidationError,
  type ValidScheduleConfig,
} from "./schedule-config.js";

const SCHEDULE_FILE = "schedules.yaml";
const STATUS_FILE = "schedules.status.json";
const SCHEDULE_DIRECTORY = ".dscode";
const LATE_TOLERANCE_MS = 60_000;
const RELOAD_DEBOUNCE_MS = 50;
const STATUS_RECOVERY_DELAY_MS = 10_000;
const SUBMISSION_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000];
const MAX_INACTIVE_NORMALIZATION_ATTEMPTS = 200;

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

type ScheduleStatus = "active" | "paused" | "exhausted";
type SourceBindingStatus = "bound" | "pending" | "unavailable";
interface PendingSourceBinding {
  epoch: number;
  sourceTurnGeneration?: number;
}
type SkipReason =
  | "overlap"
  | "late"
  | "configuration_changed"
  | "status_unavailable";
type DeliveryStatus =
  | "not_applicable"
  | "pending"
  | "delivered"
  | "failed"
  | "unavailable"
  | "abandoned";
type RunStatus =
  | "submitting"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "submission_failed"
  | "cancelled"
  | "interrupted";

const RUN_STATUSES = new Set<RunStatus>([
  "submitting",
  "running",
  "completed",
  "failed",
  "aborted",
  "submission_failed",
  "cancelled",
  "interrupted",
]);
const DELIVERY_STATUSES = new Set<DeliveryStatus>([
  "not_applicable",
  "pending",
  "delivered",
  "failed",
  "unavailable",
  "abandoned",
]);
const SKIP_REASONS = new Set<SkipReason>([
  "overlap",
  "late",
  "configuration_changed",
  "status_unavailable",
]);

interface RuntimeRun {
  runId: string;
  scheduledAt: string;
  status: RunStatus;
  attempt: number;
  deliveryStatus: DeliveryStatus;
  startedAt?: string;
  finishedAt?: string;
  turnId?: string;
  errorCode?: string;
  cancelled: boolean;
  cancelWait?: () => void;
}

interface SkipSnapshot {
  scheduledAt: string;
  skippedAt: string;
  reason: SkipReason;
}

interface TaskRuntime {
  task: ScheduleTask;
  definitionHash: string;
  scheduleStatus: ScheduleStatus;
  nextRunAt: string | null;
  sourceAlias?: string;
  sourceBindingStatus?: SourceBindingStatus;
  currentRun?: RuntimeRun;
  lastRun?: RuntimeRun;
  lastSkip?: SkipSnapshot;
  job?: Cron;
}

interface TurnContext {
  runtime: TaskRuntime;
  run: RuntimeRun;
}

export type SourceDeliveryRegistration =
  | "registered"
  | "unavailable"
  | "failed";

export interface ScheduledSourceDeliveryPort {
  registerTurnForSourceDelivery(
    turnId: string,
    conversationAlias: string,
    listener?: ProactiveDeliveryListener,
  ): SourceDeliveryRegistration;
}

export interface TaskSchedulerLogger {
  error(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
}

export interface CreateTaskSchedulerOptions {
  workspaceId: string;
  workspacePath: string;
  timezone: string;
  sessionPort: SessionPort;
  sourceDelivery?: ScheduledSourceDeliveryPort;
  logger: TaskSchedulerLogger;
  now?: () => Date;
  random?: () => number;
  retryDelaysMs?: readonly number[];
  watch?: boolean;
}

export interface TaskScheduler {
  readonly scheduleFilePath: string;
  readonly statusFilePath: string;
  reload(): Promise<void>;
  dispose(): Promise<void>;
}

interface PersistedTaskState {
  id?: unknown;
  definitionHash?: unknown;
  delivery?: unknown;
  sourceAlias?: unknown;
  sourceBindingStatus?: unknown;
  scheduleStatus?: unknown;
  currentRun?: unknown;
  lastRun?: unknown;
  lastSkip?: unknown;
}

interface PersistedStatus {
  version?: unknown;
  timezone?: unknown;
  tasks?: unknown;
}

function validateTimezone(timezone: string): void {
  if (timezone.trim().length === 0) {
    throw new Error("TZ is required and must be a valid IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`TZ must be a valid IANA timezone: ${timezone}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyRun(value: unknown): RuntimeRun | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.runId !== "string" ||
    typeof value.scheduledAt !== "string" ||
    typeof value.status !== "string" ||
    !RUN_STATUSES.has(value.status as RunStatus) ||
    typeof value.attempt !== "number" ||
    typeof value.deliveryStatus !== "string" ||
    !DELIVERY_STATUSES.has(value.deliveryStatus as DeliveryStatus)
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    scheduledAt: value.scheduledAt,
    status: value.status as RunStatus,
    attempt: value.attempt,
    deliveryStatus: value.deliveryStatus as DeliveryStatus,
    cancelled: false,
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === "string"
      ? { finishedAt: value.finishedAt }
      : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.errorCode === "string"
      ? { errorCode: value.errorCode }
      : {}),
  };
}

function copySkip(value: unknown): SkipSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.scheduledAt !== "string" ||
    typeof value.skippedAt !== "string" ||
    typeof value.reason !== "string" ||
    !SKIP_REASONS.has(value.reason as SkipReason)
  ) {
    return undefined;
  }
  return {
    scheduledAt: value.scheduledAt,
    skippedAt: value.skippedAt,
    reason: value.reason as SkipReason,
  };
}

function publicRun(run: RuntimeRun): Record<string, unknown> {
  return {
    runId: run.runId,
    scheduledAt: run.scheduledAt,
    status: run.status,
    attempt: run.attempt,
    deliveryStatus: run.deliveryStatus,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
  };
}

function scheduleStatus(task: ScheduleTask): ScheduleStatus {
  if (task.type === "cron" && task.nextRunAt === null) return "exhausted";
  return task.enabled ? "active" : "paused";
}

function nextRunAt(task: ScheduleTask): string | null {
  if (!task.enabled) return null;
  return task.type === "once"
    ? task.atDate.toISOString()
    : task.nextRunAt?.toISOString() ?? null;
}

function initialDeliveryStatus(
  delivery: ScheduleDelivery,
  sourceDeliveryAvailable: boolean,
): DeliveryStatus {
  if (delivery === "session") return "not_applicable";
  return sourceDeliveryAvailable ? "pending" : "unavailable";
}

function sourceAliasFromContext(
  event: SessionPortTurnStartedEvent | SessionPortTurnEvent,
): string | undefined {
  const source = event.context?.source;
  if (source?.type !== "im") return undefined;
  const alias = source.conversationAlias.trim();
  return alias.length > 0 ? alias : undefined;
}

function scheduledPrompt(task: ScheduleTask, sourceAlias?: string): string {
  const marker =
    task.delivery === "source" && sourceAlias !== undefined
      ? `[Scheduled task: ${task.id}; source=${sourceAlias}]`
      : `[Scheduled task: ${task.id}]`;
  return `${marker}\n\n${task.prompt}`;
}

function jitteredDelay(delay: number, random: () => number): number {
  return Math.round(delay * (0.8 + random() * 0.4));
}

class DefaultTaskScheduler implements TaskScheduler {
  readonly scheduleFilePath: string;
  readonly statusFilePath: string;
  private readonly directoryPath: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly retryDelaysMs: readonly number[];
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly turnContexts = new Map<string, TurnContext>();
  private readonly pendingSourceBindings = new Map<string, PendingSourceBinding>();
  private readonly deliveryByTaskId = new Map<string, ScheduleDelivery>();
  private readonly unsubscribeSessionPort: () => void;
  private readonly unsubscribeTurnStarted: () => void;
  private readonly activeSourceTurns = new Map<
    string,
    { alias: string; generation: number }
  >();
  private sourceTurnGeneration = 0;
  private turnEpoch = 0;
  private observedConfig: ScheduleConfig | undefined;
  private activeContentHash: string | null = null;
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private statusVerifyTimer: NodeJS.Timeout | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private reloadChain = Promise.resolve();
  private statusWriteChain = Promise.resolve();
  private initialSubmissionGate = Promise.resolve();
  private expectedStatusContent = "";
  private statusWritable = true;
  private loadedAt = new Date(0).toISOString();
  private disposed = false;

  private constructor(private readonly options: CreateTaskSchedulerOptions) {
    this.directoryPath = path.join(options.workspacePath, SCHEDULE_DIRECTORY);
    this.scheduleFilePath = path.join(this.directoryPath, SCHEDULE_FILE);
    this.statusFilePath = path.join(this.directoryPath, STATUS_FILE);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.retryDelaysMs = options.retryDelaysMs ?? SUBMISSION_RETRY_DELAYS_MS;
    this.unsubscribeSessionPort = options.sessionPort.subscribe((event) =>
      this.handleTurnTerminal(event),
    );
    this.unsubscribeTurnStarted =
      options.sessionPort.subscribeTurnStarted?.((event) =>
        this.handleTurnStarted(event),
      ) ?? (() => undefined);
  }

  static async create(
    options: CreateTaskSchedulerOptions,
  ): Promise<DefaultTaskScheduler> {
    validateTimezone(options.timezone);
    if (options.workspaceId.trim().length === 0) {
      throw new Error("Scheduled tasks require a workspace ID");
    }
    const scheduler = new DefaultTaskScheduler(options);
    try {
      await mkdir(scheduler.directoryPath, { recursive: true });
      const restored = await scheduler.readPersistedStatus();
      await scheduler.loadAndApply(true, restored);
      if (options.watch !== false) scheduler.startWatcher();
      return scheduler;
    } catch (error) {
      scheduler.unsubscribeSessionPort();
      scheduler.unsubscribeTurnStarted();
      scheduler.stopJobs();
      throw error;
    }
  }

  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const attempt = this.reloadChain.then(() => this.loadAndApply(false));
    this.reloadChain = attempt.catch(() => undefined);
    return attempt;
  }

  private handleTurnStarted(event: SessionPortTurnStartedEvent): void {
    const alias = sourceAliasFromContext(event);
    if (alias === undefined) return;
    this.sourceTurnGeneration += 1;
    this.activeSourceTurns.set(event.turnId, {
      alias,
      generation: this.sourceTurnGeneration,
    });
  }

  private currentSourceTurn():
    | { alias: string; generation: number }
    | undefined {
    const turns = [...this.activeSourceTurns.values()];
    return turns.at(-1);
  }

  private async readPersistedStatus(): Promise<Map<string, PersistedTaskState>> {
    let raw: string;
    try {
      raw = await readFile(this.statusFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedStatus;
      if (
        parsed.version !== 1 ||
        parsed.timezone !== this.options.timezone ||
        !Array.isArray(parsed.tasks)
      ) {
        return new Map();
      }
      return new Map(
        parsed.tasks
          .filter((value): value is PersistedTaskState => isRecord(value))
          .filter(
            (value) =>
              typeof value.id === "string" &&
              typeof value.definitionHash === "string",
          )
          .map((value) => [value.id as string, value]),
      );
    } catch {
      return new Map();
    }
  }

  private async normalizeInactiveTasks(
    config: ValidScheduleConfig,
  ): Promise<ScheduleConfig> {
    let current = config;
    for (
      let attempt = 0;
      attempt < MAX_INACTIVE_NORMALIZATION_ATTEMPTS;
      attempt += 1
    ) {
      const now = this.now();
      const target = current.tasks.find(
        (task) =>
          task.enabled &&
          ((task.type === "once" && task.atDate.getTime() <= now.getTime()) ||
            (task.type === "cron" && task.nextRunAt === null)),
      );
      if (!target) return current;
      const result = await disableScheduleTask(
        this.scheduleFilePath,
        this.options.timezone,
        target.id,
        scheduleDefinitionHash(target),
        now,
      );
      if (result.status === "disabled") {
        current = result.config;
        continue;
      }
      const reloaded = await loadScheduleConfig(
        this.scheduleFilePath,
        this.options.timezone,
        this.now(),
      );
      if (!reloaded.valid) return reloaded;
      current = reloaded;
    }
    throw new Error("Schedule configuration changed repeatedly while normalizing");
  }

  private async loadAndApply(
    initial: boolean,
    restored = new Map<string, PersistedTaskState>(),
  ): Promise<void> {
    if (initial) this.restoreDeliveryBaselines(restored);
    let config = await loadScheduleConfig(
      this.scheduleFilePath,
      this.options.timezone,
      this.now(),
    );
    const missedOnce = new Map<string, Date>();
    if (config.valid) {
      const now = this.now().getTime();
      for (const task of config.tasks) {
        if (task.enabled && task.type === "once" && task.atDate.getTime() <= now) {
          missedOnce.set(task.id, task.atDate);
        }
      }
    }
    if (config.valid) config = await this.normalizeInactiveTasks(config);
    this.loadedAt = this.now().toISOString();

    if (!config.valid) {
      this.observedConfig = config;
      const written = await this.persistStatus(initial);
      if (!written && initial) throw new Error("Could not write schedules.status.json");
      return;
    }

    const immutableErrors = this.deliveryImmutabilityErrors(config);
    if (immutableErrors.length > 0) {
      this.observedConfig = {
        valid: false,
        contentHash: config.contentHash,
        raw: config.raw ?? "",
        errors: immutableErrors,
      };
      const written = await this.persistStatus(initial);
      if (!written && initial) throw new Error("Could not write schedules.status.json");
      return;
    }

    this.observedConfig = config;

    this.applyValidConfig(config, restored, initial);
    for (const [taskId, scheduledAt] of missedOnce) {
      const runtime = this.runtimes.get(taskId);
      if (runtime) this.recordSkip(runtime, scheduledAt, "late");
    }
    const written = await this.persistStatus(initial);
    if (!written) {
      this.stopJobs();
      if (initial) throw new Error("Could not write schedules.status.json");
      return;
    }
    this.scheduleJobs();
  }

  private restoreDeliveryBaselines(
    restored: Map<string, PersistedTaskState>,
  ): void {
    this.deliveryByTaskId.clear();
    for (const [taskId, state] of restored) {
      if (state.delivery === "session" || state.delivery === "source") {
        this.deliveryByTaskId.set(taskId, state.delivery);
      }
    }
  }

  private deliveryImmutabilityErrors(
    config: ValidScheduleConfig,
  ): ScheduleValidationError[] {
    const errors: ScheduleValidationError[] = [];
    for (const [index, task] of config.tasks.entries()) {
      const existing =
        this.runtimes.get(task.id)?.task.delivery ?? this.deliveryByTaskId.get(task.id);
      if (existing !== undefined && existing !== task.delivery) {
        errors.push({
          path: `tasks[${index}].delivery`,
          message: "Task delivery is immutable; delete and recreate the task to change it",
        });
      }
    }
    return errors;
  }

  private applyValidConfig(
    config: ValidScheduleConfig,
    restored: Map<string, PersistedTaskState>,
    initial: boolean,
  ): void {
    const previous = new Map(this.runtimes);
    const previousPending = new Map(this.pendingSourceBindings);
    const nextPending = new Map<string, PendingSourceBinding>();
    this.stopJobs();
    this.runtimes.clear();

    for (const task of config.tasks) {
      const definitionHash = scheduleDefinitionHash(task);
      const old = previous.get(task.id);
      const saved = restored.get(task.id);
      let runtime: TaskRuntime;
      if (old?.definitionHash === definitionHash) {
        runtime = old;
        const disabledWhileSubmitting =
          old.task.enabled &&
          !task.enabled &&
          old.currentRun?.status === "submitting";
        runtime.task = task;
        runtime.scheduleStatus = scheduleStatus(task);
        runtime.nextRunAt = nextRunAt(task);
        if (disabledWhileSubmitting) {
          this.cancelSubmittingRun(runtime, "configuration_changed");
        }
      } else {
        if (old?.currentRun?.status === "submitting") {
          this.cancelSubmittingRun(old, "configuration_changed");
        }
        runtime = {
          task,
          definitionHash,
          scheduleStatus: scheduleStatus(task),
          nextRunAt: nextRunAt(task),
        };
        if (saved?.definitionHash === definitionHash) {
          const savedLastRun = copyRun(saved.lastRun);
          const savedLastSkip = copySkip(saved.lastSkip);
          if (savedLastRun) runtime.lastRun = savedLastRun;
          if (savedLastSkip) runtime.lastSkip = savedLastSkip;
          const interrupted = copyRun(saved.currentRun);
          if (interrupted) {
            interrupted.status = "interrupted";
            interrupted.finishedAt = this.now().toISOString();
            if (interrupted.deliveryStatus === "pending") {
              interrupted.deliveryStatus = "abandoned";
            }
            runtime.lastRun = interrupted;
          }
          if (saved.scheduleStatus === "exhausted") {
            runtime.scheduleStatus = "exhausted";
          }
        }
      }

      if (task.delivery === "source") {
        const savedAlias =
          typeof saved?.sourceAlias === "string" && saved.sourceAlias.trim().length > 0
            ? saved.sourceAlias.trim()
            : undefined;
        const sourceAlias = runtime.sourceAlias ?? old?.sourceAlias ?? savedAlias;
        if (sourceAlias !== undefined) {
          runtime.sourceAlias = sourceAlias;
          runtime.sourceBindingStatus = "bound";
        } else {
          const previousCandidate = previousPending.get(task.id);
          const activeSource = this.currentSourceTurn();
          let candidate = previousCandidate;
          if (candidate === undefined && old === undefined && !initial) {
            candidate = {
              epoch: this.turnEpoch,
              ...(activeSource !== undefined
                ? { sourceTurnGeneration: activeSource.generation }
                : {}),
            };
          }
          if (
            candidate !== undefined &&
            activeSource !== undefined &&
            candidate.sourceTurnGeneration === activeSource.generation
          ) {
            runtime.sourceAlias = activeSource.alias;
            runtime.sourceBindingStatus = "bound";
          } else {
            runtime.sourceBindingStatus =
              candidate === undefined ? "unavailable" : "pending";
            if (candidate !== undefined) nextPending.set(task.id, candidate);
          }
        }
      } else {
        delete runtime.sourceAlias;
        delete runtime.sourceBindingStatus;
      }
      this.runtimes.set(task.id, runtime);
      previous.delete(task.id);
    }

    for (const runtime of previous.values()) {
      if (runtime.currentRun?.status === "submitting") {
        this.cancelSubmittingRun(runtime, "configuration_changed");
      }
    }
    this.pendingSourceBindings.clear();
    for (const [taskId, candidate] of nextPending) {
      if (this.runtimes.has(taskId)) this.pendingSourceBindings.set(taskId, candidate);
    }
    this.deliveryByTaskId.clear();
    for (const task of config.tasks) {
      this.deliveryByTaskId.set(task.id, task.delivery);
    }
    this.activeContentHash = config.contentHash;
  }

  private startWatcher(): void {
    this.watcher = watch(
      this.directoryPath,
      { encoding: "utf8", persistent: false },
      (_eventType, filename) => {
        if (this.disposed || filename === null) return;
        if (filename === SCHEDULE_FILE) {
          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            this.reloadTimer = undefined;
            void this.reload().catch((error: unknown) => {
              this.options.logger.error(
                { err: error },
                "Scheduled task configuration reload failed",
              );
            });
          }, RELOAD_DEBOUNCE_MS);
          this.reloadTimer.unref();
        } else if (filename === STATUS_FILE) {
          if (this.statusVerifyTimer) clearTimeout(this.statusVerifyTimer);
          this.statusVerifyTimer = setTimeout(() => {
            this.statusVerifyTimer = undefined;
            void this.verifyStatusFile();
          }, RELOAD_DEBOUNCE_MS);
          this.statusVerifyTimer.unref();
        }
      },
    );
    this.watcher.on("error", (error) => {
      this.options.logger.error({ err: error }, "Schedule directory watcher failed");
    });
  }

  private async verifyStatusFile(): Promise<void> {
    if (this.disposed) return;
    let actual = "";
    try {
      actual = await readFile(this.statusFilePath, "utf8");
    } catch {
      // A missing or unreadable derived file is rebuilt below.
    }
    if (actual !== this.expectedStatusContent) await this.persistStatus(false);
  }

  private serializedStatus(): Record<string, unknown> {
    const config = this.observedConfig;
    const configValid = config?.valid ?? true;
    const errors: ScheduleValidationError[] =
      config && !config.valid ? config.errors : [];
    return {
      version: 1,
      timezone: this.options.timezone,
      contentHash: config?.contentHash ?? "",
      activeContentHash: this.activeContentHash,
      valid: configValid,
      errors,
      loadedAt: this.loadedAt,
      taskCount: config?.valid === true ? config.tasks.length : 0,
      activeTaskCount: this.runtimes.size,
      sourceDeliveryAvailable: this.options.sourceDelivery !== undefined,
      operational: true,
      tasks: [...this.runtimes.values()].map((runtime) => ({
        id: runtime.task.id,
        definitionHash: runtime.definitionHash,
        delivery: runtime.task.delivery,
        ...(runtime.task.delivery === "source"
          ? {
              sourceBindingStatus: runtime.sourceBindingStatus ?? "unavailable",
              ...(runtime.sourceAlias !== undefined
                ? { sourceAlias: runtime.sourceAlias }
                : {}),
            }
          : {}),
        scheduleStatus: runtime.scheduleStatus,
        nextRunAt: runtime.nextRunAt,
        ...(runtime.currentRun !== undefined
          ? { currentRun: publicRun(runtime.currentRun) }
          : {}),
        ...(runtime.lastRun !== undefined
          ? { lastRun: publicRun(runtime.lastRun) }
          : {}),
        ...(runtime.lastSkip !== undefined ? { lastSkip: runtime.lastSkip } : {}),
      })),
    };
  }

  private async persistStatus(initial: boolean): Promise<boolean> {
    if (this.disposed && !initial) return false;
    const snapshot = this.serializedStatus();
    const attempt = this.statusWriteChain.then(() =>
      writeJsonAtomic(this.statusFilePath, snapshot),
    );
    this.statusWriteChain = attempt.then(
      () => undefined,
      () => undefined,
    );
    try {
      this.expectedStatusContent = await attempt;
      const recovered = !this.statusWritable;
      this.statusWritable = true;
      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }
      if (recovered && this.observedConfig?.valid) {
        void this.reload().catch((error: unknown) => {
          this.options.logger.error(
            { err: error },
            "Scheduled task recovery reload failed",
          );
        });
      }
      return true;
    } catch (error) {
      this.statusWritable = false;
      this.options.logger.error({ err: error }, "Schedule status write failed");
      if (!initial) this.scheduleStatusRecovery();
      return false;
    }
  }

  private scheduleStatusRecovery(): void {
    if (this.disposed || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.persistStatus(false);
    }, STATUS_RECOVERY_DELAY_MS);
    this.recoveryTimer.unref();
  }

  private scheduleJobs(): void {
    if (this.disposed || !this.statusWritable || !this.observedConfig?.valid) return;
    for (const runtime of this.runtimes.values()) {
      if (!runtime.task.enabled || runtime.job) continue;
      if (runtime.task.delivery === "source" && runtime.sourceAlias === undefined) {
        continue;
      }
      this.scheduleJob(runtime);
    }
  }

  private scheduleJob(runtime: TaskRuntime): void {
    let plannedAt =
      runtime.task.type === "once"
        ? runtime.task.atDate
        : runtime.task.nextRunAt;
    if (!plannedAt) return;

    const pattern =
      runtime.task.type === "once" ? runtime.task.atDate : runtime.task.cron;
    const options =
      runtime.task.type === "once"
        ? { unref: true }
        : { timezone: this.options.timezone, unref: true };
    const job = new Cron(pattern, options);
    job.schedule((self) => {
      const scheduledAt = plannedAt ?? this.now();
      plannedAt =
        runtime.task.type === "cron" ? self.nextRun(this.now()) : null;
      runtime.nextRunAt = plannedAt?.toISOString() ?? null;
      const consume = runtime.task.type === "once" || plannedAt === null;
      void this.handleOccurrence(runtime, scheduledAt, consume).catch(
        (error: unknown) => {
          this.options.logger.error(
            { err: error, taskId: runtime.task.id },
            "Scheduled occurrence failed",
          );
        },
      );
    });
    runtime.job = job;
  }

  private stopJobs(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.job?.stop();
      delete runtime.job;
    }
  }

  private async consumeTask(runtime: TaskRuntime): Promise<boolean> {
    const result = await disableScheduleTask(
      this.scheduleFilePath,
      this.options.timezone,
      runtime.task.id,
      runtime.definitionHash,
      this.now(),
    );
    if (result.status !== "disabled") return false;
    this.observedConfig = result.config;
    this.activeContentHash = result.config.contentHash;
    const updated = result.config.tasks.find((task) => task.id === runtime.task.id);
    if (updated) runtime.task = updated;
    runtime.scheduleStatus =
      runtime.task.type === "cron" ? "exhausted" : "paused";
    runtime.nextRunAt = null;
    runtime.job?.stop();
    delete runtime.job;
    return true;
  }

  private recordSkip(
    runtime: TaskRuntime,
    scheduledAt: Date,
    reason: SkipReason,
  ): void {
    runtime.lastSkip = {
      scheduledAt: scheduledAt.toISOString(),
      skippedAt: this.now().toISOString(),
      reason,
    };
  }

  private async handleOccurrence(
    runtime: TaskRuntime,
    scheduledAt: Date,
    consume: boolean,
  ): Promise<void> {
    const releaseInitialSubmission = await this.acquireInitialSubmissionGate();
    let gateReleased = false;
    const releaseGate = (): void => {
      if (gateReleased) return;
      gateReleased = true;
      releaseInitialSubmission();
    };
    try {
      if (this.disposed) return;
      if (
        this.runtimes.get(runtime.task.id) !== runtime ||
        !runtime.task.enabled
      ) {
        return;
      }
      if (runtime.currentRun) {
        this.recordSkip(runtime, scheduledAt, "overlap");
        await this.persistStatus(false);
        return;
      }
      if (consume && !(await this.consumeTask(runtime))) {
        this.recordSkip(runtime, scheduledAt, "configuration_changed");
        await this.persistStatus(false);
        await this.reload();
        return;
      }
      if (this.runtimes.get(runtime.task.id) !== runtime) return;
      if (this.now().getTime() - scheduledAt.getTime() > LATE_TOLERANCE_MS) {
        this.recordSkip(runtime, scheduledAt, "late");
        await this.persistStatus(false);
        return;
      }
      if (!this.statusWritable) {
        this.recordSkip(runtime, scheduledAt, "status_unavailable");
        this.scheduleStatusRecovery();
        return;
      }

      const run: RuntimeRun = {
        runId: randomUUID(),
        scheduledAt: scheduledAt.toISOString(),
        status: "submitting",
        attempt: 1,
        deliveryStatus: initialDeliveryStatus(
          runtime.task.delivery,
          this.options.sourceDelivery !== undefined,
        ),
        cancelled: false,
      };
      runtime.currentRun = run;
      if (!(await this.persistStatus(false))) {
        delete runtime.currentRun;
        this.recordSkip(runtime, scheduledAt, "status_unavailable");
        return;
      }
      await this.submitRun(runtime, run, releaseGate);
    } finally {
      releaseGate();
    }
  }

  private async acquireInitialSubmissionGate(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.initialSubmissionGate;
    this.initialSubmissionGate = previous.then(() => current);
    await previous;
    return release;
  }

  private async submitRun(
    runtime: TaskRuntime,
    run: RuntimeRun,
    releaseInitialSubmission: () => void,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.retryDelaysMs.length + 1; attempt += 1) {
      if (this.disposed || run.cancelled) return;
      run.attempt = attempt;
      if (attempt > 1 && !(await this.persistStatus(false))) {
        this.finishSubmission(runtime, run, "submission_failed", "status_unavailable");
        return;
      }

      let submission: Awaited<ReturnType<SessionPort["submitTurn"]>>;
      try {
        const sourceContext: SessionPortTurnContext | undefined =
          runtime.task.delivery === "source" && runtime.sourceAlias !== undefined
            ? {
                source: {
                  type: "im",
                  conversationAlias: runtime.sourceAlias,
                },
              }
            : undefined;
        submission = await this.options.sessionPort.submitTurn(
          this.options.workspaceId,
          scheduledPrompt(runtime.task, runtime.sourceAlias),
          sourceContext,
        );
        if (attempt === 1) releaseInitialSubmission();
      } catch (error) {
        if (attempt === 1) releaseInitialSubmission();
        this.options.logger.error(
          { err: error, taskId: runtime.task.id, runId: run.runId, attempt },
          "Scheduled Turn submission failed",
        );
        this.finishSubmission(runtime, run, "submission_failed", "submission_error");
        await this.persistStatus(false);
        return;
      }

      if (submission.status === "accepted") {
        run.status = "running";
        run.startedAt = this.now().toISOString();
        run.turnId = submission.turnId;
        this.turnContexts.set(submission.turnId, { runtime, run });
        if (runtime.task.delivery === "source") {
          const sourceAlias = runtime.sourceAlias;
          if (sourceAlias === undefined || this.options.sourceDelivery === undefined) {
            run.deliveryStatus = "unavailable";
          } else {
            let registration: SourceDeliveryRegistration;
            try {
              registration = this.options.sourceDelivery.registerTurnForSourceDelivery(
                submission.turnId,
                sourceAlias,
                (event) => this.handleDeliveryOutcome(event.turnId, event.status),
              );
            } catch (error) {
              this.options.logger.error(
                { err: error, taskId: runtime.task.id, runId: run.runId },
                "Scheduled source delivery registration failed",
              );
              registration = "failed";
            }
            if (registration !== "registered") {
              run.deliveryStatus = registration;
            }
          }
        }
        await this.persistStatus(false);
        return;
      }

      if (attempt > this.retryDelaysMs.length) {
        this.finishSubmission(runtime, run, "submission_failed", "busy");
        await this.persistStatus(false);
        return;
      }
      const delay = this.retryDelaysMs[attempt - 1];
      if (delay === undefined || !(await this.waitForRetry(run, jitteredDelay(delay, this.random)))) {
        return;
      }
    }
  }

  private waitForRetry(run: RuntimeRun, delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        delete run.cancelWait;
        resolve(true);
      }, delayMs);
      timer.unref();
      run.cancelWait = () => {
        clearTimeout(timer);
        delete run.cancelWait;
        resolve(false);
      };
    });
  }

  private finishSubmission(
    runtime: TaskRuntime,
    run: RuntimeRun,
    status: Extract<RunStatus, "submission_failed" | "cancelled">,
    errorCode: string,
  ): void {
    run.status = status;
    run.errorCode = errorCode;
    run.finishedAt = this.now().toISOString();
    if (runtime.currentRun === run) {
      delete runtime.currentRun;
      runtime.lastRun = run;
    }
  }

  private cancelSubmittingRun(runtime: TaskRuntime, reason: SkipReason): void {
    const run = runtime.currentRun;
    if (!run || run.status !== "submitting") return;
    run.cancelled = true;
    run.cancelWait?.();
    delete runtime.currentRun;
    this.recordSkip(runtime, new Date(run.scheduledAt), reason);
  }

  private bindPendingSourceTasks(
    alias: string,
    sourceTurn: { alias: string; generation: number } | undefined,
  ): boolean {
    let changed = false;
    for (const [taskId, candidate] of this.pendingSourceBindings) {
      const matches =
        sourceTurn === undefined
          ? candidate.epoch === this.turnEpoch
          : candidate.sourceTurnGeneration === sourceTurn.generation;
      if (!matches) continue;
      const runtime = this.runtimes.get(taskId);
      if (
        runtime === undefined ||
        runtime.task.delivery !== "source" ||
        runtime.sourceAlias !== undefined
      ) {
        this.pendingSourceBindings.delete(taskId);
        continue;
      }
      runtime.sourceAlias = alias;
      runtime.sourceBindingStatus = "bound";
      this.pendingSourceBindings.delete(taskId);
      changed = true;
    }
    return changed;
  }

  private finalizePendingSourceTasks(): boolean {
    let changed = false;
    for (const [taskId, candidate] of this.pendingSourceBindings) {
      if (candidate.epoch > this.turnEpoch) continue;
      const runtime = this.runtimes.get(taskId);
      if (runtime !== undefined && runtime.sourceAlias === undefined) {
        runtime.sourceBindingStatus = "unavailable";
        changed = true;
      }
      this.pendingSourceBindings.delete(taskId);
    }
    return changed;
  }

  private async handleTurnTerminal(event: SessionPortTurnEvent): Promise<void> {
    const sourceAlias = sourceAliasFromContext(event);
    const sourceTurn = this.activeSourceTurns.get(event.turnId);
    let bindingChanged = false;
    if (sourceAlias !== undefined || this.pendingSourceBindings.size > 0) {
      try {
        await this.reload();
      } catch (error) {
        this.options.logger.error(
          { err: error, turnId: event.turnId },
          "Scheduled source binding reload failed",
        );
      }
    }
    if (sourceAlias !== undefined) {
      bindingChanged = this.bindPendingSourceTasks(sourceAlias, sourceTurn);
    }
    if (this.finalizePendingSourceTasks()) bindingChanged = true;
    if (sourceTurn !== undefined || sourceAlias !== undefined) {
      this.activeSourceTurns.delete(event.turnId);
    }
    this.turnEpoch += 1;

    const context = this.turnContexts.get(event.turnId);
    if (context !== undefined) {
      this.turnContexts.delete(event.turnId);
      const { runtime, run } = context;
      run.status = event.status;
      run.finishedAt = this.now().toISOString();
      if (event.status !== "completed" && run.deliveryStatus === "pending") {
        run.deliveryStatus = "not_applicable";
      }
      if (runtime.currentRun === run) {
        delete runtime.currentRun;
        runtime.lastRun = run;
      }
    }
    if (bindingChanged) {
      await this.persistStatus(false);
      this.scheduleJobs();
    } else if (context !== undefined) {
      await this.persistStatus(false);
    }
  }

  private async handleDeliveryOutcome(
    turnId: string,
    status: "delivered" | "failed" | "abandoned",
  ): Promise<void> {
    const context = this.turnContexts.get(turnId);
    let run = context?.run;
    if (!run) {
      run = [...this.runtimes.values()]
        .map((runtime) => runtime.lastRun)
        .find((candidate) => candidate?.turnId === turnId);
    }
    if (!run) return;
    run.deliveryStatus = status;
    await this.persistStatus(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.statusVerifyTimer) clearTimeout(this.statusVerifyTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.stopJobs();
    this.unsubscribeSessionPort();
    this.unsubscribeTurnStarted();
    const finishedAt = this.now().toISOString();
    for (const runtime of this.runtimes.values()) {
      const run = runtime.currentRun;
      if (!run) continue;
      run.cancelled = true;
      run.cancelWait?.();
      run.status = "interrupted";
      run.finishedAt = finishedAt;
      if (run.deliveryStatus === "pending") run.deliveryStatus = "abandoned";
      delete runtime.currentRun;
      runtime.lastRun = run;
    }
    this.turnContexts.clear();
    this.activeSourceTurns.clear();
    this.pendingSourceBindings.clear();
    await this.persistStatus(true);
  }
}

export async function createTaskScheduler(
  options: CreateTaskSchedulerOptions,
): Promise<TaskScheduler> {
  return DefaultTaskScheduler.create(options);
}

export function assertValidScheduleTimezone(timezone: string): void {
  validateTimezone(timezone);
}

export function resolveConfiguredTimezone(configuredTimezone: string | undefined): string {
  const timezone = configuredTimezone ?? DEFAULT_TIMEZONE;
  if (!timezone.trim()) {
    throw new Error("TZ is required and must be a valid IANA timezone");
  }
  return timezone;
}
