import { describe, expect, it } from "vitest";
import { optimizeDeepSeekResponsesPayload } from "../src/deepseek.js";

describe("optimizeDeepSeekResponsesPayload", () => {
  it("uses DeepSeek's stateless Responses subset and freeform patch tool", () => {
    const result = optimizeDeepSeekResponsesPayload(
      {
        model: "deepseek-v4-flash",
        temperature: 1,
        prompt_cache_key: "ignored",
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "max", summary: "auto" },
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            description: "patch",
            format: { type: "grammar" },
          },
        ],
      },
      { webSearch: true },
    ) as Record<string, unknown>;

    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("prompt_cache_key");
    expect(result).not.toHaveProperty("include");
    expect(result.reasoning).toEqual({ effort: "max" });
    expect(result.tools).toEqual([
      { type: "custom", name: "apply_patch", description: "patch" },
      { type: "web_search" },
    ]);
  });
});
