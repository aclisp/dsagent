import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";

describe("ManagedProcessRegistry", () => {
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
      const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
      expect(completed.running).toBe(false);
      expect(completed.exitCode).toBe(0);
      expect(completed.output).toContain("done");
      expect(registry.list()).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  it("removes commands whose final result is returned by start", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      for (const command of ["printf done", "exit 7"]) {
        const completed = await registry.start(command, {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 2_000,
          timeoutMs: 5_000,
          thinkingLevel: "low",
        });
        expect(completed).toMatchObject({
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
      registry.dispose();
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
      registry.dispose();
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
      registry.dispose();
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
      registry.dispose();
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
        registry.dispose();
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
      registry.dispose();
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
        registry.dispose();
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
