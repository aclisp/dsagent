import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_VISION_CLI_EXECUTABLE = fileURLToPath(
  new URL("../../../dist/vision-cli.js", import.meta.url),
);

export interface TrustedVisionCommand {
  args: string[];
}

const VISION_ENVIRONMENT_KEYS = [
  "OPENROUTER_API_KEY",
  "DSCODE_VISION_MODEL",
  "DSCODE_HOME",
  "HOME",
  "PATH",
  "LANG",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

const UNSAFE_UNQUOTED_CHARACTERS = new Set([
  "&",
  "|",
  ";",
  "<",
  ">",
  "(",
  ")",
  "`",
  "$",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "#",
]);

export function parseTrustedVisionCommand(command: string): TrustedVisionCommand | undefined {
  const words = parseLiteralCommandWords(command);
  if (!words || words[0] !== "dscode-vision") return undefined;
  const args = words.slice(1);
  return hasValidVisionArguments(args) ? { args } : undefined;
}

export function createVisionProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  thinkingLevel: ThinkingLevel,
): NodeJS.ProcessEnv {
  const trusted: NodeJS.ProcessEnv = {};
  for (const key of VISION_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) trusted[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("LC_") && value !== undefined) trusted[key] = value;
  }
  trusted.DSCODE_VISION_THINKING = thinkingLevel;
  return trusted;
}

function parseLiteralCommandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let started = false;

  const pushCurrent = (): void => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\n" || character === "\r") return undefined;

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || (character === "$" && command[index + 1] === "(")) {
        return undefined;
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined || next === "\n" || next === "\r") return undefined;
        current += next;
        index += 1;
        continue;
      }
      current += character;
      continue;
    }

    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (UNSAFE_UNQUOTED_CHARACTERS.has(character)) return undefined;
    current += character;
    started = true;
  }

  if (quote !== undefined) return undefined;
  pushCurrent();
  return words;
}

function hasValidVisionArguments(args: readonly string[]): boolean {
  let imageSeen = false;
  let promptSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--image" && flag !== "--prompt") return false;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) return false;
    index += 1;
    if (flag === "--image") {
      if (imageSeen) return false;
      imageSeen = true;
    } else {
      if (promptSeen) return false;
      promptSeen = true;
    }
  }
  return imageSeen;
}
