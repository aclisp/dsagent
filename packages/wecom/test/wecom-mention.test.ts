import { describe, expect, it } from "vitest";
import { parseWeComBotMention } from "../src/wecom-mention.js";

describe("WeCom bot mention parsing", () => {
  it("matches an exact Chinese bot name anywhere before punctuation", () => {
    expect(
      parseWeComBotMention("你好@智能助理，帮我看看时间", "智能助理"),
    ).toEqual({
      matched: true,
      text: "你好，帮我看看时间",
    });
  });

  it("allows a directly adjacent @ but requires whitespace before following text", () => {
    expect(
      parseWeComBotMention("你好@智能助理 帮我看看时间", "智能助理"),
    ).toEqual({
      matched: true,
      text: "你好 帮我看看时间",
    });
    expect(
      parseWeComBotMention("你好@智能助理帮我看看时间", "智能助理"),
    ).toEqual({ matched: false, text: "" });
  });

  it("does not match a bot-name prefix", () => {
    expect(parseWeComBotMention("请@Steven 检查", "Steve")).toEqual({
      matched: false,
      text: "",
    });
  });

  it("removes a leading or middle mention and preserves surrounding text", () => {
    expect(parseWeComBotMention("@Steve 检查", "Steve")).toEqual({
      matched: true,
      text: "检查",
    });
    expect(parseWeComBotMention("请 @Steve 检查", "Steve")).toEqual({
      matched: true,
      text: "请 检查",
    });
  });

  it("does not match a blank bot name", () => {
    expect(parseWeComBotMention("@Steve 检查", " ")).toEqual({
      matched: false,
      text: "",
    });
  });
});
