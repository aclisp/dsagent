import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_VISION_CLI_EXECUTABLE = fileURLToPath(
  new URL("../../../dist/vision-cli.js", import.meta.url),
);

export interface TrustedVisionCommand {
  args: string[];
}

export type VisionCommandClassification =
  | { kind: "other" }
  | { kind: "invalid"; reason: string }
  | { kind: "trusted"; command: TrustedVisionCommand };

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
  const result = classifyVisionCommand(command);
  return result.kind === "trusted" ? result.command : undefined;
}

export function classifyVisionCommand(command: string): VisionCommandClassification {
  if (!/^\s*dscode-vision(?=$|\s|[;&|<>])/.test(command)) {
    if (containsChainedVisionCommand(command)) {
      return {
        kind: "invalid",
        reason: "dscode-vision must be invoked directly without cd or command chaining",
      };
    }
    return { kind: "other" };
  }

  const parsedWords = parseLiteralCommandWords(command);
  if (!parsedWords.ok) return { kind: "invalid", reason: parsedWords.reason };
  if (parsedWords.words[0] !== "dscode-vision") {
    return { kind: "invalid", reason: "the executable must be exactly dscode-vision" };
  }

  const parsedArguments = parseVisionArguments(parsedWords.words.slice(1));
  if (!parsedArguments.ok) {
    return { kind: "invalid", reason: parsedArguments.reason };
  }
  return { kind: "trusted", command: { args: parsedArguments.args } };
}

function containsChainedVisionCommand(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      if (character === "\\" && quote === '"') index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (!";&|()\n\r".includes(character)) continue;

    let commandStart = index + 1;
    while (/\s|[;&|()]/.test(command[commandStart] ?? "")) commandStart += 1;
    if (/^dscode-vision(?=$|\s|[;&|<>])/.test(command.slice(commandStart))) return true;
  }
  return false;
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

function parseLiteralCommandWords(
  command: string,
): { ok: true; words: string[] } | { ok: false; reason: string } {
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
    if (character === "\n" || character === "\r") {
      return { ok: false, reason: "the command must be one physical line" };
    }

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
        return { ok: false, reason: "command substitution is not allowed" };
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          return { ok: false, reason: "the command cannot end with an escape" };
        }
        if (next === "\n" || next === "\r") {
          return { ok: false, reason: "the command must be one physical line" };
        }
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
      if (next === undefined) {
        return { ok: false, reason: "the command cannot end with an escape" };
      }
      if (next === "\n" || next === "\r") {
        return { ok: false, reason: "the command must be one physical line" };
      }
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (UNSAFE_UNQUOTED_CHARACTERS.has(character)) {
      const reason = "&|;<>()".includes(character)
        ? "shell operators are not allowed"
        : "unquoted shell expansion characters are not allowed";
      return { ok: false, reason };
    }
    current += character;
    started = true;
  }

  if (quote !== undefined) return { ok: false, reason: `unterminated ${quote} quote` };
  pushCurrent();
  return { ok: true, words };
}

function parseVisionArguments(
  args: readonly string[],
): { ok: true; args: string[] } | { ok: false; reason: string } {
  let imageSeen = false;
  let promptSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--image" && flag !== "--prompt") {
      return { ok: false, reason: "only --image and --prompt are allowed" };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) {
      return { ok: false, reason: `${flag} requires a non-empty value` };
    }
    index += 1;
    if (flag === "--image") {
      if (imageSeen) return { ok: false, reason: "--image may only be provided once" };
      imageSeen = true;
    } else {
      if (promptSeen) return { ok: false, reason: "--prompt may only be provided once" };
      promptSeen = true;
    }
  }
  if (!imageSeen) return { ok: false, reason: "--image is required" };
  return { ok: true, args: [...args] };
}
