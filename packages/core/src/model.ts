import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { AppConfig } from "./config.js";

export function createDeepSeekModels(config: AppConfig) {
  if (config.transport === "responses") {
    return createResponsesModels(config);
  }
  return createChatModels(config);
}

function createResponsesModels(config: AppConfig) {
  const model: Model<"openai-responses"> = {
    ...baseModel(config),
    api: "openai-responses",
    compat: {
      supportsDeveloperRole: true,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: true,
      sessionAffinityFormat: "openai-nosession",
    },
  };
  return registerModel(config, model, openAIResponsesApi());
}

function createChatModels(config: AppConfig) {
  const model: Model<"openai-completions"> = {
    ...baseModel(config),
    id: config.modelId,
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: config.baseUrl,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  };
  return registerModel(config, model, openAICompletionsApi());
}

function baseModel(config: AppConfig) {
  return {
    id: config.modelId,
    name: "DeepSeek V4 Flash",
    provider: "deepseek" as const,
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text"] as ["text"],
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    },
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
    },
  };
}

function registerModel<TApi extends "openai-completions" | "openai-responses">(
  config: AppConfig,
  model: Model<TApi>,
  api: ReturnType<typeof openAICompletionsApi>,
) {
  const provider = createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]),
    },
    models: [model],
    api,
  });

  const models = createModels();
  models.setProvider(provider);

  return { models, model };
}
