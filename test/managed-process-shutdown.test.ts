import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")("managed process host shutdown", () => {
  it.each(["normal", "graceful", "exit", "exit-during-dispose", "crash", "uncaught"])(
    "leaves no child behind after %s shutdown",
    async (mode) => {
      const host = spawn(process.execPath, [
        fileURLToPath(new URL("./fixtures/managed-process-shutdown-host.ts", import.meta.url)), mode,
      ], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" });
      let output = "";
      let errors = "";
      host.stdout.on("data", (chunk) => { output += chunk; });
      host.stderr.on("data", (chunk) => { errors += chunk; });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          host.once("error", reject);
          host.once("close", resolve);
        });
        expect(code, errors).toBe(mode === "crash" || mode === "uncaught" ? 1 : 0);
        const pid = Number(/child:(\d+)/.exec(output)?.[1]);
        expect(pid, output).toBeGreaterThan(0);
        await expect.poll(() => isAlive(pid), { timeout: 3_000 }).toBe(false);
        if (mode === "normal" || mode === "graceful") {
          const result = JSON.parse(/result:(.+)/.exec(output)![1]!);
          expect(result.running).toBe(false);
          if (mode === "graceful") {
            expect(result.exitCode).toBe(0);
            expect(result.output).toContain("graceful");
          }
        }
      } finally {
        host.kill("SIGKILL");
        const pid = Number(/child:(\d+)/.exec(output)?.[1]);
        if (pid > 0 && isAlive(pid)) {
          try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ }
        }
      }
    },
    15_000,
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
