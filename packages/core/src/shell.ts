import fs from "node:fs";
import path from "node:path";

const WINDOWS_POWERSHELL_UTF8_OUTPUT_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export interface ShellInvocation {
  command: string;
  args: string[];
  description: string;
}

/** Build a host-shell invocation without asking Node to reinterpret the command. */
export function hostShellCommand(shellCommand: string): ShellInvocation {
  if (process.platform === "win32") {
    return windowsPowerShellCommand(shellCommand);
  }

  const shell = process.env.SHELL ?? "/bin/sh";
  return {
    command: shell,
    args: ["-lc", shellCommand],
    description: "host",
  };
}

export function windowsPowerShellCommand(
  shellCommand: string,
  mode: "host" | "native-sandbox" = "host",
): ShellInvocation {
  const native = mode === "native-sandbox";
  const command = resolveWindowsPowerShell(native);
  const script = shellCommand.trimStart().startsWith(WINDOWS_POWERSHELL_UTF8_OUTPUT_PREFIX)
    ? shellCommand
    : `${WINDOWS_POWERSHELL_UTF8_OUTPUT_PREFIX}${shellCommand}`;
  return {
    command,
    args: [
      ...(native
        ? ["-NoLogo", "-NoProfile", "-NonInteractive"]
        : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      "-Command",
      script,
    ],
    description: native ? `PowerShell 7 (${path.basename(command)})` : `Windows host (${path.basename(command)})`,
  };
}

function resolveWindowsPowerShell(requirePwsh: boolean): string {
  const configured = process.env.DSCODE_SHELL?.trim();
  if (configured) {
    // Host overrides historically pass through to spawn, including relative paths and bare names.
    if (!requirePwsh) return configured;
    const name = /^(pwsh|powershell)$/i.test(configured) ? `${configured}.exe` : configured;
    const resolved = path.basename(name) === name
      ? findExecutableOnPath(name) ?? path.resolve(name)
      : path.resolve(name);
    if (path.basename(resolved).toLowerCase() !== "pwsh.exe" || !isFile(resolved)) {
      throw new Error("The Windows native sandbox requires DSCODE_SHELL to point to pwsh.exe.");
    }
    return resolved;
  }

  const pwsh = findExecutableOnPath("pwsh.exe") ?? existingFile(path.join(
    process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe",
  ));
  if (pwsh) return pwsh;
  if (requirePwsh) {
    throw new Error("The experimental Windows native sandbox requires PowerShell 7 (pwsh.exe). Install it or set DSCODE_SHELL to its path.");
  }
  const powershell = findExecutableOnPath("powershell.exe") ?? existingFile(path.join(
    process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  ));
  if (powershell) return powershell;
  throw new Error("No PowerShell executable found. Install PowerShell or set DSCODE_SHELL to an existing PowerShell executable.");
}

function findExecutableOnPath(executable: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function existingFile(candidate: string): string | undefined {
  return isFile(candidate) ? candidate : undefined;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
