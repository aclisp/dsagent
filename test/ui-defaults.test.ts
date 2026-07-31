import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDSCodeUiDefaults } from "../src/ui-defaults.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("DSCode UI defaults", () => {
  it("enables a clean startup without replacing existing settings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), '{"theme":"light"}\n');
    await ensureDSCodeUiDefaults(directory);
    const settings = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8")) as {
      theme: string;
      quietStartup: boolean;
    };
    expect(settings).toEqual({ theme: "light", quietStartup: true });
  });

  it("respects an explicit verbose startup preference", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-ui-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "settings.json"), '{"quietStartup":false}\n');
    await ensureDSCodeUiDefaults(directory);
    expect(await fs.readFile(path.join(directory, "settings.json"), "utf8")).toBe(
      '{"quietStartup":false}\n',
    );
  });
});
