import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SandboxOptions, SandboxedCommand } from "./sandbox.js";
import type { ShellInvocation } from "./shell.js";

const EXPERIMENTAL_ENV = "DSCODE_WINDOWS_SANDBOX";
const HELPER_ENV = "DSCODE_WINDOWS_SANDBOX_HELPER";
const STATE_ENV = "DSCODE_WINDOWS_SANDBOX_STATE";

interface WindowsSandboxStatus {
  ready: boolean;
  version?: number;
  missing?: string[];
}

interface WindowsSandboxRuntime {
  helperPath: string;
  statePath: string;
  shell?: ShellInvocation;
}

export function windowsNativeSandboxEnabled(): boolean {
  const value = process.env[EXPERIMENTAL_ENV]?.trim().toLowerCase();
  return process.platform === "win32" && (value === "1" || value === "true");
}

export function windowsNativeSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): SandboxedCommand {
  const runtime = configuredRuntime();
  const status = readStatus(runtime);
  if (!status.ready) {
    const details = status.missing?.length ? ` Missing: ${status.missing.join(", ")}.` : "";
    throw new Error(
      `The experimental Windows native sandbox is not ready.${details} ` +
        "Run the Windows sandbox setup command from an elevated terminal.",
    );
  }
  return buildWindowsSandboxCommand(shellCommand, cwd, options, runtime);
}

export function buildWindowsSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
  runtime: WindowsSandboxRuntime,
): SandboxedCommand {
  const shell = runtime.shell ?? nativePowerShellCommand(shellCommand);
  const requestPath = path.join(
    os.tmpdir(),
    `dscode-windows-sandbox-${process.pid}-${randomUUID()}.json`,
  );
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      version: 1,
      state_path: runtime.statePath,
      mode: options.mode,
      network: options.network,
      command: shell.command,
      args: shell.args,
      cwd: path.resolve(cwd),
    }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    command: runtime.helperPath,
    args: ["run", requestPath],
    description: `Windows native sandbox (${options.mode}${options.network ? ", network" : ", no network"})`,
  };
}

function nativePowerShellCommand(shellCommand: string): ShellInvocation {
  const configured = process.env.DSCODE_SHELL?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (path.basename(resolved).toLowerCase() !== "pwsh.exe" || !fs.existsSync(resolved)) {
      throw new Error("The Windows native sandbox requires DSCODE_SHELL to point to pwsh.exe.");
    }
    return powerShellInvocation(resolved, shellCommand);
  }
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, "pwsh.exe");
    if (fs.existsSync(candidate)) return powerShellInvocation(candidate, shellCommand);
  }
  throw new Error(
    "The experimental Windows native sandbox requires PowerShell 7 (pwsh.exe).",
  );
}

function powerShellInvocation(command: string, shellCommand: string): ShellInvocation {
  return {
    command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", shellCommand],
    description: `PowerShell 7 (${path.basename(command)})`,
  };
}

export function windowsNativeSandboxDescription(options: SandboxOptions): string {
  try {
    const status = readStatus(configuredRuntime());
    if (!status.ready) return `Windows native sandbox unavailable (${options.mode})`;
    return `Windows native ${options.mode}${options.network ? " + network" : ""}`;
  } catch {
    return `Windows native sandbox unavailable (${options.mode})`;
  }
}

function configuredRuntime(): WindowsSandboxRuntime {
  const helperPath = process.env[HELPER_ENV]?.trim();
  const statePath = process.env[STATE_ENV]?.trim();
  if (!helperPath || !statePath) {
    throw new Error(
      `The experimental Windows native sandbox requires ${HELPER_ENV} and ${STATE_ENV}.`,
    );
  }
  const resolvedHelper = path.resolve(helperPath);
  const resolvedState = path.resolve(statePath);
  if (!fs.existsSync(resolvedHelper)) {
    throw new Error(`Windows sandbox helper is missing: ${resolvedHelper}`);
  }
  return { helperPath: resolvedHelper, statePath: resolvedState };
}

function readStatus(runtime: WindowsSandboxRuntime): WindowsSandboxStatus {
  const result = spawnSync(runtime.helperPath, ["setup-status", runtime.statePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `Windows sandbox status failed with exit code ${result.status}.`,
    );
  }
  try {
    return JSON.parse(result.stdout) as WindowsSandboxStatus;
  } catch {
    throw new Error("Windows sandbox helper returned malformed status JSON.");
  }
}
