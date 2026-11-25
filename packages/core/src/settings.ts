import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { lock } from "proper-lockfile";
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

type WebWorkspaceSettings = Partial<WebPreferences> & { id?: string };
type WebSettings = Partial<WebPreferences> & {
  workspaces?: Record<string, WebWorkspaceSettings>;
  workspaceIds?: Record<string, string>;
};

interface DSCodeSettings {
  web?: WebSettings;
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

export function getWebWorkspaceSettings(cwd: string, settingsPath = getDSCodeSettingsPath()) {
  const web = readSettingsSync(settingsPath).web;
  const global = readWebPreferences(web, "web");
  const key = fs.realpathSync(cwd);
  const record = webObject(webObject(web?.workspaces, "web.workspaces")[key], "web.workspaces entry");
  const legacyId = webObject(web?.workspaceIds, "web.workspaceIds")[key];
  const id: unknown = record.id === undefined ? legacyId : record.id;
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id))) {
    throw new Error("Stored Web workspace ID must be a 32-character base64url string");
  }
  return {
    global,
    workspace: readWebPreferences(record, "web.workspaces entry"),
    id,
    needsMigration: legacyId !== undefined,
  };
}

function readWebPreferences(value: unknown, name: string): Partial<WebPreferences> {
  const preferences = webObject(value, name);
  return {
    ...(preferences.host !== undefined ? { host: preferences.host } : {}),
    ...(preferences.port !== undefined ? { port: preferences.port } : {}),
    ...(preferences.url !== undefined ? { url: preferences.url } : {}),
  };
}

function webObject(value: unknown, name: string): Record<string, any> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

export async function saveWebWorkspaceSettings(
  workspace: { cwd: string; id: string; overrides: Partial<WebPreferences> },
  settingsPath = getDSCodeSettingsPath(),
): Promise<void> {
  const key = fs.realpathSync(workspace.cwd);
  await updateSettings(settingsPath, settings => {
    const { workspaces, workspaceIds, ...web } = webObject(settings.web, "web");
    const entries = webObject(workspaces, "web.workspaces");
    const ids = { ...webObject(workspaceIds, "web.workspaceIds") };
    const previous = webObject(entries[key], "web.workspaces entry");
    delete ids[key];
    settings.web = {
      ...web,
      workspaces: { ...entries, [key]: { ...previous, id: workspace.id, ...workspace.overrides } },
      ...(Object.keys(ids).length ? { workspaceIds: ids } : {}),
    };
  });
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
  await updateSettings(settingsPath, settings => {
    settings.deepseek = { ...settings.deepseek, baseUrl: normalized };
  });
  return normalized;
}

async function updateSettings(settingsPath: string, update: (settings: DSCodeSettings) => void): Promise<void> {
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  // Lock the whole read-modify-write, not just the atomic replacement.
  const file = path.join(await realpath(directory), path.basename(settingsPath));
  let compromised: Error | undefined;
  const release = await lock(file, {
    realpath: false,
    retries: { retries: 30, minTimeout: 25, maxTimeout: 100 },
    onCompromised: error => { compromised = error; },
  });
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const settings = await readSettings(file);
    update(settings);
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    if (compromised) throw compromised;
    await rename(temporaryPath, file);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    if (!compromised) await release();
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
