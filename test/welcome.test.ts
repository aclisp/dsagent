import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DSCODE_LOGO, renderWelcome } from "../src/welcome.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getColorMode: () => "256color",
} as unknown as Theme;

describe("DSCode welcome header", () => {
  it("keeps the supplied whale's spout, forked tail, eye, and lower fin at five rows", () => {
    expect(DSCODE_LOGO).toEqual([
      "      ▀▄▀",
      "▄▄▄███████▄",
      " ████████ █",
      "█▀▀███████▀",
      "     ██",
    ]);
    expect(DSCODE_LOGO).toHaveLength(5);
    expect(Math.max(...DSCODE_LOGO.map((line) => visibleWidth(line)))).toBe(11);
  });

  it("renders the block-whale logo in the branded welcome card", () => {
    const lines = renderWelcome(
      80,
      {
        cwd: "/Users/idoubi/code/dscode",
        modelId: "deepseek-v4-flash",
        effort: "max",
        username: "idoubi",
      },
      theme,
    );
    const output = lines.join("\n");
    expect(output).toContain("DSCode");
    expect(output).toContain("Welcome back, idoubi!");
    expect(output).toContain("████████ █");
    expect(output).not.toContain("< DS >");
    expect(output).toContain("DeepSeek V4 Flash (1M context)");
    expect(output).toContain("/status for usage");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("keeps the same compact logo in narrow terminals", () => {
    const lines = renderWelcome(
      30,
      {
        cwd: "/tmp/project",
        modelId: "deepseek-v4-flash",
        effort: "max",
        username: "dev",
      },
      theme,
    );
    expect(lines.join("\n")).toContain("████████ █");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });
});
