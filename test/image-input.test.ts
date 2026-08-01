import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectImageMimeType,
  extractLocalImageInput,
  registerLocalImageInput,
} from "../packages/core/src/image-input.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZBv8AAAAASUVORK5CYII=",
  "base64",
);

describe("DSCode TUI image input", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("turns a pasted local path into an inline image attachment", async () => {
    const directory = await createTemporaryDirectory();
    const imagePath = path.join(directory, "termany-paste.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);

    const result = await extractLocalImageInput(`${imagePath} 这是什么？`, directory);

    expect(result.errors).toEqual([]);
    expect(result.paths).toEqual([imagePath]);
    expect(result.images).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: ONE_PIXEL_PNG.toString("base64"),
      },
    ]);
    expect(result.text).toBe("[Image #1]\n这是什么？");
    expect(result.text).not.toContain(imagePath);
  });

  it("supports quoted image paths with spaces and @file syntax", async () => {
    const directory = await createTemporaryDirectory();
    const imagePath = path.join(directory, "screen shot.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);

    const result = await extractLocalImageInput(`请解释 @"${imagePath}"`, directory);

    expect(result.images).toHaveLength(1);
    expect(result.text).toContain("请解释");
    expect(result.text).not.toContain(`@"${imagePath}"`);
  });

  it("numbers multiple pasted images without exposing their local paths", async () => {
    const directory = await createTemporaryDirectory();
    const firstPath = path.join(directory, "first.png");
    const secondPath = path.join(directory, "second.png");
    await Promise.all([
      writeFile(firstPath, ONE_PIXEL_PNG),
      writeFile(secondPath, ONE_PIXEL_PNG),
    ]);

    const result = await extractLocalImageInput(`${firstPath} ${secondPath} compare`, directory);

    expect(result.images).toHaveLength(2);
    expect(result.text).toBe("[Image #1]\n[Image #2]\ncompare");
    expect(result.text).not.toContain(directory);
  });

  it("leaves nonexistent image-looking paths as ordinary text", async () => {
    const result = await extractLocalImageInput("/tmp/not-a-real-dscode-image.png 是什么", "/tmp");
    expect(result).toEqual({
      text: "/tmp/not-a-real-dscode-image.png 是什么",
      images: [],
      paths: [],
      errors: [],
    });
  });

  it("detects the supported inline image formats by content", () => {
    expect(detectImageMimeType(ONE_PIXEL_PNG)).toBe("image/png");
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectImageMimeType(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
    expect(detectImageMimeType(Buffer.from("not an image"))).toBeUndefined();
  });

  it("adds parsed images to interactive input for a vision-capable model", async () => {
    const directory = await createTemporaryDirectory();
    const imagePath = path.join(directory, "attached.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);
    const { handler, notifications } = captureInputHandler();

    const result = await handler(
      { source: "interactive", text: `${imagePath} inspect this` },
      {
        cwd: directory,
        model: { provider: "openai-codex", id: "gpt-5.6-sol", input: ["text", "image"] },
      },
    );

    expect(result).toMatchObject({ action: "transform", images: [{ mimeType: "image/png" }] });
    expect(notifications).toEqual([]);
  });

  it("stops image input with a clear message for text-only models", async () => {
    const directory = await createTemporaryDirectory();
    const imagePath = path.join(directory, "attached.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);
    const { handler, notifications } = captureInputHandler();

    const result = await handler(
      { source: "interactive", text: `${imagePath} inspect this` },
      {
        cwd: directory,
        model: { provider: "deepseek", id: "deepseek-v4-flash", input: ["text"] },
      },
    );

    expect(result).toEqual({ action: "handled" });
    expect(notifications[0]?.message).toContain("does not support image input");
  });

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-image-input-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

type InputHandler = (
  event: { source: "interactive"; text: string },
  context: {
    cwd: string;
    model: { provider: string; id: string; input: string[] };
  },
) => Promise<unknown>;

function captureInputHandler(): {
  handler: InputHandler;
  notifications: Array<{ message: string; level: string }>;
} {
  let handler: InputHandler | undefined;
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on(event: string, candidate: InputHandler) {
      if (event === "input") handler = candidate;
    },
  } as unknown as ExtensionAPI;
  registerLocalImageInput(pi);
  if (!handler) throw new Error("input handler was not registered");
  const registered = handler;
  return {
    notifications,
    handler: async (event, context) =>
      registered(event, {
        ...context,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as unknown as ExtensionContext),
  };
}
