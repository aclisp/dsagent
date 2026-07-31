import os from "node:os";
import path from "node:path";
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
  it("keeps the whale's spout, forked tail, eye, and lower fin in a compact square", () => {
    expect(DSCODE_LOGO).toEqual([
      "      ▀▄▀",
      "▄▄▄██████▄",
      " ███████ █",
      "█▀███████▀",
      "     ██",
    ]);
    expect(DSCODE_LOGO).toHaveLength(5);
    expect(Math.max(...DSCODE_LOGO.map((line) => visibleWidth(line)))).toBe(10);
  });

  it("renders a compact borderless header with the logo and product details", () => {
    const lines = renderWelcome(
      80,
      {
        cwd: path.join(os.homedir(), "code", "dscode"),
        modelId: "deepseek-v4-flash",
        effort: "max",
        version: "0.3.0",
      },
      theme,
    );
    const output = lines.join("\n");
    expect(output).toContain("DSCode v0.3.0");
    expect(output).toContain("███████ █");
    expect(output).not.toContain("< DS >");
    expect(output).toContain("DeepSeek V4 Flash · max effort");
    expect(output).toContain("~/code/dscode");
    expect(output).not.toMatch(/[╭╮╰╯│─]/u);
    expect(output).not.toContain("Welcome back");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(lines).toHaveLength(5);
    expect(lines[0]!.indexOf("DSCode v0.3.0")).toBeGreaterThan(0);
  });

  it("keeps the same compact logo in narrow terminals", () => {
    const lines = renderWelcome(
      30,
      {
        cwd: "/tmp/project",
        modelId: "deepseek-v4-flash",
        effort: "max",
        version: "0.3.0",
      },
      theme,
    );
    expect(lines.join("\n")).toContain("███████ █");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });

  it("shows the provider model display name when available", () => {
    const output = renderWelcome(
      80,
      {
        cwd: "/tmp/project",
        modelId: "gpt-5.6-sol",
        modelName: "GPT-5.6 Sol",
        effort: "medium",
        version: "0.3.3",
      },
      theme,
    ).join("\n");
    expect(output).toContain("GPT-5.6 Sol · medium effort");
  });

  it("keeps the header in the upper-left instead of centering it in wide terminals", () => {
    const lines = renderWelcome(
      132,
      {
        cwd: "/tmp/project",
        modelId: "deepseek-v4-flash",
        effort: "max",
        version: "9.8.7",
      },
      theme,
    );
    expect(lines[0]).toContain("DSCode v9.8.7");
    expect(lines[0]!.startsWith("  ")).toBe(true);
    expect(visibleWidth(lines[0]!)).toBeLessThan(50);
    expect(lines).toHaveLength(5);
  });
});
