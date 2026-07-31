import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("runProcess", () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });

  it("does not expose the model API key to child commands", async () => {
    process.env.DEEPSEEK_API_KEY = "must-not-leak";
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write(process.env.DEEPSEEK_API_KEY ?? 'unset')"],
      { cwd: os.tmpdir() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("unset");
  });

  it("keeps both the head and tail when output is truncated", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('START' + 'x'.repeat(500) + 'END')"],
      { cwd: os.tmpdir(), maxOutputBytes: 100 },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("START");
    expect(result.stdout).toContain("END");
    expect(result.stdout).toContain("tail follows");
  });
});
