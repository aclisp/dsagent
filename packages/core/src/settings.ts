import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getDSCodeHome } from "./home.ts";
import { isStandalone } from "./distribution.ts";
import type { WebPreferences } from "./web-continuation.ts";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_WEB_SNAPSHOT_RETENTION_DAYS = 30;

export type CredentialStoreMode = "file" | "keyring" | "auto";
export type HistoryPersistence = "save-all" | "none";

export interface DSCodeStorageSettings {
  credentialStore: CredentialStoreMode;
  historyPersistence: HistoryPersistence;
  sqliteHome?: string;
}

interface DSCodeSettings {
  web?: Partial<WebPreferences> & { workspaceIds?: Record<string, string> };
  deepseek?: {
    baseUrl?: unknown;
  };
  /** Matches Codex's config key so the storage policy is recognizable across clients. */
  cli_auth_credentials_store?: unknown;
  /** Directory containing DSCode's SQLite runtime state. Defaults to DSCODE_HOME. */
  sqlite_home?: unknown;
  history?: {
    persistence?: unknown;
  };
  web_snapshots?: {
    retention_days?: unknown;
  };
}

export function getDSCodeSettingsPath(): string {
  return process.env.DSCODE_CONFIG_PATH ?? path.join(getDSCodeHome(), "config.json");
}

export function getStoredWebPreferences(settingsPath = getDSCodeSettingsPath()): Partial<WebPreferences> {
  const value = readSettingsSync(settingsPath).web;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("web preferences must be an object");
  return {
    ...(value.host !== undefined ? { host: value.host } : {}),
    ...(value.port !== undefined ? { port: value.port } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
  };
}

export function getStoredWebWorkspaceId(cwd: string, settingsPath = getDSCodeSettingsPath()): string | undefined {
  const value = readSettingsSync(settingsPath).web?.workspaceIds;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("web.workspaceIds must be an object");
  const id = value[fs.realpathSync(cwd)];
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id))) {
    throw new Error("Stored Web workspace ID must be a 32-character base64url string");
  }
  return id;
}

export async function saveWebPreferences(
  preferences: WebPreferences,
  workspace?: { cwd: string; id: string },
  settingsPath = getDSCodeSettingsPath(),
): Promise<void> {
  const settings = await readSettings(settingsPath);
  settings.web = { ...settings.web, ...preferences };
  if (preferences.url === undefined) delete settings.web.url;
  if (workspace) {
    settings.web.workspaceIds = { ...settings.web.workspaceIds, [fs.realpathSync(workspace.cwd)]: workspace.id };
  }
  await writeSettings(settings, settingsPath);
}

export function getWebSnapshotRetentionDays(settingsPath = getDSCodeSettingsPath()): number {
  const value = readSettingsSync(settingsPath).web_snapshots?.retention_days ?? DEFAULT_WEB_SNAPSHOT_RETENTION_DAYS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("web_snapshots.retention_days must be a non-negative integer (0 disables cleanup)");
  }
  return value;
}

export function getStoredDeepSeekBaseUrl(
  settingsPath = getDSCodeSettingsPath(),
): string | undefined {
  try {
    return baseUrlFromSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode settings file: ${settingsPath}`);
    }
    throw error;
  }
}

export function getDSCodeStorageSettings(
  settingsPath = getDSCodeSettingsPath(),
): DSCodeStorageSettings {
  const settings = readSettingsSync(settingsPath);
  const configuredStore = settings.cli_auth_credentials_store;
  const environmentStore = process.env.DSCODE_CREDENTIALS_STORE;
  const credentialStore = isStandalone ? "file" : parseCredentialStoreMode(environmentStore ?? configuredStore ?? "auto");
  const historyPersistence = parseHistoryPersistence(settings.history?.persistence ?? "save-all");
  const sqliteHome = process.env.DSCODE_SQLITE_HOME ?? settings.sqlite_home;
  return {
    credentialStore,
    historyPersistence,
    ...(typeof sqliteHome === "string" && sqliteHome.trim()
      ? { sqliteHome: resolveConfiguredPath(sqliteHome) }
      : {}),
  };
}

export function parseCredentialStoreMode(value: unknown): CredentialStoreMode {
  if (value === "file" || value === "keyring" || value === "auto") return value;
  throw new Error("cli_auth_credentials_store must be file, keyring, or auto");
}

export function parseHistoryPersistence(value: unknown): HistoryPersistence {
  if (value === "save-all" || value === "none") return value;
  throw new Error("history.persistence must be save-all or none");
}

export async function saveDeepSeekBaseUrl(
  baseUrl: string,
  settingsPath = getDSCodeSettingsPath(),
): Promise<string> {
  const normalized = normalizeDeepSeekBaseUrl(baseUrl);
  const settings = await readSettings(settingsPath);
  settings.deepseek = { ...(settings.deepseek ?? {}), baseUrl: normalized };
  await writeSettings(settings, settingsPath);
  return normalized;
}

async function writeSettings(settings: DSCodeSettings, settingsPath: string): Promise<void> {
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function normalizeDeepSeekBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("API base URL cannot be empty");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("API base URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("API base URL cannot contain credentials, query parameters, or a fragment");
  }
  return trimmed;
}

async function readSettings(settingsPath: string): Promise<DSCodeSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode settings file: ${settingsPath}`);
    }
    throw error;
  }
}

function readSettingsSync(settingsPath: string): DSCodeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode settings file: ${settingsPath}`);
    }
    throw error;
  }
}

function resolveConfiguredPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return process.env.HOME ?? getDSCodeHome();
  if (trimmed.startsWith("~/")) {
    return path.resolve(process.env.HOME ?? path.dirname(getDSCodeHome()), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function baseUrlFromSettings(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.deepseek)) return undefined;
  const baseUrl = value.deepseek.baseUrl;
  return typeof baseUrl === "string" ? normalizeDeepSeekBaseUrl(baseUrl) : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
