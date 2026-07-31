import fs from "node:fs";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

export const SUPPORTED_PROVIDER_IDS = ["deepseek", "openai-codex", "openai"] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

const DEFAULT_MODELS: Record<SupportedProviderId, string> = {
  deepseek: "deepseek-v4-flash",
  "openai-codex": "gpt-5.6-sol",
  openai: "gpt-5.6-sol",
};

const DEFAULT_EFFORTS: Record<SupportedProviderId, string> = {
  deepseek: "max",
  "openai-codex": "medium",
  openai: "medium",
};

const PROVIDER_NAMES: Record<SupportedProviderId, string> = {
  deepseek: "DeepSeek",
  "openai-codex": "OpenAI Codex (ChatGPT plan)",
  openai: "OpenAI API",
};

export const MODEL_CREDENTIAL_ENV_KEYS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"] as const;

export interface StoredModelSelection {
  providerId: SupportedProviderId;
  modelId?: string;
}

export function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

export function parseSupportedProviderId(value: string): SupportedProviderId {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (isSupportedProviderId(normalized)) return normalized;
  throw new Error(
    `Unsupported provider "${value}". Choose ${SUPPORTED_PROVIDER_IDS.join(", ")}.`,
  );
}

export function defaultModelForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_MODELS[providerId];
}

export function defaultEffortForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_EFFORTS[providerId];
}

export function providerDisplayName(providerId: SupportedProviderId): string {
  return PROVIDER_NAMES[providerId];
}

export function providerEnvironmentKey(providerId: SupportedProviderId): string | undefined {
  if (providerId === "deepseek") return "DEEPSEEK_API_KEY";
  if (providerId === "openai") return "OPENAI_API_KEY";
  return undefined;
}

export function getStoredModelSelection(
  settingsPath = path.join(getDSCodeHome(), "settings.json"),
): StoredModelSelection | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof settings.defaultProvider !== "string") return undefined;
    const normalized = settings.defaultProvider.toLocaleLowerCase("en-US");
    if (!isSupportedProviderId(normalized)) return undefined;
    return {
      providerId: normalized,
      ...(typeof settings.defaultModel === "string" && settings.defaultModel.trim()
        ? { modelId: settings.defaultModel.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function stripModelCredentialEnvironment<T extends Record<string, string | undefined>>(
  environment: T,
): T {
  for (const name of MODEL_CREDENTIAL_ENV_KEYS) delete environment[name];
  return environment;
}
