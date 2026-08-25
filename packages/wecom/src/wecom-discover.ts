import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  WSClient,
  type Logger,
  type WSClientOptions,
} from "@wecom/aibot-node-sdk";
import type {
  WeComMessageBody,
  WeComMessageFrame,
} from "./wecom-chat-provider.js";
import { parseWeComBotMention } from "./wecom-mention.js";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5 * 60 * 1000;

type EventListener = (...args: unknown[]) => void;

export interface WeComDiscoveryClient {
  on(event: string, listener: EventListener): this;
  off(event: string, listener: EventListener): this;
  connect(): unknown;
  disconnect(): void;
}

export type WeComDiscoveryClientFactory = (
  options: WSClientOptions,
) => WeComDiscoveryClient;

export type WeComDiscoveryEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface WeComDiscoveryOptions {
  botId: string;
  secret: string;
  botName: string;
  wsUrl?: string;
  timeoutMs?: number;
  clientFactory?: WeComDiscoveryClientFactory;
}

export interface WeComDiscoveryIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface RunWeComDiscoverOptions {
  env?: WeComDiscoveryEnvironment;
  io?: WeComDiscoveryIo;
  clientFactory?: WeComDiscoveryClientFactory;
}

interface ParsedArguments {
  help: boolean;
  timeoutMs: number;
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const defaultClientFactory: WeComDiscoveryClientFactory = (options) =>
  new WSClient(options) as unknown as WeComDiscoveryClient;

const defaultIo: WeComDiscoveryIo = {
  stdout(message) {
    process.stdout.write(`${message}\n`);
  },
  stderr(message) {
    process.stderr.write(`${message}\n`);
  },
};

function envValue(
  env: WeComDiscoveryEnvironment,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function nonBlankText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Return the group chat ID from a text message containing the exact bot mention.
 * Discovery intentionally does not return the message content or sender.
 */
export function extractWeComGroupChatId(
  frame: WeComMessageFrame,
  options: Pick<WeComDiscoveryOptions, "botId" | "botName">,
): string | undefined {
  const botId = options.botId.trim();
  const botName = options.botName.trim();
  if (botId.length === 0) return undefined;
  if (botName.length === 0) return undefined;
  if (nonBlankText(frame.headers?.req_id) === undefined) return undefined;
  const body = frame.body;
  if (!body || body.msgtype !== "text") return undefined;
  if (body.aibotid !== botId || body.chattype !== "group") {
    return undefined;
  }
  if (body.quote !== undefined) return undefined;

  const chatId = nonBlankText(body.chatid);
  const messageId = nonBlankText(body.msgid);
  const senderId = nonBlankText(body.from?.userid);
  const content = nonBlankText(body.text?.content);
  if (
    chatId === undefined ||
    messageId === undefined ||
    senderId === undefined ||
    content === undefined
  ) {
    return undefined;
  }
  if (/[\r\n]/u.test(chatId)) return undefined;
  if (senderId === botId || senderId === body.aibotid) {
    return undefined;
  }

  if (!parseWeComBotMention(content, botName).matched) return undefined;

  return chatId;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function isTerminalClientError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "WS_AUTH_FAILURE_EXHAUSTED" ||
    code === "WS_RECONNECT_EXHAUSTED"
  );
}

function publicErrorMessage(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): string {
  let message: string;
  if (isTerminalClientError(error)) {
    message = "WeCom authentication or connection attempts were exhausted";
  } else if (error instanceof Error && error.message.trim().length > 0) {
    message = error.message;
  } else {
    message = String(error);
  }
  const values = sensitiveValues
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    message = message.replaceAll(value, "[REDACTED_SECRET]");
  }
  return message;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Discovery timeout must be a positive number of milliseconds");
  }
  return Math.round(timeoutMs);
}

/**
 * Connect to WeCom and resolve with the first group ID containing the exact bot mention.
 * No reply is sent and no application/session code is involved.
 */
