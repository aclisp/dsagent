import { describe, expect, it } from "vitest";
import { redactWeComPrivateUrls } from "../src/wecom-url-redaction.js";

const workspaceId = "k9x7q2m4v8w1z5t3";
const replacement = "[私密链接已隐藏]";

describe("redactWeComPrivateUrls", () => {
  it("redacts absolute, protocol-relative, and relative private routes", () => {
    const text = [
      `https://example.com/chat/${workspaceId}`,
      `//example.com/debug/${workspaceId}?source=wecom`,
      `/share/${workspaceId}/uploads/report.pdf`,
      `example.com/chat/${workspaceId}`,
    ].join(" | ");

    expect(redactWeComPrivateUrls(text)).toBe(
      `${replacement} | ${replacement} | ${replacement} | ${replacement}`,
    );
  });

  it("redacts Markdown destinations and URL-encoded private routes", () => {
    const encoded = encodeURIComponent(
      `https://example.com/share/${workspaceId}/uploads/result.pdf`,
    );
    const text = `[下载](https://example.com/chat/${workspaceId}) ${encoded}`;

    expect(redactWeComPrivateUrls(text)).toBe(
      `[下载](${replacement}) ${replacement}`,
    );
  });

  it("redacts workspace query URLs and nested redirect targets", () => {
    const text = [
      `https://example.com/v1/sessions?workspaceId=${workspaceId}`,
      `https://example.com/redirect?next=%2Fshare%2F${workspaceId}%2Fresult.pdf`,
    ].join(" | ");

    expect(redactWeComPrivateUrls(text)).toBe(
      `${replacement} | ${replacement}`,
    );
  });

  it("preserves ordinary URLs and short non-workspace route names", () => {
    const text =
      "https://example.com/chat/help /share/public/report.pdf https://example.com/?workspaceId=demo";

    expect(redactWeComPrivateUrls(text)).toBe(text);
  });

  it("keeps surrounding punctuation while removing the private URL", () => {
    expect(
      redactWeComPrivateUrls(`结果见：https://example.com/share/${workspaceId}。`),
    ).toBe(`结果见：${replacement}。`);
  });
});
