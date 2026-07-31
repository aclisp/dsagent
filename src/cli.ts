#!/usr/bin/env node

import process from "node:process";
import pc from "picocolors";
import { ensureFirstRunAuth, runAuthCommand } from "./auth.js";
import { createDSCodeExtension } from "./dscode-extension.js";
import { initializeDSCodeHome } from "./home.js";
import { installPiLoginSecretMask } from "./pi-login-mask.js";
import { installPiMarkdownCodeBlocks } from "./pi-markdown.js";
import { parseSupportedProviderId, type SupportedProviderId } from "./providers.js";
import { parseRuntimeArgs, printDSCodeHelp } from "./runtime-options.js";
import { installDSCodeRuntimeBranding } from "./runtime-branding.js";
import { ensureDSCodeUiDefaults } from "./ui-defaults.js";
import { DSCODE_VERSION } from "./version.js";

void run().catch((error) => {
  process.stderr.write(`${pc.red("error:")} ${formatError(error)}\n`);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const parsed = parseRuntimeArgs(process.argv.slice(2));
  if (parsed.help) {
    printDSCodeHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${DSCODE_VERSION}\n`);
    return;
  }
  process.chdir(parsed.options.cwd);
  const agentDirectory = await initializeDSCodeHome();
  process.env.PI_TELEMETRY ??= "0";
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
  await ensureDSCodeUiDefaults(agentDirectory);

  const authCommand = parseAuthCommand(process.argv.slice(2));
  if (authCommand) {
    await runAuthCommand(authCommand.command, {
      ...parsed.options,
      providerId: authCommand.providerId ?? parsed.options.providerId,
    });
    return;
  }
  const configuredBaseUrl = await ensureFirstRunAuth({
    providerId: parsed.options.providerId,
    baseUrl: parsed.options.baseUrl,
    modelId: parsed.options.modelId,
    piArgs: parsed.piArgs,
  });
  if (configuredBaseUrl) parsed.options.baseUrl = configuredBaseUrl;
  installPiLoginSecretMask();
  installPiMarkdownCodeBlocks();
  installDSCodeRuntimeBranding();

  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(parsed.piArgs, {
    extensionFactories: [createDSCodeExtension(parsed.options)],
  });
}

interface AuthCommand {
  command: "login" | "logout" | "status";
  providerId?: SupportedProviderId;
}

function parseAuthCommand(argv: string[]): AuthCommand | undefined {
  const command = argv[0];
  if (command === "login" || command === "logout") {
    return {
      command,
      ...(argv[1] ? { providerId: parseSupportedProviderId(argv[1]) } : {}),
    };
  }
  if (command === "auth" && argv[1] === "status") {
    return {
      command: "status",
      ...(argv[2] ? { providerId: parseSupportedProviderId(argv[2]) } : {}),
    };
  }
  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ZodError") return error.message;
    return error.message;
  }
  return String(error);
}
