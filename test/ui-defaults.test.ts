import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDSCodeUiDefaults } from "../packages/core/src/ui-defaults.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("DSCode UI defaults", () => {
  it("migrates the previous adaptive default while retaining other preferences", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({
      theme: "light/dark",
      quietStartup: false,
      dscodeUiDefaultsVersion: 1,
    }));
    await ensureDSCodeUiDefaults(directory);
    const settings = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dscode-light/dscode-dark");
    expect(settings.quietStartup).toBe(false);
    expect(settings.dscodeUiDefaultsVersion).toBe(2);
    const migrated = await fs.readFile(path.join(directory, "settings.json"), "utf8");
    await ensureDSCodeUiDefaults(directory);
    expect(await fs.readFile(path.join(directory, "settings.json"), "utf8")).toBe(migrated);
  });

  it("migrates a persisted built-in theme to automatic light/dark mode once", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), '{"theme":"light"}\n');
    await ensureDSCodeUiDefaults(directory);
    const settings = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8")) as {
      theme: string;
      quietStartup: boolean;
      showHardwareCursor: boolean;
      dscodeUiDefaultsVersion: number;
    };
    expect(settings).toEqual({
      theme: "dscode-light/dscode-dark",
      quietStartup: true,
      showHardwareCursor: true,
      hideThinkingBlock: true,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "hidden",
      dscodeUiDefaultsVersion: 2,
    });
  });

  it("adds the blinking cursor default while respecting an explicit startup preference", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), '{"quietStartup":false}\n');
    await ensureDSCodeUiDefaults(directory);
    expect(JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"))).toEqual({
      quietStartup: false,
      showHardwareCursor: true,
      theme: "dscode-light/dscode-dark",
      hideThinkingBlock: true,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "hidden",
      dscodeUiDefaultsVersion: 2,
    });
  });

  it("respects explicit preferences after the adaptive-theme migration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    const contents = `${JSON.stringify({
      theme: "light",
      quietStartup: true,
      showHardwareCursor: false,
      hideThinkingBlock: false,
      tuiMode: "regular",
      fullscreenExitOutput: "resume-hint",
      fullscreenScrollbar: "always",
      dscodeUiDefaultsVersion: 2,
    })}\n`;
    await fs.writeFile(path.join(directory, "settings.json"), contents);
    await ensureDSCodeUiDefaults(directory);
    expect(await fs.readFile(path.join(directory, "settings.json"), "utf8")).toBe(contents);
  });

  it("adds TUI defaults to existing UI settings without rerunning migrations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({
      theme: "light",
      quietStartup: false,
      showHardwareCursor: false,
      dscodeUiDefaultsVersion: 1,
    }));
    await ensureDSCodeUiDefaults(directory);
    expect(JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"))).toEqual({
      theme: "light",
      quietStartup: false,
      showHardwareCursor: false,
      hideThinkingBlock: true,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "hidden",
      dscodeUiDefaultsVersion: 2,
    });
  });

  it("keeps custom themes while recording the migration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(
      path.join(directory, "settings.json"),
      '{"theme":"catppuccin","quietStartup":true,"showHardwareCursor":true}\n',
    );
    await ensureDSCodeUiDefaults(directory);
    expect(JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"))).toEqual({
      theme: "catppuccin",
      quietStartup: true,
      showHardwareCursor: true,
      hideThinkingBlock: true,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "hidden",
      dscodeUiDefaultsVersion: 2,
    });
  });
});
