import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";
import { withPiManagedBinPath } from "../packages/core/src/process.ts";
import type { SandboxMode } from "../packages/core/src/runtime-options.ts";

const sandboxModes: SandboxMode[] = ["danger-full-access"];
if ((process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
    (process.platform === "linux" && process.env.DSCODE_SANDBOX_IMAGE)) {
  sandboxModes.push("read-only", "workspace-write");
}
const hasRg = spawnSync("rg", ["--version"], {
  env: withPiManagedBinPath(process.env), stdio: "ignore", timeout: 3_000,
}).status === 0;

describe("managed process stdin", () => {
  let root: string;
  let registry: ManagedProcessRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-process-stdin-"));
    await fs.writeFile(path.join(root, "package.json"), '{"@earendil-works/pi-probe":"file-match"}\n');
    registry = new ManagedProcessRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  function options(mode: SandboxMode = "danger-full-access") {
    return {
      cwd: root, sandbox: { mode, network: false },
      yieldTimeMs: 5_000, timeoutMs: 10_000, thinkingLevel: "low" as const,
    };
  }

  describe.each(sandboxModes)("%s", (mode) => {
    it.each([undefined, false])("starts with a null device and immediate EOF (stdinOpen=%s)", async (stdinOpen) => {
      const script = [
        "const fs = require('node:fs');",
        "process.stdout.write(JSON.stringify({device:fs.fstatSync(0).isCharacterDevice(),tty:!!process.stdin.isTTY}));",
        "process.stdin.on('end', () => process.stdout.write(' EOF'));",
        "process.stdin.resume();",
      ].join("\n");
      const result = await registry.start(nodeCommand(script), {
        ...options(mode), ...(stdinOpen === undefined ? {} : { stdinOpen }),
      });
      expect(result).toMatchObject({ running: false, exitCode: 0, output: '{"device":true,"tty":false} EOF' });
    }, 10_000);

    it("keeps an explicitly opened pipe available for input and EOF", async () => {
      const started = await registry.start(nodeCommand(
        "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data); process.stdin.on('end', () => process.stdout.write(input));",
      ), { ...options(mode), stdinOpen: true, yieldTimeMs: 0 });
      const completed = await registry.interact(started.processId, {
        chars: "round-trip\n", eof: true, yieldTimeMs: 5_000,
      });
      expect(completed).toMatchObject({ running: false, exitCode: 0, output: "round-trip\n" });
      expect(completed.writeError).toBeUndefined();
    }, 10_000);
  });

  // The Linux sandbox image need only provide Node; ripgrep runs on the host.
  const rgModes = sandboxModes.filter(mode => process.platform !== "linux" || mode === "danger-full-access");
  it.skipIf(!hasRg).each(rgModes)("searches files without an explicit path in %s", async (mode) => {
    const result = await registry.start(
      "rg --no-config -n '(@earendil-works/pi-|@mariozechner/pi-)' --glob 'package.json' --glob 'AGENTS.md' --glob 'CLAUDE.md'",
      options(mode),
    );
    expect(result).toMatchObject({ running: false, exitCode: 0 });
    expect(result.output).toBe('package.json:1:{"@earendil-works/pi-probe":"file-match"}\n');
  }, 10_000);

  it.each([false, true])("rejects input to a closed stdin without losing control of the job (eof=%s)", async (eof) => {
    const started = await registry.start(nodeCommand("setInterval(() => {}, 1000);"), {
      ...options(), yieldTimeMs: 0,
    });
    const failed = await registry.interact(started.processId, { chars: "input", eof, yieldTimeMs: 0 });
    expect(failed.running).toBe(true);
    expect(failed.writeError).toContain("stdin_open: true");
    for (let index = 0; index < 2; index++) {
      const ended = await registry.interact(started.processId, { eof: true, yieldTimeMs: 0 });
      expect(ended.running).toBe(true);
      expect(ended.writeError).toBeUndefined();
    }
    const polled = await registry.interact(started.processId, { yieldTimeMs: 0 });
    expect(polled.running).toBe(true);
    expect(polled.writeError).toBeUndefined();
    const stopped = await registry.interact(started.processId, {
      terminate: true, chars: "ignored", eof: true, yieldTimeMs: 5_000,
    });
    expect(stopped.running).toBe(false);
    expect(stopped.writeError).toBeUndefined();
  });

  it.skipIf(!hasRg || process.platform === "win32").each([
    { name: "pipeline", command: "printf 'input-probe\\n' | rg --no-config 'input-probe'" },
    { name: "here document", command: "rg --no-config 'input-probe' <<'EOF'\ninput-probe\nEOF" },
    { name: "file redirection", command: "rg --no-config 'file-match' < package.json" },
  ])("preserves shell input from $name", async ({ command, name }) => {
    const result = await registry.start(command, options());
    expect(result).toMatchObject({ running: false, exitCode: 0 });
    expect(result.output).toContain(name === "file redirection" ? "file-match" : "input-probe");
  }, 10_000);
});

function nodeCommand(script: string): string {
  const quoted = process.platform === "win32" ? script.replaceAll("'", "''") : script.replaceAll("'", "'\\''");
  return `node -e '${quoted}'`;
}
