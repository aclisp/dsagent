import { describe, expect, it } from "vitest";
import { routeDSCodeLogin, scopeLoginSuggestions } from "../src/login-scope.js";

describe("DeepSeek-only TUI login", () => {
  it.each(["/login", "/LOGIN", " /login deepseek "])(
    "routes %j directly to DeepSeek API-key login",
    (input) => {
      expect(routeDSCodeLogin(input)).toEqual({ action: "deepseek", text: "/login deepseek" });
    },
  );

  it("rejects other provider login commands without affecting ordinary prompts", () => {
    expect(routeDSCodeLogin("/login anthropic")).toEqual({ action: "reject" });
    expect(routeDSCodeLogin("explain /login anthropic")).toEqual({
      action: "continue",
      text: "explain /login anthropic",
    });
  });

  it("only suggests DeepSeek after /login", () => {
    const items = [
      { value: "anthropic", label: "anthropic", description: "API key" },
      { value: "deepseek", label: "deepseek", description: "API key" },
    ];
    expect(scopeLoginSuggestions("/login ", items)).toEqual([items[1]]);
  });
});
