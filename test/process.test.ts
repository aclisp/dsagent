import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedOutput, runProcess } from "../packages/core/src/process.ts";

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

  describe.each(["stdout", "stderr"] as const)("UTF-8 %s", (stream) => {
    it.each([
      { text: "中文", split: 1 },
      { text: "😀", split: 2 },
    ])("preserves $text split across reads", async ({ text, split }) => {
      const bytes = Buffer.from(text);
      const first = JSON.stringify([...bytes.subarray(0, split)]);
      const rest = JSON.stringify([...bytes.subarray(split)]);
      const result = await runProcess(process.execPath, ["-e", [
        `process.${stream}.write(Buffer.from(${first}));`,
        `setTimeout(() => process.${stream}.write(Buffer.from(${rest})), 50);`,
      ].join("\n")], { cwd: os.tmpdir() });

      expect(result.exitCode).toBe(0);
      expect(result[stream]).toBe(text);
      expect(result.truncated).toBe(false);
    });
  });

  it("flushes incomplete UTF-8 at EOF for each stream", async () => {
    const result = await runProcess(process.execPath, ["-e", [
      "process.stdout.write(Buffer.from([0xf0, 0x9f]));",
      "process.stderr.write(Buffer.from([0xe4, 0xb8]));",
    ].join("\n")], { cwd: os.tmpdir() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\uFFFD");
    expect(result.stderr).toBe("\uFFFD");
  });
});

describe("BoundedOutput", () => {
  const notice = "\n... output truncated; tail follows ...\n";

  it.each([
    { boundary: "head", text: "aaaaa😀zzzzz", expected: `aaaaa${notice}zz` },
    { boundary: "tail", text: "abcdef😀z", expected: `abcdef${notice}z` },
    { boundary: "both", text: "aaaaa😀middle😀z", expected: `aaaaa${notice}z` },
  ])("keeps complete Unicode characters at the $boundary boundary", ({ text, expected }) => {
    const output = new BoundedOutput(8);
    output.append(text);

    expect(output.truncated).toBe(true);
    expect(output.value()).toBe(expected);
    expect(output.value()).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each([
    { label: "one chunk", chunks: ["aaaaa😀z"] },
    { label: "separate chunks", chunks: ["aaaaa", "😀", "z"] },
    { label: "split surrogate pair", chunks: ["aaaaa\uD83D", "\uDE00z"] },
  ])("preserves an exact-fit character across the head/tail boundary: $label", ({ chunks }) => {
    const output = new BoundedOutput(8);
    for (const chunk of chunks) output.append(chunk);

    expect(output.truncated).toBe(false);
    expect(output.value()).toBe("aaaaa😀z");
  });

  it.each([0, 1, 2])("omits characters that cannot fit complete within a limit of %i", (limit) => {
    const output = new BoundedOutput(limit);
    output.append("😀😀");

    expect(output.truncated).toBe(true);
    expect(output.value()).toBe(notice);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
