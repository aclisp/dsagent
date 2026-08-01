import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { codexStyleMarkdownTheme } from "../packages/core/src/pi-markdown.js";

const identity = (text: string): string => text;
const baseTheme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

describe("Codex-style Markdown code blocks", () => {
  it("parses fenced code without printing the Markdown fence markers", () => {
    const theme = codexStyleMarkdownTheme(baseTheme);
    const source = ["Run:", "", "```bash", "pnpm test", "```"].join("\n");
    const output = new Markdown(source, 0, 0, theme).render(60).join("\n");
    expect(output).toContain("pnpm test");
    expect(output).not.toContain("```");
  });

  it("does not mutate the shared Pi Markdown theme", () => {
    const themed = codexStyleMarkdownTheme(baseTheme);
    expect(themed).not.toBe(baseTheme);
    expect(baseTheme.codeBlockBorder("```bash")).toBe("```bash");
    expect(themed.codeBlockBorder("```bash")).toBe("");
  });
});
