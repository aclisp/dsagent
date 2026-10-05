import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isStandalone } from "./distribution.ts";
import { classifyLiteralCommand } from "./literal-command.ts";
import { MODEL_CREDENTIAL_ENV_KEYS } from "./providers.ts";

export function classifyDSCodeCommand(command: string) {
  return classifyLiteralCommand(command, "dscode");
}

/** Keep the original delegate limit: root -> child, without grandchildren. */
export function isDSCodeChild(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Number(environment.DSCODE_SUBAGENT_DEPTH ?? "0") >= 1;
}

/** Fixed installation paths work from both CLI and bundled HTTP hosts. */
export function resolveDSCodeExecutable(): { executable: string; prefix: string[] } {
  if (isStandalone) return { executable: process.execPath, prefix: [] };
  for (const relative of ["../../../dist/bundle/cli.js", "../../../packages/core/dist/rpc-entry.js"]) {
    const entry = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
  }
  throw new Error("The DSCode CLI entrypoint is unavailable. Build or install the CLI alongside this host.");
}

const ENVIRONMENT_KEYS = [
  ...MODEL_CREDENTIAL_ENV_KEYS,
  "DSCODE_HOME", "DSCODE_CONFIG_PATH", "DSCODE_CREDENTIALS_STORE", "DSCODE_ARCHIVED_SESSIONS_DIR", "DSCODE_VISION_MODEL", "DSCODE_SESSIONS_DIR", "DSCODE_SQLITE_HOME", "DSCODE_PROVIDER", "DSCODE_MODEL",
  "DSCODE_EFFORT", "DSCODE_TRANSPORT", "DSCODE_PROMPT_CONTRACT", "DSCODE_PERMISSION", "DSCODE_SANDBOX",
  "DSCODE_SANDBOX_IMAGE", "DSCODE_WINDOWS_SANDBOX", "DSCODE_ALLOW_HEADLESS_KEYRING", "DEEPSEEK_BASE_URL",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "PATHEXT", "SystemRoot", "SHELL", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "LANG", "TZ", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
] as const;

/** Preserve normal CLI configuration and model credentials, without Node preload hooks. */
export function createDSCodeProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const trusted: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) trusted[key] = environment[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("LC_") && value !== undefined) trusted[key] = value;
  }
  // A piped child must be able to use the credentials saved by its interactive parent.
  trusted.DSCODE_ALLOW_HEADLESS_KEYRING ??= "1";
  trusted.DSCODE_SUBAGENT_DEPTH = "1";
  return trusted;
}
