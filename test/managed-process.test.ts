import os from "node:os";
import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";

describe("ManagedProcessRegistry", () => {
  it("yields and reconnects to a background process", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(
        `${process.execPath} -e "setTimeout(() => process.stdout.write('done'), 100)"`,
        {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 0,
          timeoutMs: 5_000,
        },
      );
      expect(started.running).toBe(true);
      const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
      expect(completed.running).toBe(false);
      expect(completed.exitCode).toBe(0);
      expect(completed.output).toContain("done");
    } finally {
      registry.dispose();
    }
  });
});
