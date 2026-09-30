import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";

describe("ManagedProcessRegistry", () => {
  it("cancels an active start without killing processes already yielded by the same run", async () => {
    const registry = new ManagedProcessRegistry();
    const controller = new AbortController();
    const options = {
      cwd: os.tmpdir(), sandbox: { mode: "danger-full-access" as const, network: false },
      yieldTimeMs: 0, timeoutMs: 10_000, thinkingLevel: "low" as const, signal: controller.signal,
    };
    try {
      const first = await registry.start(longBackgroundCommand(), options);
      const second = await registry.start(longBackgroundCommand(), options);
      const pending = registry.start(longBackgroundCommand(), { ...options, yieldTimeMs: 30_000 });
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      const foreground = registry.list().at(-1)!;
      controller.abort();
      await canceled;
      await expect.poll(() => registry.list().find((p) => p.processId === foreground.processId)?.running)
        .toBe(false);
      for (const process of [first, second]) {
        expect(await registry.interact(process.processId, { yieldTimeMs: 0 })).toMatchObject({ running: true });
        expect(await registry.interact(process.processId, { terminate: true, yieldTimeMs: 2_000 }))
          .toMatchObject({ running: false });
      }
    } finally {
      await registry.dispose();
    }
  });

  it("cancels polling immediately while preserving the process for later input and EOF", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(nodeCommand(
        "let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', () => process.stdout.write(input));",
      ), {
        cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0, timeoutMs: 10_000, thinkingLevel: "low",
      });
      const controller = new AbortController();
      const pending = registry.interact(started.processId, { yieldTimeMs: 30_000, signal: controller.signal });
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await canceled;
      await expect(registry.interact(started.processId, {
        chars: "must not be written", eof: true, yieldTimeMs: 0, signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(await registry.interact(started.processId, { chars: "still alive", eof: true, yieldTimeMs: 2_000 }))
        .toMatchObject({ running: false, exitCode: 0, output: "still alive" });
    } finally {
      await registry.dispose();
    }
  });

  it("cancels a blocked stdin write without terminating the process", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(longBackgroundCommand(), {
        cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0, timeoutMs: 10_000, thinkingLevel: "low",
      });
      const controller = new AbortController();
      const pending = registry.interact(started.processId, {
        chars: "x".repeat(2_000_000), yieldTimeMs: 30_000, signal: controller.signal,
      });
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await canceled;
      expect(await registry.interact(started.processId, { yieldTimeMs: 0 })).toMatchObject({ running: true });
      // Session shutdown still owns cleanup, including pending writes.
      const completion = registry.interact(started.processId, { yieldTimeMs: 2_000 });
      await registry.dispose();
      expect(await completion).toMatchObject({ running: false });
    } finally {
      await registry.dispose();
    }
  });

  it("preserves background timeouts after detaching the startup signal", async () => {
    const registry = new ManagedProcessRegistry();
    const controller = new AbortController();
    try {
      const started = await registry.start(longBackgroundCommand(), {
        cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0, timeoutMs: 250, thinkingLevel: "low", signal: controller.signal,
      });
      controller.abort();
      expect(await registry.interact(started.processId, { yieldTimeMs: 2_000 }))
        .toMatchObject({ running: false, timedOut: true });
    } finally {
      await registry.dispose();
    }
  });

  it.each([undefined, "tail"])("sends EOF after previous input and optional final chars (%s)", async (chars) => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(nodeCommand(
        "let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', () => process.stdout.write(JSON.stringify(input)));",
      ), {
        cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0, timeoutMs: 5_000, thinkingLevel: "low",
      });
      const written = await registry.interact(started.processId, { chars: "head", yieldTimeMs: 0 });
      expect(written.running).toBe(true);
      expect(written.writeError).toBeUndefined();
      const ended = await registry.interact(started.processId, {
        ...(chars === undefined ? {} : { chars }), eof: true, yieldTimeMs: 2_000,
      });
      expect(ended).toMatchObject({ running: false, exitCode: 0, output: JSON.stringify(`head${chars ?? ""}`) });
      expect(ended.writeError).toBeUndefined();
    } finally {
      await registry.dispose();
    }
  });

  it("keeps a process manageable after EOF and rejects further writes", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(nodeCommand(
        "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('EOF received'); setInterval(() => {}, 1000); });",
      ), {
        cwd: os.tmpdir(), sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0, timeoutMs: 5_000, thinkingLevel: "low",
      });
      const ended = await registry.interact(started.processId, { eof: true, yieldTimeMs: 0 });
      expect(ended.running).toBe(true);
      expect(ended.writeError).toBeUndefined();
      const repeated = await registry.interact(started.processId, { eof: true, yieldTimeMs: 0 });
      expect(repeated.running).toBe(true);
      expect(repeated.writeError).toBeUndefined();
      const failed = await registry.interact(started.processId, { chars: "late", yieldTimeMs: 0 });
      expect(failed.running).toBe(true);
      expect(failed.writeError).toContain("stdin is closed");
      let output = ended.output + repeated.output + failed.output;
      await expect.poll(async () => {
        const polled = await registry.interact(started.processId, { yieldTimeMs: 10 });
        expect(polled.running).toBe(true);
        expect(polled.writeError).toBeUndefined();
        output += polled.output;
        return output;
      }).toContain("EOF received");
      await expect(registry.interact(started.processId, { terminate: true, eof: true, chars: "ignored", yieldTimeMs: 2_000 }))
        .resolves.toMatchObject({ running: false });
    } finally {
      await registry.dispose();
    }
  });

  it("writes characters to a running process", async () => {
    const registry = new ManagedProcessRegistry();
    const script = "process.stdin.once('data', data => { process.stdout.write(data); process.exit(0); })";
    const command = process.platform === "win32"
      ? `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`
      : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
    try {
      const started = await registry.start(command, {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 5_000,
        thinkingLevel: "low",
      });
      await expect(registry.interact(started.processId, {
        chars: "hello\n", yieldTimeMs: 2_000,
      })).resolves.toMatchObject({ running: false, output: "hello\n", exitCode: 0 });
    } finally {
      await registry.dispose();
    }
  });

  it.runIf(process.platform !== "win32").each([false, true])("returns closed-stdin write errors and keeps the process manageable (eof=%s)", async (eof) => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start("exec <&-; printf ready; sleep 30", {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 10_000,
        thinkingLevel: "low",
      });
      let output = started.output;
      await expect.poll(async () => {
        output += (await registry.interact(started.processId, { yieldTimeMs: 10 })).output;
        return output;
      }).toContain("ready");

      // A zero wait must still report the asynchronous write failure in this call.
      const failed = await registry.interact(started.processId, { chars: "hello\n", eof, yieldTimeMs: 0 });
      expect(failed.running).toBe(true);
      expect(failed.writeError).toContain("EPIPE");
      const repeated = await registry.interact(started.processId, { chars: "again\n", yieldTimeMs: 0 });
      expect(repeated.running).toBe(true);
      expect(repeated.writeError).toBeTruthy();
      const polled = await registry.interact(started.processId, { yieldTimeMs: 0 });
      expect(polled.running).toBe(true);
      expect(polled.writeError).toBeUndefined();
      await expect(registry.interact(started.processId, { terminate: true, yieldTimeMs: 2_000 }))
        .resolves.toMatchObject({ running: false });
      expect(registry.list()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  it("reports available process IDs, including unread completed processes, for an unknown ID", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      await expect(registry.interact("99", { yieldTimeMs: 0 })).rejects.toThrow(
        "Unknown process: 99. Available process IDs: none",
      );
      const running = await registry.start(longBackgroundCommand(), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 60_000,
        thinkingLevel: "low",
      });
      const completed = await completeUnreadBackgroundJob(registry);
      await expect(
        registry.interact("99", { yieldTimeMs: 0 }),
      ).rejects.toThrow(
        `Unknown process: 99. Available process IDs: ${running.processId}, ${completed.processId}`,
      );
    } finally {
      await registry.dispose();
    }
  });

  it("yields and reconnects to a background process", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(
        backgroundCommand(),
        {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 0,
          timeoutMs: 5_000,
          thinkingLevel: "low",
        },
      );
      expect(started.running).toBe(true);
      expect(started.processId).toBe("1");
      const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
      expect(completed.running).toBe(false);
      expect(completed.exitCode).toBe(0);
      expect(completed.output).toContain("done");
      expect(registry.list()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  it("removes commands whose final result is returned by start without reusing their IDs", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      for (const [index, command] of ["printf done", "exit 7"].entries()) {
        const completed = await registry.start(command, {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 2_000,
          timeoutMs: 5_000,
          thinkingLevel: "low",
        });
        expect(completed).toMatchObject({
          processId: String(index + 1),
          running: false,
          exitCode: command === "exit 7" ? 7 : 0,
        });
        if (command === "printf done") expect(completed.output).toBe("done");
        expect(registry.list()).toEqual([]);
        await expect(
          registry.interact(completed.processId, { yieldTimeMs: 0 }),
        ).rejects.toThrow("Unknown process");
      }
    } finally {
      await registry.dispose();
    }
  });

  it("retains unread background results until read, including the exit status", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await completeUnreadBackgroundJob(registry);
      expect(registry.list()).toContainEqual({
        processId: started.processId,
        running: false,
        sandbox: started.sandbox,
      });
      await expect(
        registry.interact(started.processId, { yieldTimeMs: 0 }),
      ).resolves.toMatchObject({ running: false, output: "done", exitCode: 0 });
      expect(registry.list()).toEqual([]);
      await expect(
        registry.interact(started.processId, { yieldTimeMs: 0 }),
      ).rejects.toThrow("Unknown process");
    } finally {
      await registry.dispose();
    }
  });

  it("bounds unread completed jobs without evicting running jobs", async () => {
    const registry = new ManagedProcessRegistry({ maxCompletedProcesses: 2 });
    const results = [];
    try {
      const running = await registry.start(longBackgroundCommand(), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 60_000,
        thinkingLevel: "low",
      });
      expect(running.running).toBe(true);
      for (let index = 0; index < 3; index += 1) {
        results.push(await completeUnreadBackgroundJob(registry));
      }
      expect(registry.list()).toHaveLength(3);
      expect(registry.list()).toContainEqual({
        processId: running.processId,
        running: true,
        sandbox: running.sandbox,
      });
      await expect(
        registry.interact(results[0]!.processId, { yieldTimeMs: 0 }),
      ).rejects.toThrow("Unknown process");
      for (const completed of results.slice(1)) {
        await expect(
          registry.interact(completed.processId, { yieldTimeMs: 0 }),
        ).resolves.toMatchObject({ running: false, output: "done", exitCode: 0 });
      }
      expect(registry.list()).toHaveLength(1);
      await expect(
        registry.interact(running.processId, { yieldTimeMs: 2_000, terminate: true }),
      ).resolves.toMatchObject({ running: false });
      expect(registry.list()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  }, 30_000);

  it.runIf(process.platform === "win32")("terminates the Windows process tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-process-tree-"));
    const childScript = path.join(root, "child.cjs");
    const parentScript = path.join(root, "parent.cjs");
    const marker = path.join(root, "survived.txt");
    await fs.writeFile(
      childScript,
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 1_000);`,
    );
    await fs.writeFile(
      parentScript,
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" }); process.stdout.write("ready"); setTimeout(() => {}, 3_000);`,
    );

    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(powerShellNodeCommand(parentScript), {
        cwd: root,
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 250,
        timeoutMs: 5_000,
        thinkingLevel: "low",
      });
      expect(started.running).toBe(true);
      expect(started.output).toContain("ready");

      const stopped = await registry.interact(started.processId, {
        yieldTimeMs: 2_000,
        terminate: true,
      });
      expect(stopped.running).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await registry.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "launches an exact vision command through the fixed script with an allowlisted environment",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-vision-process-"));
      const fixedVisionScript = path.join(root, "fixed-vision.mjs");
      const pathShadow = path.join(root, "dscode-vision");
      await fs.writeFile(
        fixedVisionScript,
        `setTimeout(() => console.log(JSON.stringify({
          fixed: true,
          args: process.argv.slice(2),
          openrouter: process.env.OPENROUTER_API_KEY ?? null,
          openai: process.env.OPENAI_API_KEY ?? null,
          custom: process.env.CUSTOM_SECRET ?? null,
          model: process.env.DSCODE_VISION_MODEL ?? null,
          thinking: process.env.DSCODE_VISION_THINKING ?? null
        })), 50);`,
      );
      await fs.writeFile(
        pathShadow,
        "#!/usr/bin/env node\nconsole.log(JSON.stringify({ fixed: false }));\n",
      );
      await fs.chmod(pathShadow, 0o755);

      const environment = saveEnvironment([
        "PATH",
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "CUSTOM_SECRET",
        "DSCODE_VISION_MODEL",
      ]);
      process.env.PATH = `${root}${path.delimiter}${process.env.PATH ?? ""}`;
      process.env.OPENROUTER_API_KEY = "trusted-openrouter-key";
      process.env.OPENAI_API_KEY = "must-not-reach-vision";
      process.env.CUSTOM_SECRET = "must-not-reach-vision";
      process.env.DSCODE_VISION_MODEL = "vision-model";

      const registry = new ManagedProcessRegistry({ visionExecutable: fixedVisionScript });
      try {
        const started = await registry.start(
          'dscode-vision --image "screen shot.png" --prompt "read $IMAGE literally"',
          {
            cwd: root,
            sandbox: { mode: "danger-full-access", network: true },
            yieldTimeMs: 0,
            timeoutMs: 5_000,
            thinkingLevel: "max",
          },
        );
        expect(started.running).toBe(true);
        const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
        expect(completed).toMatchObject({
          running: false,
          exitCode: 0,
          sandbox: "trusted dscode-vision (fixed executable)",
        });
        expect(JSON.parse(completed.output)).toEqual({
          fixed: true,
          args: [
            "--image",
            "screen shot.png",
            "--prompt",
            "read $IMAGE literally",
          ],
          openrouter: "trusted-openrouter-key",
          openai: null,
          custom: null,
          model: "vision-model",
          thinking: "max",
        });
      } finally {
        await registry.dispose();
        restoreEnvironment(environment);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed or ungranted vision commands without a shell fallback", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      await expect(
        registry.start("dscode-vision --image image.png | cat", {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: true },
          yieldTimeMs: 2_000,
          timeoutMs: 5_000,
          thinkingLevel: "high",
        }),
      ).rejects.toThrow(
        "Invalid dscode-vision command: shell operators are not allowed",
      );

      await expect(
        registry.start("cd /workspace && dscode-vision --image image.png", {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: true },
          yieldTimeMs: 2_000,
          timeoutMs: 5_000,
          thinkingLevel: "high",
        }),
      ).rejects.toThrow(
        "Invalid dscode-vision command: dscode-vision must be invoked directly without cd or command chaining",
      );

      await expect(
        registry.start("dscode-vision --image image.png", {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 2_000,
          timeoutMs: 5_000,
          thinkingLevel: "high",
        }),
      ).rejects.toThrow("dscode-vision requires network access");
    } finally {
      await registry.dispose();
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps managed timeout behavior for the trusted vision process",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-vision-timeout-"));
      const fixedVisionScript = path.join(root, "fixed-vision.mjs");
      await fs.writeFile(fixedVisionScript, "setInterval(() => {}, 1_000);\n");
      const registry = new ManagedProcessRegistry({ visionExecutable: fixedVisionScript });
      try {
        const result = await registry.start("dscode-vision --image image.png", {
          cwd: root,
          sandbox: { mode: "danger-full-access", network: true },
          yieldTimeMs: 1_000,
          timeoutMs: 250,
          thinkingLevel: "medium",
        });
        expect(result).toMatchObject({
          running: false,
          timedOut: true,
          sandbox: "trusted dscode-vision (fixed executable)",
        });
      } finally {
        await registry.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function completeUnreadBackgroundJob(registry: ManagedProcessRegistry) {
  const started = await registry.start(backgroundCommand(), {
    cwd: os.tmpdir(),
    sandbox: { mode: "danger-full-access", network: false },
    yieldTimeMs: 0,
    timeoutMs: 5_000,
    thinkingLevel: "low",
  });
  expect(started.running).toBe(true);
  await expect.poll(
    () => registry.list().find((job) => job.processId === started.processId)?.running,
    { interval: 5, timeout: 5_000 },
  ).toBe(false);
  return started;
}

function backgroundCommand(): string {
  const script = "setTimeout(() => process.stdout.write(`done`), 100)";
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
}

function nodeCommand(script: string): string {
  return process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`
    : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
}

function longBackgroundCommand(): string {
  const script = "setInterval(() => {}, 1_000)";
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
}

function powerShellNodeCommand(script: string): string {
  return `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`;
}

function saveEnvironment(names: readonly string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(environment: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
