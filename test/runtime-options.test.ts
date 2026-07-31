import { afterEach, describe, expect, it } from "vitest";
import { parseRuntimeArgs } from "../src/runtime-options.js";

describe("parseRuntimeArgs", () => {
  const original = {
    model: process.env.DSCODE_MODEL,
    effort: process.env.DSCODE_EFFORT,
    transport: process.env.DSCODE_TRANSPORT,
    harness: process.env.DSCODE_HARNESS,
    permission: process.env.DSCODE_PERMISSION,
    sandbox: process.env.DSCODE_SANDBOX,
  };

  afterEach(() => {
    restore("DSCODE_MODEL", original.model);
    restore("DSCODE_EFFORT", original.effort);
    restore("DSCODE_TRANSPORT", original.transport);
    restore("DSCODE_HARNESS", original.harness);
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
      modelId: "deepseek-v4-flash",
      transport: "responses",
      harness: "minimal",
      permission: "auto",
      sandbox: "workspace-write",
      activeTools: ["update_plan", "exec_command", "write_stdin", "apply_patch", "delegate"],
      toolsExplicit: false,
    });
    expect(parsed.piArgs).toContain("deepseek");
    expect(parsed.piArgs).toContain("max");
    expect(parsed.piArgs).not.toContain("--tools");
    expect(parsed.piArgs).toContain("inspect this repo");
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
      activeTools: [
        "update_plan",
        "read_file",
        "list_files",
        "search_files",
        "language_diagnostics",
        "exec_command",
        "write_stdin",
        "apply_patch",
        "delegate",
      ],
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
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
