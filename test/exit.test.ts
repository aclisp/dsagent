import { describe, expect, it } from "vitest";
import { isNaturalExitInput } from "../packages/core/src/exit.js";

describe("natural terminal exit", () => {
  it.each(["quit", "QUIT", " exit ", "退出"])("recognizes %j as a local exit", (input) => {
    expect(isNaturalExitInput(input)).toBe(true);
  });

  it.each(["q", "quit now", "how do I exit vim?", "const quit = true"])(
    "keeps %j as a model prompt",
    (input) => {
      expect(isNaturalExitInput(input)).toBe(false);
    },
  );
});
