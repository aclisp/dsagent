import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const corePackage = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "packages/core/package.json"), "utf8"),
);

if (cliPackage.version !== corePackage.version) {
  throw new Error(`Package versions differ: CLI=${cliPackage.version}, Core=${corePackage.version}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-package-check-"));
const artifacts = path.join(scratch, "artifacts");
const cliInstall = path.join(scratch, "cli");
const coreInstall = path.join(scratch, "core");
const dscodeHome = path.join(scratch, "home");

try {
  for (const directory of [artifacts, cliInstall, coreInstall, dscodeHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  run("npm", ["pack", "--pack-destination", artifacts], projectRoot);
  run("npm", ["pack", "./packages/core", "--pack-destination", artifacts], projectRoot);

  const cliTarball = path.join(artifacts, `thinkany-dscode-${cliPackage.version}.tgz`);
  const coreTarball = path.join(artifacts, `thinkany-dscode-core-${corePackage.version}.tgz`);
  requireFile(cliTarball);
  requireFile(coreTarball);

  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", cliInstall, cliTarball],
    projectRoot,
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", coreInstall, coreTarball],
    projectRoot,
  );

  const installedCli = path.join(
    cliInstall,
    "node_modules",
    "@thinkany",
    "dscode",
    "dist",
    "cli.js",
  );
  requireFile(installedCli);
  const version = run(process.execPath, [installedCli, "--version"], cliInstall).trim();
  if (version !== cliPackage.version) {
    throw new Error(`Installed CLI returned ${version}; expected ${cliPackage.version}`);
  }

  const rpcProbe = [
    'import { createDSCodeRpcClient } from "@thinkany/dscode-core/rpc";',
    'import { DSCODE_VERSION } from "@thinkany/dscode-core";',
    "const providers = [['deepseek', 'deepseek-v4-flash'], ['openai', 'gpt-5.6-sol'], ['openai-codex', 'gpt-5.6-sol']];",
    "for (const [provider, model] of providers) {",
    '  const client = createDSCodeRpcClient({ provider, model, cwd: process.cwd(), args: ["--no-session", "--no-approve"] });',
    "  await client.start();",
    "  const state = await client.getState();",
    "  await client.stop();",
    "  if (state.isStreaming || state.sessionFile) throw new Error('Unexpected RPC state');",
    "  if (state.model?.provider !== provider) throw new Error(`RPC provider mismatch: ${state.model?.provider} !== ${provider}`);",
    "}",
    `if (DSCODE_VERSION !== ${JSON.stringify(corePackage.version)}) throw new Error('Core version mismatch');`,
  ].join("\n");
  run(process.execPath, ["--input-type=module", "-e", rpcProbe], coreInstall, {
    DSCODE_HOME: dscodeHome,
    DEEPSEEK_API_KEY: "package-check-only",
    OPENAI_API_KEY: "package-check-only",
  });

  process.stdout.write(
    `Verified packed ${cliPackage.name}@${cliPackage.version} and ${corePackage.name}@${corePackage.version}.\n`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function run(command, args, cwd, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requireFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Expected package artifact is missing: ${file}`);
}
