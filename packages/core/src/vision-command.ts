import { fileURLToPath } from "node:url";
import { classifyLiteralCommand } from "./literal-command.ts";
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

export function parseTrustedVisionCommand(command: string): TrustedVisionCommand | undefined {
  const result = classifyVisionCommand(command);
  return result.kind === "trusted" ? result.command : undefined;
}

export function classifyVisionCommand(command: string): VisionCommandClassification {
  const result = classifyLiteralCommand(command, "dscode-vision");
  if (result.kind !== "trusted") return result;
  const parsed = parseVisionArguments(result.command.args);
  return parsed.ok ? { kind: "trusted", command: { args: parsed.args } } : { kind: "invalid", reason: parsed.reason };
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
