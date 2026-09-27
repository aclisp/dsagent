import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
} from "./settings.js";

export const effortSchema = z.enum(["low", "high", "max"]);
export type Effort = z.infer<typeof effortSchema>;
export const transportSchema = z.enum(["responses", "chat"]);
export type ModelTransport = z.infer<typeof transportSchema>;
export const permissionSchema = z.enum(["plan", "ask", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionSchema>;

export interface AppConfig {
  workspace: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  effort: Effort;
  transport: ModelTransport;
  permission: PermissionMode;
  resume: boolean;
  verbose: boolean;
}

export interface CliOptions {
  cwd?: string;
  baseUrl?: string;
  model?: string;
  effort?: string;
  transport?: string;
  permission?: string;
  yes?: boolean;
  resume?: boolean;
  verbose?: boolean;
}

export function loadConfig(options: CliOptions): AppConfig {
  const workspace = path.resolve(options.cwd ?? process.cwd());
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  const effort = effortSchema.parse(options.effort ?? process.env.DSCODE_EFFORT ?? "max");
  const transport = transportSchema.parse(
    options.transport ?? process.env.DSCODE_TRANSPORT ?? "responses",
  );
  const permission = options.yes
    ? "full"
    : permissionSchema.parse(options.permission ?? process.env.DSCODE_PERMISSION ?? "auto");

  return {
    workspace,
    apiKey,
    baseUrl: normalizeDeepSeekBaseUrl(
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        getStoredDeepSeekBaseUrl() ??
        DEFAULT_DEEPSEEK_BASE_URL,
    ),
    modelId: options.model ?? process.env.DSCODE_MODEL ?? "deepseek-flash",
    effort,
    transport,
    permission,
    resume: options.resume ?? true,
    verbose: options.verbose ?? false,
  };
}
