import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";

const PROVIDER_ID = "deepseek";

interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

type AuthFile = Record<string, unknown>;

export type KeyValidation =
  | { status: "valid"; modelAvailable: boolean }
  | { status: "invalid"; message: string }
  | { status: "unverified"; message: string };

export function getDSCodeAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".dscode", "agent");
}

export function getDSCodeAuthPath(): string {
  return path.join(getDSCodeAgentDir(), "auth.json");
}

export async function hasStoredDeepSeekKey(authPath = getDSCodeAuthPath()): Promise<boolean> {
  const auth = await readAuthFile(authPath);
  const credential = auth[PROVIDER_ID];
  return isApiKeyCredential(credential) && credential.key.trim().length > 0;
}

export function hasDeepSeekEnvironmentKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function saveDeepSeekKey(
  key: string,
  authPath = getDSCodeAuthPath(),
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("DeepSeek API key cannot be empty");
  const auth = await readAuthFile(authPath);
  auth[PROVIDER_ID] = { type: "api_key", key: trimmed } satisfies ApiKeyCredential;
  await writeAuthFile(authPath, auth);
}

export async function removeStoredDeepSeekKey(
  authPath = getDSCodeAuthPath(),
): Promise<boolean> {
  const auth = await readAuthFile(authPath);
  if (!(PROVIDER_ID in auth)) return false;
  delete auth[PROVIDER_ID];
  await writeAuthFile(authPath, auth);
  return true;
}

export async function validateDeepSeekKey(
  key: string,
  baseUrl: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key.trim()}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", message: `DeepSeek rejected the key (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return {
        status: "unverified",
        message: `DeepSeek validation returned HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as unknown;
    const modelAvailable =
      isRecord(body) &&
      Array.isArray(body.data) &&
      body.data.some((model) => isRecord(model) && model.id === modelId);
    return { status: "valid", modelAvailable };
  } catch (error) {
    return {
      status: "unverified",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isInteractiveInvocation(piArgs: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (piArgs.includes("--print") || piArgs.includes("-p")) return false;
  const mode = optionValue(piArgs, "--mode");
  return mode === undefined || mode === "tui" || mode === "interactive";
}

export function usesDeepSeekProvider(piArgs: string[]): boolean {
  return (optionValue(piArgs, "--provider") ?? PROVIDER_ID) === PROVIDER_ID;
}

export async function ensureFirstRunAuth(options: {
  baseUrl: string;
  modelId: string;
  piArgs: string[];
}): Promise<void> {
  if (!usesDeepSeekProvider(options.piArgs)) return;
  if (hasDeepSeekEnvironmentKey() || (await hasStoredDeepSeekKey())) return;
  if (!isInteractiveInvocation(options.piArgs)) {
    throw new Error(
      "DeepSeek API key is not configured. Run `dscode login` or set DEEPSEEK_API_KEY.",
    );
  }

  process.stdout.write(
    [
      "",
      pc.bold(pc.cyan("Welcome to DSCode")),
      pc.dim("Local-first coding with DeepSeek V4 Flash"),
      "",
      "Configure your DeepSeek API key to continue.",
      pc.dim("The key is masked, validated, and stored locally with mode 0600."),
      "",
    ].join("\n"),
  );
  await promptAndStoreKey(options.baseUrl, options.modelId);
}

export async function runAuthCommand(
  command: "login" | "logout" | "status",
  options: { baseUrl: string; modelId: string },
): Promise<void> {
  if (command === "logout") {
    const removed = await removeStoredDeepSeekKey();
    process.stdout.write(
      removed
        ? `${pc.green("✓")} Removed the stored DeepSeek credential.\n`
        : "No stored DeepSeek credential was found.\n",
    );
    if (hasDeepSeekEnvironmentKey()) {
      process.stdout.write(
        `${pc.yellow("!")} DEEPSEEK_API_KEY is still set in this environment.\n`,
      );
    }
    return;
  }
  if (command === "status") {
    const stored = await hasStoredDeepSeekKey();
    const environment = hasDeepSeekEnvironmentKey();
    process.stdout.write(
      [
        `DeepSeek authentication: ${stored || environment ? pc.green("configured") : pc.yellow("not configured")}`,
        `  stored credential: ${stored ? "yes" : "no"}`,
        `  DEEPSEEK_API_KEY: ${environment ? "set" : "not set"}`,
        `  auth file: ${getDSCodeAuthPath()}`,
      ].join("\n") + "\n",
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`dscode login` requires an interactive terminal");
  }
  await promptAndStoreKey(options.baseUrl, options.modelId);
}

async function promptAndStoreKey(baseUrl: string, modelId: string): Promise<void> {
  while (true) {
    const key = await readSecret("DeepSeek API key: ");
    if (!key.trim()) throw new Error("API key setup cancelled");
    process.stdout.write(pc.dim("Validating with DeepSeek… "));
    const validation = await validateDeepSeekKey(key, baseUrl, modelId);
    if (validation.status === "invalid") {
      process.stdout.write(`${pc.red("failed")}\n${pc.red(validation.message)}. Try again.\n`);
      continue;
    }
    if (validation.status === "unverified") {
      process.stdout.write(`${pc.yellow("could not verify")}\n`);
      process.stdout.write(`${pc.dim(validation.message)}\n`);
      const save = await confirmLine("Save this key anyway? [y/N] ");
      if (!save) continue;
    } else {
      process.stdout.write(`${pc.green("verified")}\n`);
      if (!validation.modelAvailable) {
        process.stdout.write(
          `${pc.yellow("!")} The key works, but ${modelId} was not returned by /models.\n`,
        );
      }
    }
    await saveDeepSeekKey(key);
    process.stdout.write(`${pc.green("✓")} API key saved securely. Start coding with ${pc.bold("dscode")}.\n`);
    return;
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("A TTY is required for secret input");
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let value = "";
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error): void => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const data = chunk
        .toString()
        .replaceAll("\u001b[200~", "")
        .replaceAll("\u001b[201~", "")
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
      if (data === "\u0003") {
        finish(new Error("API key setup cancelled"));
        return;
      }
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u001b") {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function confirmLine(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/i.test((await readline.question(prompt)).trim());
  } finally {
    readline.close();
  }
}

async function readAuthFile(authPath: string): Promise<AuthFile> {
  try {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode auth file: ${authPath}`);
    }
    throw error;
  }
}

async function writeAuthFile(authPath: string, auth: AuthFile): Promise<void> {
  const directory = path.dirname(authPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, authPath);
    await chmod(authPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
  return isRecord(value) && value.type === "api_key" && typeof value.key === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
