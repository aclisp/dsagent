import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("runProcess", () => {
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    restore("DEEPSEEK_API_KEY", originalDeepSeekKey);
    restore("OPENAI_API_KEY", originalOpenAIKey);
  });

  it("does not expose model API keys to child commands", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-must-not-leak";
    process.env.OPENAI_API_KEY = "openai-must-not-leak";
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(`${process.env.DEEPSEEK_API_KEY ?? 'unset'}|${process.env.OPENAI_API_KEY ?? 'unset'}`)",
      ],
      { cwd: os.tmpdir() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("unset|unset");
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

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
