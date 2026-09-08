import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";

describe("parseRuntimeArgs", () => {
  const original = {
    provider: process.env.DSCODE_PROVIDER,
    model: process.env.DSCODE_MODEL,
    effort: process.env.DSCODE_EFFORT,
    transport: process.env.DSCODE_TRANSPORT,
    harness: process.env.DSCODE_HARNESS,
    promptContract: process.env.DSCODE_PROMPT_CONTRACT,
    permission: process.env.DSCODE_PERMISSION,
    sandbox: process.env.DSCODE_SANDBOX,
  };

  beforeEach(() => {
    process.env.DSCODE_PROVIDER = "deepseek";
    delete process.env.DSCODE_PROMPT_CONTRACT;
  });

  afterEach(() => {
    restore("DSCODE_PROVIDER", original.provider);
    restore("DSCODE_MODEL", original.model);
    restore("DSCODE_EFFORT", original.effort);
    restore("DSCODE_TRANSPORT", original.transport);
    restore("DSCODE_HARNESS", original.harness);
    restore("DSCODE_PROMPT_CONTRACT", original.promptContract);
    restore("DSCODE_PERMISSION", original.permission);
    restore("DSCODE_SANDBOX", original.sandbox);
  });

  it("injects the DeepSeek provider, max thinking, and selects minimal agent tools", () => {
    delete process.env.DSCODE_MODEL;
    delete process.env.DSCODE_EFFORT;
    delete process.env.DSCODE_TRANSPORT;
    delete process.env.DSCODE_HARNESS;
    delete process.env.DSCODE_PERMISSION;
    delete process.env.DSCODE_SANDBOX;
    const parsed = parseRuntimeArgs(["--print", "inspect this repo"]);

    expect(parsed.options).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      transport: "responses",
      harness: "minimal",
      promptContract: "engineering",
      permission: "auto",
      sandbox: "workspace-write",
      activeTools: ["read", "exec_command", "write_stdin", "apply_patch"],
      toolsExplicit: false,
    });
    expect(parsed.piArgs).toContain("deepseek");
    expect(parsed.piArgs).toContain("max");
    expect(parsed.piArgs).not.toContain("--tools");
    expect(parsed.piArgs).toContain("inspect this repo");
  });

  it("selects the current Codex subscription model and a balanced default effort", () => {
    delete process.env.DSCODE_MODEL;
    delete process.env.DSCODE_EFFORT;
    const parsed = parseRuntimeArgs(["--provider", "openai-codex", "inspect this image"]);

    expect(parsed.options).toMatchObject({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(parsed.piArgs).toEqual(
      expect.arrayContaining([
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
        "--thinking",
        "medium",
      ]),
    );
  });

  it("uses the prompt contract environment default and lets the CLI override it", () => {
    process.env.DSCODE_PROMPT_CONTRACT = "none";

    expect(parseRuntimeArgs([]).options.promptContract).toBe("none");
    expect(parseRuntimeArgs(["--prompt-contract", "engineering"]).options.promptContract)
      .toBe("engineering");
  });

  it("selects OpenCode Zen Go with the default kimi-k2.6 model", () => {
    delete process.env.DSCODE_MODEL;
    delete process.env.DSCODE_EFFORT;
    const parsed = parseRuntimeArgs(["--provider", "opencode-go"]);
    expect(parsed.options).toMatchObject({
      providerId: "opencode-go",
      modelId: "kimi-k2.6",
    });
    expect(parsed.piArgs).toEqual(
      expect.arrayContaining([
        "--provider",
        "opencode-go",
        "--model",
        "kimi-k2.6",
        "--thinking",
        "medium",
      ]),
    );
  });

  it("accepts friendly Kimi and Grok provider aliases", () => {
    const kimi = parseRuntimeArgs(["--provider", "kimi"]);
    expect(kimi.options).toMatchObject({
      providerId: "kimi-coding",
      modelId: "kimi-for-coding",
    });
    const grok = parseRuntimeArgs(["--provider", "grok"]);
    expect(grok.options).toMatchObject({ providerId: "xai", modelId: "grok-4.5" });
  });

  it("maps DSCode flags while preserving Pi session and JSON flags", () => {
    const parsed = parseRuntimeArgs([
      "--harness",
      "safe",
      "--permission=ask",
      "--sandbox",
      "read-only",
      "--effort",
      "high",
      "--mode",
      "json",
      "--continue",
    ]);
    expect(parsed.options).toMatchObject({
      harness: "safe",
      permission: "ask",
      sandbox: "read-only",
      activeTools: ["read", "exec_command", "write_stdin", "apply_patch"],
    });
    expect(parsed.piArgs).toEqual(
      expect.arrayContaining(["--thinking", "high", "--mode", "json", "--continue"]),
    );
    expect(parsed.piArgs).not.toContain("--tools");
  });

  it("keeps an explicit tool selection in DSCode so late MCP tools can be registered", () => {
    const parsed = parseRuntimeArgs(["--tools", "read_file,mcp__fixture__echo", "inspect"]);
    expect(parsed.options.activeTools).toEqual(["read_file", "mcp__fixture__echo"]);
    expect(parsed.options.toolsExplicit).toBe(true);
    expect(parsed.piArgs).not.toContain("--tools");
  });

  it("maps YOLO mode to full access and one-run project trust", () => {
    const parsed = parseRuntimeArgs(["-y"]);
    expect(parsed.options.permission).toBe("full");
    expect(parsed.piArgs).toContain("--approve");

    const explicitlyUntrusted = parseRuntimeArgs(["-y", "--no-approve"]);
    expect(explicitlyUntrusted.options.permission).toBe("full");
    expect(explicitlyUntrusted.piArgs).toContain("--no-approve");
    expect(explicitlyUntrusted.piArgs).not.toContain("--approve");
  });

  it("makes --no-tools dominant regardless of argument order", () => {
    for (const args of [
      ["--no-tools", "--tools", "read,update_plan,mcp__fixture__echo"],
      ["--tools", "read", "--no-tools"],
    ]) {
      expect(parseRuntimeArgs(args).options).toMatchObject({ noTools: true, activeTools: [] });
    }
  });

  it("disables MCP independently and deduplicates selected tools", () => {
    const parsed = parseRuntimeArgs(["--tools", "read,read,mcp__fixture__echo", "--no-mcp"]);
    expect(parsed.options).toMatchObject({ noTools: false, noMcp: true, activeTools: ["read"] });
    expect(parsed.piArgs).not.toContain("--no-mcp");
    expect(parseRuntimeArgs([]).options).toMatchObject({ noTools: false, noMcp: false });
  });

  it("accepts version as a command without starting authentication", () => {
    expect(parseRuntimeArgs(["version"]).version).toBe(true);
    expect(parseRuntimeArgs(["--version"]).version).toBe(true);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
