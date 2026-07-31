import { describe, expect, it } from "vitest";
import { EDITOR_PLACEHOLDER, HIDDEN_THINKING_LABEL } from "../src/tui-experience.js";

describe("DSCode runtime UI language", () => {
  it("uses English for the primary editor and thinking labels", () => {
    expect(EDITOR_PLACEHOLDER).toBe("Ask DSCode to change, explain, or test code");
    expect(HIDDEN_THINKING_LABEL).toBe("DeepSeek V4 Flash is thinking");
  });
});
