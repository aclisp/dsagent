import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { BoundedOutput, withPiManagedBinPath } from "./process.ts";
import { stripModelCredentialEnvironment } from "./providers.ts";
import { sandboxCommand, type SandboxOptions } from "./sandbox.ts";
import {
  classifyVisionCommand,
  createVisionProcessEnvironment,
  DEFAULT_VISION_CLI_EXECUTABLE,
} from "./vision-command.ts";

export interface ManagedProcessResult {
  processId: string;
  running: boolean;
  output: string;
  exitCode?: number | null;
  timedOut?: boolean;
  writeError?: string;
  sandbox: string;
}

interface ProcessRecord {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: BoundedOutput;
  pending: string;
  running: boolean;
  exitCode?: number | null;
  timedOut: boolean;
  stdinError?: Error;
  sandbox: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
  timeout: NodeJS.Timeout;
}

export interface ManagedProcessRegistryOptions {
  visionExecutable?: string;
  maxCompletedProcesses?: number;
}

const DEFAULT_MAX_COMPLETED_PROCESSES = 100;
const SHUTDOWN_GRACE_MS = 1_500;
const liveChildren = new Set<ChildProcessWithoutNullStreams>();

// Runs even when pi exits without emitting session_shutdown (for example, on a crash).
function killChildrenOnExit(): void {
  for (const child of liveChildren) forceStopChild(child);
}

function trackChild(child: ChildProcessWithoutNullStreams): void {
  if (liveChildren.size === 0) process.on("exit", killChildrenOnExit);
  liveChildren.add(child);
  child.once("close", () => {
    liveChildren.delete(child);
    if (liveChildren.size === 0) process.removeListener("exit", killChildrenOnExit);
  });
}

export class ManagedProcessRegistry {
  private nextProcessId = 1;
  private readonly records = new Map<string, ProcessRecord>();
  // Insertion order tracks completion order, independently of process start order.
  private readonly completedIds = new Set<string>();
  private readonly visionExecutable: string;
  private readonly maxCompletedProcesses: number;
  private disposal?: Promise<void>;

  constructor(options: ManagedProcessRegistryOptions = {}) {
    this.maxCompletedProcesses = options.maxCompletedProcesses ?? DEFAULT_MAX_COMPLETED_PROCESSES;
    if (!Number.isSafeInteger(this.maxCompletedProcesses) || this.maxCompletedProcesses < 0) {
      throw new Error("maxCompletedProcesses must be a non-negative safe integer");
    }
    this.visionExecutable = options.visionExecutable ?? DEFAULT_VISION_CLI_EXECUTABLE;
    if (!path.isAbsolute(this.visionExecutable)) {
      throw new Error("The trusted dscode-vision executable path must be absolute");
    }
  }

