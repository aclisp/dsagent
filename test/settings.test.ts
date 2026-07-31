import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
} from "../packages/core/src/settings.js";

describe("DeepSeek API endpoint settings", () => {
  const temporaryDirectories: string[] = [];
  const originalConfigPath = process.env.DSCODE_CONFIG_PATH;
  const originalEnvironmentUrl = process.env.DEEPSEEK_BASE_URL;

  afterEach(async () => {
    restore("DSCODE_CONFIG_PATH", originalConfigPath);
    restore("DEEPSEEK_BASE_URL", originalEnvironmentUrl);
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it("normalizes and securely persists a compatible endpoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-settings-test-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "config.json");

    await expect(
      saveDeepSeekBaseUrl(" https://gateway.example.com/v1/// ", settingsPath),
    ).resolves.toBe("https://gateway.example.com/v1");
    expect(getStoredDeepSeekBaseUrl(settingsPath)).toBe("https://gateway.example.com/v1");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      deepseek: { baseUrl: "https://gateway.example.com/v1" },
    });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe or invalid endpoint values", () => {
    expect(() => normalizeDeepSeekBaseUrl("file:///tmp/api")).toThrow("http or https");
    expect(() => normalizeDeepSeekBaseUrl("https://user:secret@example.com/v1")).toThrow(
      "cannot contain credentials",
    );
    expect(() => normalizeDeepSeekBaseUrl("not a URL")).toThrow("valid http(s) URL");
  });

  it("resolves CLI, environment, saved, and official URLs in priority order", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-settings-priority-"));
    temporaryDirectories.push(directory);
    process.env.DSCODE_CONFIG_PATH = path.join(directory, "config.json");
    delete process.env.DEEPSEEK_BASE_URL;

    expect(parseRuntimeArgs([]).options.baseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    await saveDeepSeekBaseUrl("https://saved.example.com/v1");
    expect(parseRuntimeArgs([]).options.baseUrl).toBe("https://saved.example.com/v1");
    process.env.DEEPSEEK_BASE_URL = "https://environment.example.com/v1";
    expect(parseRuntimeArgs([]).options.baseUrl).toBe("https://environment.example.com/v1");
    expect(
      parseRuntimeArgs(["--base-url", "https://cli.example.com/v1"]).options.baseUrl,
    ).toBe("https://cli.example.com/v1");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
