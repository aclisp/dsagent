import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDSCodeUiDefaults } from "../packages/core/src/ui-defaults.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("DSCode UI defaults", () => {
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
      theme: "light/dark",
      quietStartup: true,
      showHardwareCursor: true,
      dscodeUiDefaultsVersion: 1,
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
      theme: "light/dark",
      dscodeUiDefaultsVersion: 1,
    });
  });

  it("respects explicit preferences after the adaptive-theme migration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    const contents =
      '{"theme":"light","quietStartup":true,"showHardwareCursor":false,"dscodeUiDefaultsVersion":1}\n';
    await fs.writeFile(path.join(directory, "settings.json"), contents);
    await ensureDSCodeUiDefaults(directory);
    expect(await fs.readFile(path.join(directory, "settings.json"), "utf8")).toBe(contents);
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
      dscodeUiDefaultsVersion: 1,
    });
  });
});
