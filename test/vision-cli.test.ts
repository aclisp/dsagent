import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadVisionRuntimeConfig,
  parseVisionCliArgs,
  runVisionCli,
} from "../packages/core/src/vision-cli.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZBv8AAAAASUVORK5CYII=",
  "base64",
);
const ENVIRONMENT_KEYS = [
  "DSCODE_HOME",
  "DSCODE_SESSIONS_DIR",
  "DSCODE_ARCHIVED_SESSIONS_DIR",
  "DSCODE_CONFIG_PATH",
  "DSCODE_SQLITE_HOME",
  "DSCODE_CREDENTIALS_STORE",
  "DSCODE_VISION_MODEL",
  "DSCODE_VISION_THINKING",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
] as const;

describe("dscode-vision", () => {
  const temporaryDirectories: string[] = [];
  const originalEnvironment = new Map(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [key, value] of originalEnvironment) restoreEnvironment(key, value);
    process.exitCode = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("accepts one image and an optional prompt", () => {
    expect(parseVisionCliArgs(["--image", "screen shot.png"])).toMatchObject({
      help: false,
      invocation: {
        image: "screen shot.png",
        prompt: expect.stringContaining("Describe this image"),
      },
    });
    expect(
      parseVisionCliArgs(["--prompt", "读取文字", "--image", "screen.png"]),
    ).toEqual({
      help: false,
      invocation: { image: "screen.png", prompt: "读取文字" },
    });
    expect(() => parseVisionCliArgs(["screen.png"])).toThrow("Unknown");
    expect(() => parseVisionCliArgs(["--image", "a.png", "--image", "b.png"])).toThrow(
      "only be provided once",
    );
  });

  it("requires the configured model, OpenRouter key, and inherited thinking level", () => {
    expect(
      loadVisionRuntimeConfig({
        DSCODE_VISION_MODEL: "vision-model",
        DSCODE_VISION_THINKING: "max",
        OPENROUTER_API_KEY: "test-key",
      }),
    ).toEqual({ model: "vision-model", thinking: "max" });
    expect(() => loadVisionRuntimeConfig({ OPENROUTER_API_KEY: "test-key" })).toThrow(
      "DSCODE_VISION_MODEL",
    );
    expect(() =>
      loadVisionRuntimeConfig({
        DSCODE_VISION_MODEL: "vision-model",
        OPENROUTER_API_KEY: "test-key",
      }),
    ).toThrow("DSCODE_VISION_THINKING");
  });

  it("rejects a configured text-only model before making a provider request", async () => {
    const fixture = await createFixture(false);
    configureVisionEnvironment(fixture.home, "high");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runVisionCli(["--image", fixture.image])).rejects.toThrow(
      "does not declare image input",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported and oversized images before making a provider request", async () => {
    const fixture = await createFixture(true);
    configureVisionEnvironment(fixture.home, "high");
    const invalidImage = path.join(fixture.root, "invalid.png");
    await writeFile(invalidImage, "not an image");
    await expect(runVisionCli(["--image", invalidImage])).rejects.toThrow(
      "Unsupported or invalid image",
    );

    const oversizedImage = path.join(fixture.root, "oversized.png");
    const handle = await open(oversizedImage, "w");
    try {
      await handle.write(ONE_PIXEL_PNG.subarray(0, 16), 0, 16, 0);
      await handle.truncate(20 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(runVisionCli(["--image", oversizedImage])).rejects.toThrow(
      "20 MiB limit",
    );
  });

  it("sends one image to the configured model with the main-agent thinking level", async () => {
    const fixture = await createFixture(true);
    configureVisionEnvironment(fixture.home, "max");
    process.env.OPENAI_API_KEY = "must-not-reach-vision";
    await writeFile(
      path.join(fixture.home, "auth.json"),
      JSON.stringify({
        openrouter: { type: "api_key", key: "stored-key-must-not-win" },
      }),
    );

    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    let unrelatedKeyVisible: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorization = new Headers(init?.headers).get("authorization");
        unrelatedKeyVisible = process.env.OPENAI_API_KEY;
        return completionResponse("mock vision result");
      }),
    );
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await runVisionCli([
      "--image",
      fixture.image,
      "--prompt",
      "Explain the visible error",
    ]);

    expect(authorization).toBe("Bearer runtime-openrouter-key");
    expect(unrelatedKeyVisible).toBeUndefined();
    expect(requestBody?.model).toBe("vision-model");
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody?.reasoning).toEqual({ effort: "high" });
    expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,");
    expect(JSON.stringify(requestBody)).toContain("Explain the visible error");
    expect(stdout.join("").trim()).toBe("mock vision result");
    expect((await readdir(fixture.home)).sort()).toEqual(["auth.json", "models.json"]);
  }, 15_000);

  async function createFixture(imageInput: boolean): Promise<{
    root: string;
    home: string;
    image: string;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-vision-test-"));
    temporaryDirectories.push(root);
    const home = path.join(root, "home");
    const image = path.join(root, "screen shot.png");
    await writeFile(image, ONE_PIXEL_PNG);
    await writeFile(
      path.join(root, "models.json.tmp"),
      JSON.stringify(modelsJson(imageInput)),
    );
    await mkdir(home, { recursive: true });
    await rename(path.join(root, "models.json.tmp"), path.join(home, "models.json"));
    return { root, home, image };
  }
});

function configureVisionEnvironment(home: string, thinking: string): void {
  process.env.DSCODE_HOME = home;
  process.env.DSCODE_VISION_MODEL = "vision-model";
  process.env.DSCODE_VISION_THINKING = thinking;
  process.env.OPENROUTER_API_KEY = "runtime-openrouter-key";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
}

function modelsJson(imageInput: boolean): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        baseUrl: "https://vision.test/v1",
        api: "openai-completions",
        apiKey: "$OPENROUTER_API_KEY",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
          maxTokensField: "max_completion_tokens",
        },
        models: [
          {
            id: "vision-model",
            name: "Vision Test Model",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "high",
              max: "high",
            },
            input: imageInput ? ["text", "image"] : ["text"],
            contextWindow: 32_000,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}

function completionResponse(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl_vision_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "vision-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl_vision_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "vision-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
