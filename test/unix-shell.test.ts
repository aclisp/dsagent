import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";
import { sandboxCommand } from "../packages/core/src/sandbox.ts";
import { hostShellCommand } from "../packages/core/src/shell.ts";

describe.skipIf(process.platform === "win32")("Unix command shells", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "dscode-unix-shell-"));
    vi.stubEnv("SHELL", "");
    vi.stubEnv("PATH", path.join(root, "bin"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function executable(directory: string, name = "bash", mode = 0o755) {
    await fsp.mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await fsp.writeFile(file, "#!/bin/sh\nexit 0\n", { mode });
    return file;
  }

  // Simulate systems with or without /bin/bash without changing the host installation.
  function binBash(file?: string) {
    const stat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (String(candidate) === "/bin/bash") {
        if (!file) throw new Error("ENOENT");
        return stat(file);
      }
      return stat(candidate);
    });
  }

  it("honors SHELL ahead of Bash discovery and preserves the command as one argument", () => {
    const shell = path.join(root, "preferred shell");
    const script = "printf '%s' 'a b; $HOME'\nprintf second";
    vi.stubEnv("SHELL", shell);
    expect(hostShellCommand(script)).toEqual({ command: shell, args: ["-c", script], description: "host" });
  });

  it.each([undefined, "", " \t "])("uses /bin/bash when SHELL is %j, ahead of Bash on PATH", async (shell) => {
    const alternative = await executable(path.join(root, "bin"));
    binBash(alternative);
    vi.stubEnv("SHELL", shell);
    expect(hostShellCommand("echo hi").command).toBe("/bin/bash");
  });

  it("finds Bash in PATH order when /bin/bash is absent", async () => {
    binBash();
    const first = await executable(path.join(root, "first bin"));
    const second = await executable(path.join(root, "second bin"));
    vi.stubEnv("PATH", `${path.dirname(first)}${path.delimiter}${path.dirname(second)}`);
    expect(hostShellCommand("echo hi")).toMatchObject({ command: first, args: ["-c", "echo hi"] });
  });

  it("skips non-executable Bash files and directories on PATH", async () => {
    binBash();
    const nonExecutable = await executable(path.join(root, "not executable"), "bash", 0o644);
    const directory = path.join(root, "directory");
    await fsp.mkdir(path.join(directory, "bash"), { recursive: true });
    const bash = await executable(path.join(root, "bin"));
    vi.stubEnv("PATH", [path.dirname(nonExecutable), directory, path.dirname(bash)].join(path.delimiter));
    expect(hostShellCommand("echo hi").command).toBe(bash);
  });

  it("falls back to /bin/sh when neither Bash location is available", () => {
    binBash();
    expect(hostShellCommand("echo hi")).toEqual({ command: "/bin/sh", args: ["-c", "echo hi"], description: "host" });
  });

  it("reports an invalid configured SHELL at launch instead of silently selecting Bash", async () => {
    const configured = path.join(root, "missing-shell");
    vi.stubEnv("SHELL", configured);
    expect(hostShellCommand("echo hi").command).toBe(configured);
    const registry = new ManagedProcessRegistry();
    try {
      const result = await registry.start("echo hi", {
        cwd: root, sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 2_000, timeoutMs: 5_000, thinkingLevel: "low",
      });
      expect(result.running).toBe(false);
      expect(result.output).toContain("ENOENT");
      expect(result.output).toContain(configured);
    } finally { await registry.dispose(); }
  });

  it("inherits exported SDK variables and executable paths without login initialization", async () => {
    const sdk = path.join(root, "SDK Tools");
    const bin = path.join(sdk, "bin");
    const probe = await executable(bin, "dscode-sdk-probe");
    await fsp.writeFile(probe, "#!/bin/sh\nprintf '%s' \"$DSCODE_TEST_SDK_HOME\"\n");
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("PATH", bin);
    vi.stubEnv("DSCODE_TEST_SDK_HOME", sdk);
    const registry = new ManagedProcessRegistry();
    try {
      const result = await registry.start("dscode-sdk-probe", {
        cwd: root, sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 2_000, timeoutMs: 5_000, thinkingLevel: "low",
      });
      expect(result).toMatchObject({ running: false, exitCode: 0, output: sdk });
    } finally { await registry.dispose(); }
  });

  it.runIf(fs.existsSync("/bin/bash"))("executes Bash as a non-login shell", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const registry = new ManagedProcessRegistry();
    try {
      const result = await registry.start("if shopt -q login_shell; then printf login; else printf non-login; fi", {
        cwd: root, sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 2_000, timeoutMs: 5_000, thinkingLevel: "low",
      });
      expect(result).toMatchObject({ running: false, exitCode: 0, output: "non-login" });
    } finally { await registry.dispose(); }
  });

  it.runIf(process.platform === "darwin")("uses the same selected shell and flags in macOS Seatbelt", () => {
    const configured = path.join(root, "preferred shell");
    const script = "printf '%s' 'a b'";
    vi.stubEnv("SHELL", configured);
    const invocation = sandboxCommand(script, root, { mode: "workspace-write", network: false });
    expect(invocation.command).toBe("/usr/bin/sandbox-exec");
    expect(invocation.args.slice(2)).toEqual([configured, "-c", script]);
  });

  it("uses /bin/sh -c inside Docker without selecting a host shell for the container", async () => {
    const exists = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) !== "/usr/bin/sandbox-exec" && exists(file));
    await executable(path.join(root, "bin"), "docker");
    vi.stubEnv("SHELL", "/host/only/zsh");
    vi.stubEnv("DSCODE_SANDBOX_IMAGE", "test-image");
    const invocation = sandboxCommand("printf hello", root, { mode: "workspace-write", network: false });
    expect(invocation.command).toBe("docker");
    expect(invocation.args.slice(-4)).toEqual(["test-image", "/bin/sh", "-c", "printf hello"]);
    expect(invocation.args).not.toContain("/host/only/zsh");
    expect(invocation.args).toContain("--network");
  });
});
