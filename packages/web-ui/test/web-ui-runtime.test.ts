import { describe, expect, it } from "vitest";
import { parseRuntimeArgs } from "@aclisp/dsagent-core";
import { resolveWebUiRuntimeArgs } from "../src/web-ui-runtime.ts";

describe("Web UI runtime", () => {
  it.each([undefined, "", "   "])("uses the documented runtime defaults when RUNTIME_ARGS is %j", (value) => {
    expect(resolveWebUiRuntimeArgs(value)).toEqual([
      "--provider",
      "openrouter",
      "--model",
      "deepseek-v4.1-flash",
      "--permission",
      "auto",
      "--network",
      "--effort",
      "max",
    ]);
  });

  it("keeps the core's default tools available without an explicit tool selection", () => {
    expect(parseRuntimeArgs(resolveWebUiRuntimeArgs(undefined)).options.activeTools)
      .toEqual(["read", "exec_command", "write_stdin", "apply_patch", "codemode"]);
  });

  it("preserves an explicit RUNTIME_ARGS value", () => {
    expect(resolveWebUiRuntimeArgs("--provider openai --model test --tools read")).toEqual([
      "--provider",
      "openai",
      "--model",
      "test",
      "--tools",
      "read",
    ]);
  });
});
