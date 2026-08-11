import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_AGENT_NAME,
  renderChatPage,
  resolveChatAgentName,
} from "../src/chat-page.js";

describe("chat page identity", () => {
  it("uses Steve Code when CHAT_AGENT_NAME is empty", () => {
    expect(resolveChatAgentName(undefined)).toBe(DEFAULT_CHAT_AGENT_NAME);
    expect(resolveChatAgentName("   ")).toBe(DEFAULT_CHAT_AGENT_NAME);
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
