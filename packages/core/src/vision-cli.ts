import { mkdtemp, copyFile, chmod, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { formatDSCodeError } from "./cli-runtime.js";
import { FileCredentialStore } from "./credential-store.js";
import { getDSCodeHome } from "./home.js";
import { detectImageMimeType } from "./image-input.js";
import { MODEL_CREDENTIAL_ENV_KEYS } from "./providers.js";

const DEFAULT_PROMPT =
  "Describe this image in detail for another assistant. Transcribe all visible text faithfully and explain details that may be relevant to the user's request.";
const VISION_SYSTEM_PROMPT =
  "You are a vision analysis component. Analyze only the attached image and answer the supplied request. Return concise, factual text. Transcribe visible text faithfully. You have no tools and must not claim to inspect anything outside the image.";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface VisionCliInvocation {
  image: string;
  prompt: string;
}

export type ParsedVisionCliArgs =
  | { help: true }
  | { help: false; invocation: VisionCliInvocation };

export interface VisionRuntimeConfig {
  model: string;
  thinking: ThinkingLevel;
}

interface ValidatedVisionImage {
  data: string;
  mimeType: string;
}

export function parseVisionCliArgs(argv: readonly string[]): ParsedVisionCliArgs {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }

  let image: string | undefined;
  let prompt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--image" && flag !== "--prompt") {
      throw new Error(`Unknown dscode-vision argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--image") {
      if (image !== undefined) throw new Error("--image may only be provided once");
      image = value.trim();
    } else {
      if (prompt !== undefined) throw new Error("--prompt may only be provided once");
      prompt = value.trim();
    }
  }

  if (!image) throw new Error("--image is required");
  if (prompt !== undefined && !prompt) throw new Error("--prompt cannot be empty");
  return {
    help: false,
    invocation: {
      image,
      prompt: prompt ?? DEFAULT_PROMPT,
    },
  };
}

export function loadVisionRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): VisionRuntimeConfig {
  const model = environment.DSCODE_VISION_MODEL?.trim();
  if (!model) throw new Error("DSCODE_VISION_MODEL is required");
  if (!environment.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OpenRouter is not configured for dscode-vision");
  }
  const thinking = environment.DSCODE_VISION_THINKING?.trim();
  if (!isThinkingLevel(thinking)) {
    throw new Error(
      `DSCODE_VISION_THINKING must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return { model, thinking };
}

export async function runVisionCli(argv: readonly string[]): Promise<void> {
  const parsed = parseVisionCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(visionCliHelp());
    return;
  }

  const config = loadVisionRuntimeConfig();
  const image = await validateVisionImage(parsed.invocation.image, process.cwd());
  const sourceHome = getDSCodeHome();
  const sourceModelsPath = path.join(sourceHome, "models.json");
  const modelsJson = await readModelsJson(sourceModelsPath);
  validateConfiguredVisionModel(modelsJson, config.model, sourceModelsPath);

  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dscode-vision-"));
  const temporaryModelsPath = path.join(temporaryHome, "models.json");
  const restoreEnvironment = isolateVisionEnvironment(temporaryHome);
  try {
    await copyFile(sourceModelsPath, temporaryModelsPath);
    await chmod(temporaryModelsPath, 0o600);
    await runVisionRuntime(
      temporaryModelsPath,
      path.join(temporaryHome, "auth.json"),
      image,
      parsed.invocation.prompt,
      config,
    );
  } finally {
    restoreEnvironment();
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

export async function runVisionCliProcess(argv: readonly string[]): Promise<void> {
  try {
    await runVisionCli(argv);
  } catch (error) {
    process.stderr.write(`error: ${formatDSCodeError(error)}\n`);
    process.exitCode = 1;
  }
}

export function visionCliHelp(): string {
  return `DSCode Vision — inspect one image with the configured OpenRouter vision model

Usage:
  dscode-vision --image <path> [--prompt <text>]

Configuration:
  DSCODE_VISION_MODEL       Model ID declared with image input in models.json
  DSCODE_VISION_THINKING    Current main-agent thinking level
  OPENROUTER_API_KEY        OpenRouter credential supplied by the trusted launcher
`;
}

async function validateVisionImage(image: string, cwd: string): Promise<ValidatedVisionImage> {
  const absolutePath = path.resolve(cwd, image);
  let details;
  try {
    details = await stat(absolutePath);
  } catch {
    throw new Error(`Image not found: ${absolutePath}`);
  }
  if (!details.isFile()) throw new Error(`Image is not a file: ${absolutePath}`);
  if (details.size === 0) throw new Error(`Image is empty: ${absolutePath}`);
  if (details.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds the 20 MiB limit: ${absolutePath}`);
  }
  const bytes = await readFile(absolutePath);
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new Error(`Unsupported or invalid image: ${absolutePath}`);
  }
  return { data: bytes.toString("base64"), mimeType };
}

async function readModelsJson(modelsPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`DSCode models file not found: ${modelsPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode models file: ${modelsPath}`);
    }
    throw error;
  }
}

function validateConfiguredVisionModel(
  modelsJson: unknown,
  modelId: string,
  modelsPath: string,
): void {
  const provider = isRecord(modelsJson) && isRecord(modelsJson.providers)
    ? modelsJson.providers.openrouter
    : undefined;
  const models = isRecord(provider) && Array.isArray(provider.models) ? provider.models : [];
  const model = models.find((candidate) => isRecord(candidate) && candidate.id === modelId);
  if (!model) {
    throw new Error(`OpenRouter model ${modelId} is not declared in ${modelsPath}`);
  }
  if (!Array.isArray(model.input) || !model.input.includes("image")) {
    throw new Error(`OpenRouter model ${modelId} does not declare image input in ${modelsPath}`);
  }
}

function isolateVisionEnvironment(temporaryHome: string): () => void {
  const overrides: Record<string, string | undefined> = {
    DSCODE_HOME: temporaryHome,
    DSCODE_SESSIONS_DIR: path.join(temporaryHome, "sessions"),
    DSCODE_ARCHIVED_SESSIONS_DIR: path.join(temporaryHome, "archived_sessions"),
    DSCODE_CONFIG_PATH: path.join(temporaryHome, "config.json"),
    DSCODE_SQLITE_HOME: temporaryHome,
    DSCODE_CREDENTIALS_STORE: "file",
    PI_CODING_AGENT_DIR: temporaryHome,
    PI_CODING_AGENT_SESSION_DIR: path.join(temporaryHome, "sessions"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const key of MODEL_CREDENTIAL_ENV_KEYS) {
    if (key !== "OPENROUTER_API_KEY") overrides[key] = undefined;
  }

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function runVisionRuntime(
  modelsPath: string,
  authPath: string,
  image: ValidatedVisionImage,
  prompt: string,
  config: VisionRuntimeConfig,
): Promise<void> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    credentials: new FileCredentialStore(authPath),
    modelsPath,
    allowModelNetwork: false,
  });
  const model = runtime.getModel("openrouter", config.model);
  if (!model) throw new Error(`Configured OpenRouter vision model is unavailable: ${config.model}`);
  const response = await runtime.completeSimple(
    model,
    {
      systemPrompt: VISION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: image.data, mimeType: image.mimeType },
            { type: "text", text: prompt },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    config.thinking === "off" ? {} : { reasoning: config.thinking },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Vision request ${response.stopReason}`);
  }
  const output = response.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("")
    .trim();
  if (!output) throw new Error("Vision model returned no text");
  process.stdout.write(`${output}\n`);
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
