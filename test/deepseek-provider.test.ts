import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { optimizeDeepSeekResponsesPayload } from "../packages/core/src/deepseek.ts";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.ts";

describe("DeepSeek provider registration", () => {
  it("keeps Flash and Pro available when another provider is active", async () => {
    const { models: registeredModels } = await registerDeepSeek();

    expect(registeredModels?.map((model) => model.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);
    expect(registeredModels?.map((model) => model.name)).toEqual([
      "DeepSeek Flash",
      "DeepSeek V4 Pro",
    ]);
  });

  describe.each(["deepseek-flash", "deepseek-v4-pro"])("%s Responses requests", (modelId) => {
    it.each([
      ["off", "none"],
      ["minimal", "low"],
      ["low", "low"],
      ["high", "high"],
      ["max", "max"],
    ] as const)("preserves system instructions and maps %s effort to %s", async (effort, expectedEffort) => {
      const registration = await registerDeepSeek();
      const registeredModel = registration.models?.find((model) => model.id === modelId);
      expect(registeredModel).toBeDefined();
      const model = {
        ...registeredModel,
        provider: "deepseek",
        baseUrl: registration.baseUrl,
      } as Model<"openai-responses">;
      const context = normalizeContext({
        systemPrompt: "Follow the DSCode system instructions.",
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      });
      const thinkingLevel = clampThinkingLevel(model, effort);
      expect(thinkingLevel).toBe(effort);
      let payload: unknown;
      const result = await streamSimple(model, context, {
        apiKey: "test-only-key",
        // Pi's agent omits reasoning when the selected thinking level is off.
        ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
        onPayload(value) {
          payload = optimizeDeepSeekResponsesPayload(value);
          throw new Error("Captured before network request");
        },
      }).result();

      expect(result.errorMessage).toBe("Captured before network request");
      expect(payload).toMatchObject({
        input: [
          { role: "system", content: "Follow the DSCode system instructions." },
          { role: "user" },
        ],
        reasoning: { effort: expectedEffort },
      });
    });
  });
});

async function registerDeepSeek(): Promise<ProviderConfig> {
  let registration: ProviderConfig | undefined;
  const pi = new Proxy(
    {
      registerProvider(name: string, config: ProviderConfig) {
        if (name === "deepseek") registration = config;
      },
      getActiveTools: () => [],
      setActiveTools: () => undefined,
      getThinkingLevel: () => "medium",
    },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return () => undefined;
      },
    },
  ) as unknown as ExtensionAPI;

  await runExtensionFactory(options(), pi);
  if (!registration) throw new Error("DeepSeek provider was not registered");
  return registration;
}

function options(): DSCodeRuntimeOptions {
  return {
    cwd: process.cwd(),
    providerId: "anthropic",
    baseUrl: "https://api.deepseek.com",
    modelId: "claude-opus-4-8",
    transport: "responses",
    promptContract: "engineering",
    permission: "auto",
    sandbox: "workspace-write",
    network: false,
    activeTools: ["exec_command", "write_stdin", "apply_patch"],
    toolsExplicit: false,
    noTools: false,
    noMcp: false,
  };
}

function runExtensionFactory(
  extensionOptions: DSCodeRuntimeOptions,
  pi: ExtensionAPI,
): void | Promise<void> {
  const extension = createDSCodeExtension(extensionOptions);
  return typeof extension === "function" ? extension(pi) : extension.factory(pi);
}
