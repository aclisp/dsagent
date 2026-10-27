import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Python and pywinpty are acceptance-runner dependencies, never CLI dependencies. */
export function ptyInvocation(command, args, probe = false) {
  const windows = process.platform === "win32";
  const bridge = windows ? "test/fixtures/windows-pty.py"
    : probe ? "standalone/test/run_pty.py" : "test/fixtures/tui-bridge.py";
  return {
    command: process.env.DSCODE_TEST_PYTHON || (windows ? "python" : "/usr/bin/python3"),
    args: ["-B", path.join(root, bridge), ...(windows && probe ? ["--probe"] : []), command, ...args],
  };
}

export function terminatePty(child) {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  }
  child.kill("SIGKILL");
}

/** Keep the CLI's PATH free of Node/Bun while retaining Windows system commands. */
export function isolatedRuntimeEnvironment(home, temporary, restrictPath = true) {
  if (process.platform !== "win32") {
    return { HOME: home, USERPROFILE: home, TMPDIR: temporary, PATH: restrictPath ? "/usr/bin:/bin" : process.env.PATH };
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files", PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: restrictPath ? [path.join(systemRoot, "System32"), systemRoot,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter) : process.env.PATH,
  };
}
