import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getDSCodeThemePaths } from "../packages/core/src/themes.ts";

// SHA-256 of JSON.stringify({ vars, colors, export }) from Pi's v0.87.1 theme files.
const originalPalettes = [
  ["light", "191e20d68e3ec9d9cac5c71e751bda443cea97b12313936e15b3686ee324530a"],
  ["dark", "69430367c86c246978ba94f610caaed2a826cb30f24f88b99c1a61c2e557b044"],
] as const;

describe("DSCode themes", () => {
  it("preserves every Pi 0.87.1 palette value", async () => {
    for (const [index, [appearance, checksum]] of originalPalettes.entries()) {
      const json = JSON.parse(await fs.readFile(getDSCodeThemePaths()[index]!, "utf8"));
      expect(json.name).toBe(`dscode-${appearance}`);
      const palette = JSON.stringify({ vars: json.vars, colors: json.colors, export: json.export });
      expect(createHash("sha256").update(palette).digest("hex")).toBe(checksum);
    }
  });

  it("loads both palettes through Pi's theme resource loader", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-themes-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory(),
        additionalThemePaths: getDSCodeThemePaths(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
      });
      await loader.reload();
      const result = loader.getThemes();
      expect(result.diagnostics).toEqual([]);
      expect(result.themes.map((theme) => [theme.name, theme.appearance])).toEqual([
        ["dscode-light", "light"],
        ["dscode-dark", "dark"],
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
