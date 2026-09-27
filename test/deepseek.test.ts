import { describe, expect, it } from "vitest";
import { optimizeDeepSeekResponsesPayload } from "../packages/core/src/deepseek.js";

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
    ) as Record<string, unknown>;

    expect(result.temperature).toBe(1);
    expect(result).not.toHaveProperty("prompt_cache_key");
    expect(result).not.toHaveProperty("include");
    expect(result.reasoning).toEqual({ effort: "max" });
    expect(result.tools).toEqual([
      { type: "custom", name: "apply_patch", description: "patch" },
    ]);
  });

  it.each(["none", "low", "high", "max"])(
    "preserves sampling controls for reasoning effort %s",
    (effort) => {
      const payload = { reasoning: { effort }, temperature: 0.7, top_p: 0.97 };
      expect(optimizeDeepSeekResponsesPayload(payload)).toEqual(payload);
    },
  );

  it("does not inject built-in tools or change function-tool protocols", () => {
    const tool = {
      type: "function",
      name: "apply_patch",
      parameters: { type: "object", properties: { input: { type: "string" } } },
    };
    expect(optimizeDeepSeekResponsesPayload({ tools: [tool] })).toEqual({ tools: [tool] });
    expect(optimizeDeepSeekResponsesPayload({ model: "deepseek-flash" })).toEqual({
      model: "deepseek-flash",
    });
  });

  it("cleans unsupported hints without mutating the original payload", () => {
    const payload = {
      prompt_cache_key: "session",
      prompt_cache_retention: "24h",
      prompt_cache_options: {},
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
      tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar" } }],
    };
    const original = structuredClone(payload);
    const result = optimizeDeepSeekResponsesPayload(payload) as Record<string, unknown>;
    for (const key of ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "include"]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(payload).toEqual(original);
  });
});
