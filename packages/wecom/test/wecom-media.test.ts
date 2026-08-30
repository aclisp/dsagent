import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectWeComOutboundArtifacts,
  MAX_OUTBOUND_MEDIA_BYTES,
  sendWeComOutboundArtifacts,
  WeComMediaError,
  WeComMediaStore,
  type WeComMediaDownloadClient,
  type WeComMediaUploadClient,
} from "../src/wecom-media.js";

const tempDirectories: string[] = [];

async function tempWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dscode-wecom-media-"));
  tempDirectories.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WeCom media store", () => {
  it("downloads, decrypts through the SDK seam, and stores media in uploads", async () => {
    const workspace = await tempWorkspace();
    const client: WeComMediaDownloadClient = {
      async downloadFile(url, aesKey) {
        expect(url).toBe("https://example.invalid/file");
        expect(aesKey).toBe("aes-key");
        return {
          buffer: Buffer.from("file-content"),
          filename: "report.pdf",
        };
      },
    };
    const store = new WeComMediaStore({
      workspacePath: workspace,
      maxInboundBytes: 1024,
    });

    const stored = await store.downloadAndStore(
      client,
      { kind: "file", url: "https://example.invalid/file", aesKey: "aes-key" },
      "message-1",
      0,
    );

    expect(stored.path).toMatch(/^uploads\/wecom-[a-f0-9]{12}-1-report\.pdf$/u);
    expect(stored.size).toBe(12);
    await expect(readFile(path.join(workspace, stored.path), "utf8")).resolves.toBe(
      "file-content",
    );
  });

  it("infers a safe image extension and rejects oversized downloads", async () => {
    const workspace = await tempWorkspace();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const store = new WeComMediaStore({
      workspacePath: workspace,
      maxInboundBytes: png.length,
    });

    const stored = await store.downloadAndStore(
      { downloadFile: async () => ({ buffer: png }) },
      { kind: "image", url: "https://example.invalid/image" },
      "message-2",
      1,
    );
    expect(stored.path).toMatch(/-2-image\.png$/u);

    await expect(
      store.downloadAndStore(
        { downloadFile: async () => ({ buffer: Buffer.alloc(png.length + 1) }) },
        { kind: "file", url: "https://example.invalid/large" },
        "message-3",
        0,
      ),
    ).rejects.toMatchObject({ reason: "too_large" } satisfies Partial<WeComMediaError>);
  });
});

describe("WeCom outbound artifacts", () => {
  it("collects only explicit workspace citations and classifies media", async () => {
    const workspace = await tempWorkspace();
    await mkdir(path.join(workspace, "uploads"));
    await writeFile(path.join(workspace, "uploads", "result.pdf"), "pdf");
    await writeFile(path.join(workspace, "uploads", "chart.png"), "png");
    await writeFile(path.join(workspace, "outside.txt"), "outside");

    const result = await collectWeComOutboundArtifacts(
      "完成：`uploads/result.pdf`、`uploads/chart.png`、`uploads/missing.txt`。",
      workspace,
    );

    expect(result.artifacts.map(({ path: relativePath, kind }) => ({ path: relativePath, kind }))).toEqual([
      { path: "uploads/result.pdf", kind: "file" },
      { path: "uploads/chart.png", kind: "image" },
    ]);
    expect(result.skipped).toEqual([
      { path: "uploads/missing.txt", reason: "not_found" },
    ]);

    const traversal = await collectWeComOutboundArtifacts(
      "不要发送 `../outside.txt` 或 `file:///etc/passwd`。",
      workspace,
    );
    expect(traversal.artifacts).toEqual([]);

    const codeExample = await collectWeComOutboundArtifacts(
      "```text\nuploads/result.pdf\n```",
      workspace,
    );
    expect(codeExample.artifacts).toEqual([]);
  });

  it("uploads and sends artifacts without exposing upload failures to callers", async () => {
    const calls: Array<{ type: string; name: string; chatId?: string; mediaId?: string }> = [];
    const client: WeComMediaUploadClient = {
      async uploadMedia(buffer, options) {
        calls.push({ type: options.type, name: options.filename });
        expect(buffer.length).toBeLessThan(MAX_OUTBOUND_MEDIA_BYTES);
        return { media_id: `media-${calls.length}` };
      },
      async sendMediaMessage(chatId, mediaType, mediaId) {
        calls.push({ chatId, type: mediaType, name: "", mediaId });
      },
    };
    const errors: string[] = [];

    await sendWeComOutboundArtifacts(
      client,
      "group-1",
      [
        {
          kind: "file",
          name: "result.pdf",
          path: "uploads/result.pdf",
          size: 3,
          buffer: Buffer.from("pdf"),
        },
      ],
      { error: (message) => errors.push(message) },
    );

    expect(calls).toEqual([
      { type: "file", name: "result.pdf" },
      { chatId: "group-1", type: "file", name: "", mediaId: "media-1" },
    ]);
    expect(errors).toEqual([]);
  });
});