  async start(
    command: string,
    options: {
      cwd: string;
      sandbox: SandboxOptions;
      yieldTimeMs: number;
      timeoutMs: number;
      thinkingLevel: ThinkingLevel;
      signal?: AbortSignal;
    },
  ): Promise<ManagedProcessResult> {
    options.signal?.throwIfAborted();
    if (this.disposal) throw new Error("Process registry is disposed");
    const vision = classifyVisionCommand(command);
    if (vision.kind === "invalid") {
      throw new Error(`Invalid dscode-vision command: ${vision.reason}`);
    }
    if (vision.kind === "trusted" && !options.sandbox.network) {
      throw new Error("dscode-vision requires network access");
    }
    const visionCommand = vision.kind === "trusted" ? vision.command : undefined;
    const invocation = visionCommand
      ? {
          command: process.execPath,
          args: [this.visionExecutable, ...visionCommand.args],
          description: "trusted dscode-vision (fixed executable)",
        }
      : sandboxCommand(command, options.cwd, options.sandbox);
    const env = visionCommand
      ? createVisionProcessEnvironment(process.env, options.thinkingLevel)
      : withPiManagedBinPath(stripModelCredentialEnvironment({ ...process.env }));

    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    const id = String(this.nextProcessId++);
    let resolveCompletion = (): void => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: ProcessRecord = {
      id,
      child,
      output: new BoundedOutput(80_000),
      pending: "",
      running: true,
      timedOut: false,
      sandbox: invocation.description,
      completion,
      resolveCompletion,
      timeout: setTimeout(() => {
        record.timedOut = true;
        stopChild(record.child);
      }, options.timeoutMs),
    };
    record.timeout.unref();
    this.records.set(id, record);

    const append = (prefix: string, chunk: Buffer): void => {
      const text = `${prefix}${chunk.toString("utf8")}`;
      record.output.append(text);
      record.pending = `${record.pending}${text}`.slice(-80_000);
    };
    child.stdout.on("data", (chunk: Buffer) => append("", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("[stderr] ", chunk));
    // stdin is a separate EventEmitter: child errors do not cover pipe errors.
    child.stdin.on("error", (error) => {
      record.stdinError = error;
    });
    child.once("error", (error) => {
      append("[error] ", Buffer.from(error.message));
    });
    child.once("close", (exitCode) => {
      record.running = false;
      record.exitCode = exitCode;
      clearTimeout(record.timeout);
      if (this.records.has(id)) {
        this.completedIds.add(id);
        if (this.completedIds.size > this.maxCompletedProcesses) {
          const oldest = this.completedIds.values().next().value!;
          this.completedIds.delete(oldest);
          this.records.delete(oldest);
        }
      }
      record.resolveCompletion();
    });

    const abort = (): void => stopChild(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
      await waitForCompletion(completion, options.yieldTimeMs, options.signal);
      return this.result(record);
    } finally {
      // Once start returns, the registry owns the background process lifetime.
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async interact(
    processId: string,
    options: { chars?: string; eof?: boolean; yieldTimeMs: number; terminate?: boolean; signal?: AbortSignal },
  ): Promise<ManagedProcessResult> {
    options.signal?.throwIfAborted();
    const record = this.records.get(processId);
    if (!record) {
      const available = [...this.records.keys()].join(", ") || "none";
      throw new Error(`Unknown process: ${processId}. Available process IDs: ${available}`);
    }
    if (options.terminate) {
      stopChild(record.child);
    } else if (options.chars || options.eof) {
      const stdin = record.child.stdin;
      let error = record.stdinError;
      // Sending EOF again is harmless, but new characters after EOF are an error.
      const repeatedEof = options.eof && !options.chars && stdin.writableEnded;
      if (!error && !repeatedEof) {
        if (!record.running || stdin.destroyed || !stdin.writable) {
          error = new Error("Process stdin is closed");
        } else {
          error = await withAbort(new Promise<Error | undefined>((resolve) => {
            try {
              const onWrite = (error?: Error | null): void => resolve(error ?? undefined);
              if (options.eof) stdin.end(options.chars ?? "", onWrite);
              else stdin.write(options.chars!, onWrite);
            } catch (error) {
              resolve(error instanceof Error ? error : new Error(String(error)));
            }
          }), options.signal);
        }
      }
      if (error) {
        return { ...this.result(record), writeError: error.message };
      }
    }

    if (record.running) {
      await waitForCompletion(record.completion, options.yieldTimeMs, options.signal);
    }
    return this.result(record);
  }

  list(): Array<{ processId: string; running: boolean; sandbox: string }> {
    return [...this.records.values()].map((record) => ({
      processId: record.id,
      running: record.running,
      sandbox: record.sandbox,
    }));
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeProcesses();
    return this.disposal;
  }

  private async disposeProcesses(): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.running);
    for (const record of this.records.values()) {
      clearTimeout(record.timeout);
    }
    for (const record of running) signalProcessTree(record.child, "SIGTERM");
    const completion = Promise.all(running.map((record) => record.completion)).then(() => {});
    await waitForCompletion(completion, SHUTDOWN_GRACE_MS);
    for (const record of running) {
      if (record.running) forceStopChild(record.child);
    }
    // Bound shutdown even if an escaped descendant keeps a pipe open. The exit
    // hook remains installed for any child whose close event has not arrived.
    await waitForCompletion(completion, SHUTDOWN_GRACE_MS);
    this.records.clear();
    this.completedIds.clear();
  }

  private result(record: ProcessRecord): ManagedProcessResult {
    const pending = record.pending;
    record.pending = "";
    // Once the final result is delivered, neither start nor interact needs a
    // reconnectable record. Unread background completions remain until read.
    if (!record.running) {
      this.records.delete(record.id);
      this.completedIds.delete(record.id);
    }
    return {
      processId: record.id,
      running: record.running,
      output: pending || (record.running ? "(no new output)" : "(process completed)"),
      ...(!record.running ? { exitCode: record.exitCode } : {}),
      ...(record.timedOut ? { timedOut: true } : {}),
      sandbox: record.sandbox,
    };
  }
}

async function waitForCompletion(completion: Promise<void>, yieldTimeMs: number, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await withAbort(Promise.race([
      completion,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, Math.min(yieldTimeMs, 30_000)));
        timer.unref();
      }),
    ]), signal);
  } finally {
    clearTimeout(timer);
  }
}

async function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  signalProcessTree(child, "SIGTERM");
  const timer = setTimeout(() => {
    // The shell may have exited while descendants still hold its pipes open.
    if (liveChildren.has(child)) forceStopChild(child);
  }, SHUTDOWN_GRACE_MS);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

function forceStopChild(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    // Exit handlers cannot wait for an asynchronously spawned taskkill.
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: SHUTDOWN_GRACE_MS });
    child.kill("SIGKILL");
    return;
  }
  signalProcessTree(child, "SIGKILL");
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill(signal));
    killer.once("close", (exitCode) => {
      if (exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    });
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling only the direct child.
    }
  }
  child.kill(signal);
}
