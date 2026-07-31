import path from "node:path";
import { z } from "zod";
import {
  harnessSchema,
  permissionSchema,
  transportSchema,
  type HarnessMode,
  type ModelTransport,
  type PermissionMode,
} from "./config.js";
import { DSCODE_VERSION } from "./version.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
} from "./settings.js";

export const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export interface DSCodeRuntimeOptions {
  cwd: string;
  baseUrl: string;
  modelId: string;
  transport: ModelTransport;
  harness: HarnessMode;
  permission: PermissionMode;
  sandbox: SandboxMode;
  network: boolean;
  webSearch: boolean;
  activeTools: string[];
  toolsExplicit: boolean;
}

export interface ParsedRuntimeArgs {
  options: DSCodeRuntimeOptions;
  piArgs: string[];
  help: boolean;
  version: boolean;
}

export function parseRuntimeArgs(argv: string[]): ParsedRuntimeArgs {
  const forwarded: string[] = [];
  let cwd = process.cwd();
  let baseUrl =
    process.env.DEEPSEEK_BASE_URL ??
    getStoredDeepSeekBaseUrl() ??
    DEFAULT_DEEPSEEK_BASE_URL;
  let modelId = process.env.DSCODE_MODEL ?? "deepseek-v4-flash";
  let effort = process.env.DSCODE_EFFORT ?? "max";
  let transport = transportSchema.parse(process.env.DSCODE_TRANSPORT ?? "responses");
  let harness = harnessSchema.parse(process.env.DSCODE_HARNESS ?? "minimal");
  let permission = permissionSchema.parse(process.env.DSCODE_PERMISSION ?? "auto");
  let sandbox = sandboxModeSchema.parse(process.env.DSCODE_SANDBOX ?? "workspace-write");
  let network = false;
  let webSearch = false;
  let activeTools: string[] | undefined;
  let toolsExplicit = false;
  let help = false;
  let version = false;
  let yolo = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inlineValue] = splitFlag(argument);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };

    if (flag === "-C" || flag === "--cwd") {
      cwd = path.resolve(takeValue());
    } else if (flag === "--base-url") {
      baseUrl = takeValue();
    } else if (flag === "--transport") {
      transport = transportSchema.parse(takeValue());
    } else if (flag === "--harness") {
      harness = harnessSchema.parse(takeValue());
    } else if (flag === "--permission") {
      permission = permissionSchema.parse(takeValue());
    } else if (flag === "--sandbox") {
      sandbox = sandboxModeSchema.parse(takeValue());
    } else if (flag === "--network") {
      network = true;
    } else if (flag === "--web") {
      webSearch = true;
    } else if (flag === "--yes" || flag === "-y") {
      permission = "full";
      yolo = true;
    } else if (flag === "--effort") {
      effort = takeValue();
    } else if (flag === "--model") {
      modelId = takeValue();
    } else if (flag === "--tools") {
      activeTools = takeValue()
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      toolsExplicit = true;
    } else if (flag === "--no-tools") {
      activeTools = [];
      toolsExplicit = true;
    } else if (flag === "--no-resume") {
      // Pi starts a new persisted session unless --continue/--resume is passed.
    } else if (flag === "--help" || flag === "-h") {
      help = true;
    } else if (
      flag === "--version" ||
      flag === "-V" ||
      (flag === "version" && argv.length === 1)
    ) {
      version = true;
    } else {
      forwarded.push(argument);
    }
  }

  if (
    yolo &&
    !["--approve", "-a", "--no-approve", "-na"].some((flag) => hasFlag(forwarded, flag))
  ) {
    forwarded.unshift("--approve");
  }
  if (!hasFlag(forwarded, "--provider")) forwarded.unshift("--provider", "deepseek");
  if (!hasFlag(forwarded, "--model")) forwarded.unshift("--model", modelId);
  if (!hasFlag(forwarded, "--thinking")) forwarded.unshift("--thinking", effort);
  activeTools ??= defaultActiveTools(harness);

  return {
    options: {
      cwd,
      baseUrl: normalizeDeepSeekBaseUrl(baseUrl),
      modelId,
      transport,
      harness,
      permission,
      sandbox,
      network,
      webSearch,
      activeTools,
      toolsExplicit,
    },
    piArgs: forwarded,
    help,
    version,
  };
}

function defaultActiveTools(harness: HarnessMode): string[] {
  const delegation = Number(process.env.DSCODE_SUBAGENT_DEPTH ?? "0") < 1 ? ["delegate"] : [];
  return harness === "minimal"
    ? ["update_plan", "exec_command", "write_stdin", "apply_patch", ...delegation]
    : [
        "update_plan",
        "read_file",
        "list_files",
        "search_files",
        "language_diagnostics",
        "exec_command",
        "write_stdin",
        "apply_patch",
        ...delegation,
      ];
}

export function printDSCodeHelp(): void {
  process.stdout.write(`DSCode ${DSCODE_VERSION} — DeepSeek V4 Flash coding agent

Usage:
  dscode [options] [prompt]
  dscode -p "task"                 Non-interactive text mode
  dscode --mode json -p "task"     JSONL/CI mode
  dscode --mode rpc                IDE/RPC server
  dscode --resume                  Pick a saved session
  dscode --continue                Continue the latest workspace session

DSCode options:
  -C, --cwd <dir>                  Workspace directory
  --base-url <url>                 DeepSeek API base URL
  --model <id>                     Model ID (default: deepseek-v4-flash)
  --effort <level>                 Alias for --thinking low|high|max
  --transport <responses|chat>     API transport (default: responses)
  --harness <minimal|safe>         Tool harness (default: minimal)
  --permission <mode>              plan|ask|auto|full (full grants host + network)
  --sandbox <mode>                 read-only|workspace-write|danger-full-access
  --network                        Pre-authorize command network access for this run
  --web                            Enable DeepSeek server-side web search
  -y, --yes                        YOLO: trust project, skip approvals, allow host + network

Session and editor features:
  /help /settings /name /resume /tree /compact /reload /export
  Ctrl+O tool folding, Ctrl+G external editor, Ctrl+P model cycle
  --name, --fork, --session, --session-dir, --skills, --extension
  --mode text|json|rpc, --print, --no-session, --continue, --resume

DSCode commands:
  /plan /permissions /effort /base-url /status /undo /checkpoints /diff /jobs /mcp /agents /doctor

Authentication:
  dscode login                      Mask, validate, and securely store an API key
  dscode logout                     Remove the stored DeepSeek credential
  dscode auth status                Show credential sources without revealing secrets
  /login deepseek                   Replace the key from inside the TUI
`);
}

function splitFlag(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--") || !argument.includes("=")) return [argument, undefined];
  const index = argument.indexOf("=");
  return [argument.slice(0, index), argument.slice(index + 1)];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}
