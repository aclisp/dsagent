import { describe, expect, it } from "vitest";
import { parseRuntimeArgs } from "@aclisp/dsagent-core";
import {
  DEFAULT_WEB_UI_RUNTIME_ARGS,
  resolveWebUiRuntimeArgs,
} from "../src/web-ui-runtime.ts";

describe("Web UI runtime", () => {
  it("uses the local-development runtime defaults when RUNTIME_ARGS is absent", () => {
    expect(resolveWebUiRuntimeArgs(undefined)).toEqual([...DEFAULT_WEB_UI_RUNTIME_ARGS]);
    expect(resolveWebUiRuntimeArgs("   ")).toEqual([...DEFAULT_WEB_UI_RUNTIME_ARGS]);
    expect(DEFAULT_WEB_UI_RUNTIME_ARGS).not.toContain("--tools");
    expect(parseRuntimeArgs(resolveWebUiRuntimeArgs(undefined)).options.activeTools)
      .toEqual(["read", "exec_command", "write_stdin", "apply_patch", "codemode", "tool_search"]);
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
