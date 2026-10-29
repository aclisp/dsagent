import { describe, expect, it } from "vitest";
import {
  renderChatPage,
  resolveChatAgentName,
} from "../src/chat-page.ts";

describe("chat page identity", () => {
  it.each([undefined, "", "   "])("uses Steve Code when CHAT_AGENT_NAME is %j", (value) => {
    expect(resolveChatAgentName(value)).toBe("Steve Code");
  });

  it("trims a configured agent name", () => {
    expect(resolveChatAgentName("  小史  ")).toBe("小史");
  });

  it("injects an HTML-safe name into every placeholder", () => {
    const template = Buffer.from(
      '<title>{{CHAT_AGENT_NAME}}</title><meta content="{{CHAT_AGENT_NAME}}">',
    );

    expect(renderChatPage(template, '研发 <助手> & "伙伴"')).toBe(
      '<title>研发 &lt;助手&gt; &amp; &quot;伙伴&quot;</title>' +
        '<meta content="研发 &lt;助手&gt; &amp; &quot;伙伴&quot;">',
    );
  });
});
