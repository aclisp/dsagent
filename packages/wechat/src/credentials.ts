import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { httpsUrl } from "./api.ts";

export interface WeChatCredentials {
  accountId: string;
  ownerId: string;
  token: string;
  baseUrl: string;
  savedAt: string;
}

export function weChatDirectory(home: string): string {
  return path.join(home, "channels", "wechat");
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("WeChat private state directory must not be a symlink");
}

export function validateWeChatCredentials(value: unknown): WeChatCredentials {
  if (!value || typeof value !== "object") throw new Error("Invalid WeChat credentials; run dscode channels login wechat");
  const data = value as Record<string, unknown>;
  for (const field of ["accountId", "ownerId", "token", "baseUrl", "savedAt"]) {
    if (typeof data[field] !== "string" || !data[field].trim()) {
      throw new Error(`WeChat credentials missing ${field}; run dscode channels login wechat`);
    }
  }
  httpsUrl(data.baseUrl as string);
  return data as unknown as WeChatCredentials;
}

export function loadWeChatCredentials(home: string): WeChatCredentials | undefined {
  const file = path.join(weChatDirectory(home), "credentials.json");
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("WeChat credential file must be a regular file");
    return validateWeChatCredentials(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read WeChat credentials; check the private credential file or log in again", { cause: error });
  }
}

export function saveWeChatCredentials(home: string, credentials: WeChatCredentials): void {
  validateWeChatCredentials(credentials);
  const directory = weChatDirectory(home);
  ensurePrivateDirectory(directory);
  const target = path.join(directory, "credentials.json");
  const temporary = path.join(directory, `credentials.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(credentials) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}
