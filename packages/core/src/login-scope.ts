import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  isSupportedProviderId,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
} from "./providers.js";

export type DSCodeLoginRoute =
  | { action: "continue"; text: string }
  | { action: "provider"; providerId: SupportedProviderId; text: string }
  | { action: "reject" };

export function routeDSCodeLogin(
  text: string,
  defaultProvider: SupportedProviderId = "deepseek",
): DSCodeLoginRoute {
  const normalized = text.trim().toLocaleLowerCase("en-US");
  if (normalized === "/login") {
    return {
      action: "provider",
      providerId: defaultProvider,
      text: `/login ${defaultProvider}`,
    };
  }
  if (normalized.startsWith("/login ")) {
    const providerId = normalized.slice("/login ".length).trim();
    if (isSupportedProviderId(providerId)) {
      return { action: "provider", providerId, text: `/login ${providerId}` };
    }
    return { action: "reject" };
  }
  return { action: "continue", text };
}

export function scopeLoginSuggestions(text: string, items: AutocompleteItem[]): AutocompleteItem[] {
  const enteringProvider = /^\s*\/login\s+/i.test(text);
  if (enteringProvider) {
    return items
      .filter((item) => {
        const value = item.value.toLocaleLowerCase("en-US");
        const label = item.label.toLocaleLowerCase("en-US");
        return SUPPORTED_PROVIDER_IDS.some((providerId) => value === providerId || label === providerId);
      })
      .map((item) => ({
        ...item,
        description:
          item.value.toLocaleLowerCase("en-US") === "openai-codex"
            ? "ChatGPT plan"
            : "API key",
      }));
  }
  return items.map((item) =>
    item.value === "/login" || item.label === "/login" || item.label === "login"
      ? { ...item, description: "Configure DeepSeek, Codex, or OpenAI" }
      : item,
  );
}
