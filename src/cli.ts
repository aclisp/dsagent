#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import pc from "picocolors";
import { ensureFirstRunAuth, runAuthCommand } from "./auth.js";
import { createDSCodeExtension } from "./dscode-extension.js";
import { installPiLoginSecretMask } from "./pi-login-mask.js";
import { installPiMarkdownCodeBlocks } from "./pi-markdown.js";
import { parseRuntimeArgs, printDSCodeHelp } from "./runtime-options.js";
import { ensureDSCodeUiDefaults } from "./ui-defaults.js";

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
    process.stdout.write("0.3.0\n");
    return;
  }
  process.chdir(parsed.options.cwd);
  const agentDirectory =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".dscode", "agent");
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PI_CODING_AGENT_SESSION_DIR ??= path.join(os.homedir(), ".dscode", "sessions");
  process.env.PI_TELEMETRY ??= "0";
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
  await ensureDSCodeUiDefaults(agentDirectory);

  const authCommand = parseAuthCommand(process.argv.slice(2));
  if (authCommand) {
    await runAuthCommand(authCommand, parsed.options);
    return;
  }
  await ensureFirstRunAuth({
    baseUrl: parsed.options.baseUrl,
    modelId: parsed.options.modelId,
    piArgs: parsed.piArgs,
  });
  installPiLoginSecretMask();
  installPiMarkdownCodeBlocks();

  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(parsed.piArgs, {
    extensionFactories: [createDSCodeExtension(parsed.options)],
  });
}

function parseAuthCommand(argv: string[]): "login" | "logout" | "status" | undefined {
  const command = argv[0];
  if (command === "login" || command === "logout") return command;
  if (command === "auth" && argv[1] === "status") return "status";
  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ZodError") return error.message;
    return error.message;
  }
  return String(error);
}
