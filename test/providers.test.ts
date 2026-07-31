import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  stripModelCredentialEnvironment,
} from "../src/providers.js";

describe("DSCode model providers", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("uses provider-appropriate model and effort defaults", () => {
    expect(defaultModelForProvider("deepseek")).toBe("deepseek-v4-flash");
    expect(defaultEffortForProvider("deepseek")).toBe("max");
    expect(defaultModelForProvider("openai-codex")).toBe("gpt-5.6-sol");
    expect(defaultEffortForProvider("openai-codex")).toBe("medium");
    expect(defaultModelForProvider("openai")).toBe("gpt-5.6-sol");
  });

  it("ships the default OpenAI models with image input support", () => {
    for (const providerId of ["openai-codex", "openai"] as const) {
      const model = getBuiltinModel(providerId, defaultModelForProvider(providerId));
      expect(model?.input).toContain("image");
      expect(model?.api).toContain("responses");
    }
  });

  it("exposes Codex subscription OAuth separately from OpenAI API-key auth", () => {
    expect(openaiCodexProvider().auth.oauth).toBeDefined();
    expect(openaiCodexProvider().auth.apiKey).toBeUndefined();
    expect(openaiProvider().auth.apiKey).toBeDefined();
  });

  it("reads a model selection saved by the TUI", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-provider-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra" }),
    );

    expect(getStoredModelSelection(settingsPath)).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-terra",
    });
  });

  it("removes every supported model credential from child environments", () => {
    const environment = stripModelCredentialEnvironment({
      PATH: "/bin",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
    });
    expect(environment).toEqual({ PATH: "/bin" });
  });
});
