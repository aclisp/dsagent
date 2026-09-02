import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_UI_RUNTIME_ARGS,
  enforceWebUiSubagentDepth,
  resolveWebUiRuntimeArgs,
  WEB_UI_SUBAGENT_DEPTH,
} from "../src/web-ui-runtime.js";

const originalDepth = process.env.DSCODE_SUBAGENT_DEPTH;

afterEach(() => {
  if (originalDepth === undefined) delete process.env.DSCODE_SUBAGENT_DEPTH;
  else process.env.DSCODE_SUBAGENT_DEPTH = originalDepth;
});

describe("Web UI runtime", () => {
  it("uses the local-development runtime defaults when RUNTIME_ARGS is absent", () => {
    expect(resolveWebUiRuntimeArgs(undefined)).toEqual([...DEFAULT_WEB_UI_RUNTIME_ARGS]);
    expect(resolveWebUiRuntimeArgs("   ")).toEqual([...DEFAULT_WEB_UI_RUNTIME_ARGS]);
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

  it("forces the subagent depth to one", () => {
    process.env.DSCODE_SUBAGENT_DEPTH = "0";

    enforceWebUiSubagentDepth();

    expect(WEB_UI_SUBAGENT_DEPTH).toBe(1);
    expect(process.env.DSCODE_SUBAGENT_DEPTH).toBe("1");
  });
});
