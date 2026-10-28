import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stripModelCredentialEnvironment } from "./providers.ts";
import type { SandboxMode } from "./runtime-options.ts";
import { hostShellCommand, type ShellSyntax } from "./shell.ts";
import {
  windowsNativeSandboxCommand,
  windowsNativeSandboxDescription,
  windowsNativeSandboxEnabled,
} from "./windows-sandbox.ts";

export interface SandboxOptions {
  mode: SandboxMode;
  network: boolean;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  description: string;
}

type SandboxBackend =
  | { kind: "host" | "windows-native" | "seatbelt" | "unavailable" }
  | { kind: "docker"; image: string };

function selectSandboxBackend(options: SandboxOptions): SandboxBackend {
  if (options.mode === "danger-full-access") return { kind: "host" };
  if (windowsNativeSandboxEnabled()) return { kind: "windows-native" };
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return { kind: "seatbelt" };
  const image = process.env.DSCODE_SANDBOX_IMAGE;
  return image && commandExists("docker") ? { kind: "docker", image } : { kind: "unavailable" };
}

/** Use the execution backend's syntax without resolving or launching its shell. */
export function sandboxShellSyntax(options: SandboxOptions): ShellSyntax {
  const backend = selectSandboxBackend(options);
  if (backend.kind === "docker") return "posix";
  return backend.kind === "windows-native" || process.platform === "win32" ? "powershell" : "posix";
}

export function sandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
  processOptions: { stdinOpen?: boolean } = {},
): SandboxedCommand {
  const backend = selectSandboxBackend(options);
  if (backend.kind === "host") {
    return hostShellCommand(shellCommand);
  }

  if (backend.kind === "windows-native") {
    return windowsNativeSandboxCommand(shellCommand, cwd, options);
  }

  if (backend.kind === "seatbelt") {
    const shell = hostShellCommand(shellCommand);
    const workspace = fs.realpathSync(cwd);
    const temporary = fs.realpathSync(os.tmpdir());
    const writable =
      options.mode === "workspace-write"
        ? [workspace, temporary, "/dev/null", "/dev/tty"]
        : ["/dev/null", "/dev/tty"];
    const rules = [
      "(version 1)",
      "(allow default)",
      writable.length === 0
        ? "(deny file-write*)"
        : `(deny file-write* (require-not (require-any ${writable
            .map((directory) => `(subpath "${escapeSeatbelt(directory)}")`)
            .join(" ")})))`,
      options.network ? "" : "(deny network*)",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", rules, shell.command, ...shell.args],
      description: `macOS Seatbelt (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  if (backend.kind === "docker") {
    const { image } = backend;
    const networkArgs = options.network ? [] : ["--network", "none"];
    const userArgs =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    const mount = options.mode === "read-only" ? `${cwd}:/workspace:ro` : `${cwd}:/workspace`;
    const readOnlyArgs =
      options.mode === "read-only"
        ? ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"]
        : [];
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        ...(processOptions.stdinOpen ? ["-i"] : []),
        ...userArgs,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        ...networkArgs,
        ...readOnlyArgs,
        "-v",
        mount,
        "-w",
        "/workspace",
        image,
        "/bin/sh",
        "-c",
        shellCommand,
      ],
      description: `Docker ${image} (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  throw new Error(
    `No OS sandbox backend is available for ${options.mode}. ` +
      "Install macOS sandbox-exec, or set DSCODE_SANDBOX_IMAGE to a trusted Docker image. " +
      "Use --sandbox danger-full-access only for a trusted workspace.",
  );
}

export function sandboxDescription(options: SandboxOptions): string {
  const backend = selectSandboxBackend(options);
  if (backend.kind === "host") return "host access";
  if (backend.kind === "windows-native") return windowsNativeSandboxDescription(options);
  if (backend.kind === "seatbelt") {
    return `Seatbelt ${options.mode}${options.network ? " + network" : ""}`;
  }
  if (backend.kind === "docker") {
    return `Docker ${options.mode}${options.network ? " + network" : ""}`;
  }
  return `unavailable (${options.mode})`;
}

export function executeSandboxedCommand(
  shellCommand: string,
  cwd: string,
  sandbox: SandboxOptions,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const invocation = sandboxCommand(shellCommand, cwd, sandbox);
  return new Promise((resolve, reject) => {
    const environment = stripModelCredentialEnvironment({ ...(options.env ?? process.env) });
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const stop = (): void => {
      if (child.killed) return;
      signalSandboxProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(
        () => {
          if (child.exitCode === null && child.signalCode === null) {
            signalSandboxProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          }
        },
        1_500,
      ).unref();
    };
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(stop, Math.max(1, options.timeout));
    timer?.unref();
    const abort = (): void => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode });
    });
  });
}

function signalSandboxProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
  if (process.platform === "win32" || pid === undefined) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

function escapeSeatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .some((directory) => fs.existsSync(path.join(directory, command)));
}