export function waitForWeComGroupChatId(
  options: WeComDiscoveryOptions,
): Promise<string> {
  const botId = options.botId.trim();
  const secret = options.secret.trim();
  if (botId.length === 0) throw new Error("WeCom Bot ID must not be blank");
  if (secret.length === 0) throw new Error("WeCom Secret must not be blank");

  const botName = options.botName.trim();
  if (botName.length === 0) throw new Error("WeCom Bot Name must not be blank");
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  const clientOptions: WSClientOptions = {
    botId,
    secret,
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: 1,
    logger: silentLogger,
    ...(options.wsUrl?.trim() ? { wsUrl: options.wsUrl.trim() } : {}),
  };
  const client = (options.clientFactory ?? defaultClientFactory)(clientOptions);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finishReject(new Error("Timed out waiting for an exact @BOT_NAME mention in a WeCom group message"));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("message.text", onMessage);
      client.off("error", onError);
      try {
        client.disconnect();
      } catch {
        // Cleanup must not replace the discovery result.
      }
    };
    const finishResolve = (groupChatId: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(groupChatId);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onMessage: EventListener = (value) => {
      const groupChatId =
        value !== null && typeof value === "object"
          ? extractWeComGroupChatId(value as WeComMessageFrame, {
              botId,
              botName,
            })
          : undefined;
      if (groupChatId !== undefined) finishResolve(groupChatId);
    };
    const onError: EventListener = (error) => {
      if (isTerminalClientError(error)) finishReject(error);
    };

    client.on("message.text", onMessage);
    client.on("error", onError);
    try {
      const result = client.connect();
      if (
        result !== null &&
        typeof result === "object" &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        void Promise.resolve(result).catch(finishReject);
      }
    } catch (error) {
      finishReject(error);
    }
  });
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let help = false;
  let timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--timeout") {
      const rawSeconds = argv[index + 1];
      if (rawSeconds === undefined) {
        throw new Error("--timeout requires a number of seconds");
      }
      index += 1;
      const seconds = Number(rawSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      timeoutMs = validateTimeout(seconds * 1000);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { help, timeoutMs };
}

export const WECOM_DISCOVER_USAGE = `Usage: pnpm wecom-discover [--timeout <seconds>]

Environment:
  IM_WECOM_BOT_ID      WeCom smart-bot ID
  IM_WECOM_SECRET      WeCom smart-bot secret
  IM_WECOM_BOT_NAME    Required exact bot name used for @ matching
  IM_WECOM_WS_URL      Optional WebSocket endpoint override

The command waits for one text message containing the exact @BOT_NAME mention in
a group, prints IM_WECOM_GROUP_CHAT_ID=<chatid>, and exits without replying or
starting a DSCode Session.`;

export async function runWeComDiscover(
  argv: readonly string[] = process.argv.slice(2),
  options: RunWeComDiscoverOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo;
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    io.stderr(publicErrorMessage(error));
    io.stderr(WECOM_DISCOVER_USAGE);
    return 2;
  }
  if (parsed.help) {
    io.stdout(WECOM_DISCOVER_USAGE);
    return 0;
  }

  const env = options.env ?? process.env;
  const botId = envValue(env, "IM_WECOM_BOT_ID");
  const secret = envValue(env, "IM_WECOM_SECRET");
  const botName = envValue(env, "IM_WECOM_BOT_NAME");
  if (botId === undefined || secret === undefined || botName === undefined) {
    io.stderr(
      "IM_WECOM_BOT_ID, IM_WECOM_SECRET and IM_WECOM_BOT_NAME are required",
    );
    return 2;
  }

  io.stderr(
    "Waiting for an exact @BOT_NAME mention in the target WeCom group (no reply will be sent)...",
  );
  try {
    const wsUrl = envValue(env, "IM_WECOM_WS_URL");
    const discoveryOptions: WeComDiscoveryOptions = {
      botId,
      secret,
      timeoutMs: parsed.timeoutMs,
      botName,
      ...(wsUrl !== undefined ? { wsUrl } : {}),
      ...(options.clientFactory !== undefined
        ? { clientFactory: options.clientFactory }
        : {}),
    };
    const groupChatId = await waitForWeComGroupChatId({
      ...discoveryOptions,
    });
    io.stdout(`IM_WECOM_GROUP_CHAT_ID=${groupChatId}`);
    return 0;
  } catch (error) {
    io.stderr(
      `WeCom discovery failed: ${publicErrorMessage(error, [botId, secret])}`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

if (isMainModule()) {
  void runWeComDiscover().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
