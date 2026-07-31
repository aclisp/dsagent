import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type DSCodeLoginRoute =
  | { action: "continue"; text: string }
  | { action: "deepseek"; text: "/login deepseek" }
  | { action: "reject" };

export function routeDSCodeLogin(text: string): DSCodeLoginRoute {
  const normalized = text.trim().toLocaleLowerCase("en-US");
  if (normalized === "/login" || normalized === "/login deepseek") {
    return { action: "deepseek", text: "/login deepseek" };
  }
  if (normalized.startsWith("/login ")) return { action: "reject" };
  return { action: "continue", text };
}

export function scopeLoginSuggestions(text: string, items: AutocompleteItem[]): AutocompleteItem[] {
  const enteringProvider = /^\s*\/login\s+/i.test(text);
  if (enteringProvider) {
    return items.filter(
      (item) => item.value.toLocaleLowerCase("en-US") === "deepseek" || item.label.toLocaleLowerCase("en-US") === "deepseek",
    );
  }
  return items.map((item) =>
    item.value === "/login" || item.label === "/login" || item.label === "login"
      ? { ...item, description: "Configure the DeepSeek API key" }
      : item,
  );
}
