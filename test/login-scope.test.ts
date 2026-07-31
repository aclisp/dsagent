import { describe, expect, it } from "vitest";
import { routeDSCodeLogin, scopeLoginSuggestions } from "../src/login-scope.js";

describe("DSCode provider login", () => {
  it("routes bare login to the active provider", () => {
    expect(routeDSCodeLogin("/login")).toEqual({
      action: "provider",
      providerId: "deepseek",
      text: "/login deepseek",
    });
    expect(routeDSCodeLogin(" /LOGIN ", "openai-codex")).toEqual({
      action: "provider",
      providerId: "openai-codex",
      text: "/login openai-codex",
    });
  });

  it.each(["deepseek", "openai-codex", "openai"] as const)(
    "allows the supported %s provider",
    (providerId) => {
      expect(routeDSCodeLogin(`/login ${providerId}`)).toEqual({
        action: "provider",
        providerId,
        text: `/login ${providerId}`,
      });
    },
  );

  it("rejects other provider login commands without affecting ordinary prompts", () => {
    expect(routeDSCodeLogin("/login anthropic")).toEqual({ action: "reject" });
    expect(routeDSCodeLogin("explain /login anthropic")).toEqual({
      action: "continue",
      text: "explain /login anthropic",
    });
  });

  it("suggests the supported providers after /login", () => {
    const items = [
      { value: "anthropic", label: "anthropic", description: "API key" },
      { value: "deepseek", label: "deepseek", description: "API key" },
      { value: "openai-codex", label: "openai-codex", description: "OAuth" },
      { value: "openai", label: "openai", description: "API key" },
    ];
    expect(scopeLoginSuggestions("/login ", items)).toEqual([
      items[1],
      { ...items[2], description: "ChatGPT plan" },
      items[3],
    ]);
  });
});
