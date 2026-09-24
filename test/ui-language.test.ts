import { describe, expect, it } from "vitest";
import {
  formatThinkingLabel,
  HIDDEN_THINKING_LABEL,
} from "../packages/core/src/tui-experience.js";

describe("DSCode runtime UI language", () => {
  it("uses English for the thinking labels", () => {
    expect(HIDDEN_THINKING_LABEL).toBe("DSCode is thinking");
    expect(formatThinkingLabel("DeepSeek V4 Flash")).toBe("DeepSeek V4 Flash is thinking");
    expect(formatThinkingLabel("GPT-5.6 Sol")).toBe("GPT-5.6 Sol is thinking");
  });
});
