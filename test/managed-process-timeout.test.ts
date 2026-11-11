import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";

describe("managed process timeout diagnostics", () => {
  let root: string;
  let scriptPath: string;
  let registry: ManagedProcessRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-timeout-"));
    scriptPath = path.join(root, "child.cjs");
    // Launch Node directly, including on Windows, so exit describes this process
    // rather than a shell that may itself wait for inherited pipes.
    registry = new ManagedProcessRegistry({ dscodeExecutable: scriptPath });
  });

  afterEach(async () => {
    await registry.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(script: string, timeoutMs: number) {
    await fs.writeFile(scriptPath, script);
    return registry.start("dscode -p timeout-fixture", {
      cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
      yieldTimeMs: 0, timeoutMs, thinkingLevel: "low",
    });
  }

  it.each([
    { exitCode: 0, stream: "stdout" },
    { exitCode: 3, stream: "stderr" },
  ])("distinguishes exit $exitCode from inherited $stream remaining open", async ({ exitCode, stream }) => {
    const descendant = `setTimeout(() => process.${stream}.write('late output\\n'), 300); setTimeout(() => {}, 3_000);`;
    const stdio = ["ignore", stream === "stdout" ? 1 : "ignore", stream === "stderr" ? 2 : "ignore"];
    const started = await start([
      "const { spawn } = require('node:child_process');",
      // Otherwise libuv's Windows job kills the descendant when this parent exits.
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {`,
      `  stdio: ${JSON.stringify(stdio)}, detached: process.platform === 'win32', windowsHide: true,`,
      "});",
      `process.exit(${exitCode});`,
    ].join("\n"), 1_500);
    let waiting = started;
    let output = started.output;
    await expect.poll(async () => {
      waiting = await registry.interact(started.processId, { yieldTimeMs: 0 });
      output += waiting.output;
      return waiting.exitedAfterMs;
    }, { timeout: 1_000 }).toBeDefined();

    expect(waiting).toMatchObject({ running: true, exitCode });
    expect(waiting.exitedAfterMs).toBeGreaterThanOrEqual(0);
    expect(waiting.timedOut).toBeUndefined();
    expect(waiting.timeoutReason).toBeUndefined();
    expect(registry.list()).toEqual([{ processId: started.processId, running: true, sandbox: "trusted dscode" }]);

    const completed = await registry.interact(started.processId, { yieldTimeMs: 5_000 });
    expect(completed).toMatchObject({
      running: false, exitCode, exitedAfterMs: waiting.exitedAfterMs,
      timedOut: true, timeoutReason: "output_open",
    });
    expect(completed.exitSignal).toBeUndefined();
    expect(output + completed.output).toContain("late output\n");
    expect(registry.list()).toEqual([]);
  });

  it("keeps the deadline reason when termination subsequently makes the process exit", async () => {
    const started = await start(
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);",
      1_000,
    );
    const completed = await registry.interact(started.processId, { yieldTimeMs: 5_000 });
    expect(completed).toMatchObject({ running: false, timedOut: true, timeoutReason: "process_running" });
    expect(completed.exitedAfterMs).toBeTypeOf("number");
    // taskkill forcibly terminates Windows processes; POSIX runs the handler.
    if (process.platform !== "win32") expect(completed.exitCode).toBe(0);
  });

  it.skipIf(process.platform === "win32")("records signal termination without classifying it as a timeout", async () => {
    const started = await start("process.kill(process.pid, 'SIGTERM');", 0);
    const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
    expect(completed).toMatchObject({ running: false, exitCode: null, exitSignal: "SIGTERM" });
    expect(completed.exitedAfterMs).toBeTypeOf("number");
    expect(completed.timedOut).toBeUndefined();
    expect(completed.timeoutReason).toBeUndefined();
  });
});
