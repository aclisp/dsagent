import type { ChatOutboundArtifact as WeComOutboundArtifact } from "@aclisp/dsagent-chat-client";
export { collectChatOutboundArtifacts as collectWeComOutboundArtifacts, MAX_OUTBOUND_MEDIA_BYTES, MAX_OUTBOUND_MEDIA_COUNT, type ChatOutboundArtifact as WeComOutboundArtifact, type SkippedChatOutboundArtifact as SkippedWeComOutboundArtifact, type CollectChatOutboundArtifactsResult as CollectWeComOutboundArtifactsResult } from "@aclisp/dsagent-chat-client";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type WeComInboundMediaKind = "image" | "file";
export type WeComOutboundMediaKind = WeComInboundMediaKind;

export interface WeComMediaReference {
  kind: WeComInboundMediaKind;
  url: string;
  aesKey?: string;
}

export interface WeComDownloadedMedia {
  buffer: Buffer;
  filename?: string;
}

export interface WeComMediaDownloadClient {
  downloadFile(
    url: string,
    aesKey?: string,
  ): Promise<WeComDownloadedMedia>;
}

export interface WeComMediaUploadClient {
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: WeComOutboundMediaKind; filename: string },
  ): Promise<{ media_id: string }>;
  sendMediaMessage(
    chatId: string,
    mediaType: WeComOutboundMediaKind,
    mediaId: string,
  ): Promise<unknown>;
}

export interface StoredWeComMedia {
  kind: WeComInboundMediaKind;
  name: string;
  path: string;
  size: number;
}

export interface WeComMediaStoreLogger {
  error(message: string): void;
}

export interface WeComMediaStoreOptions {
  workspacePath: string;
  maxInboundBytes: number;
}

export const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;

export type WeComMediaFailureReason =
  | "download_failed"
  | "invalid_download"
  | "too_large";

export class WeComMediaError extends Error {
  readonly reason: WeComMediaFailureReason;

  constructor(reason: WeComMediaFailureReason, message: string) {
    super(message);
    this.name = "WeComMediaError";
    this.reason = reason;
  }
}

const MAX_FILENAME_LENGTH = 120;

function safePositiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function safeBasename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return undefined;
  }
  const sanitized = trimmed
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+$/u, "_")
    .slice(0, MAX_FILENAME_LENGTH);
  return sanitized.length > 0 ? sanitized : undefined;
}

function inferImageExtension(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return ".png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpg";
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return ".gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  return undefined;
}

function filenameExtension(filename: string | undefined): string | undefined {
  const extension = filename === undefined ? "" : path.extname(filename).toLowerCase();
  return extension.length > 0 ? extension : undefined;
}

function mediaFilename(
  reference: WeComMediaReference,
  downloadedFilename: string | undefined,
  buffer: Buffer,
  messageId: string,
  index: number,
): string {
  const token = createHash("sha256")
    .update(`${messageId}:${index}:${reference.kind}`)
    .digest("hex")
    .slice(0, 12);
  const originalName = safeBasename(downloadedFilename);
  const extension =
    filenameExtension(originalName) ??
    (reference.kind === "image" ? inferImageExtension(buffer) : undefined);
  const suffix = originalName ?? `${reference.kind}${extension ?? ".bin"}`;
  return `wecom-${token}-${index + 1}-${suffix}`.slice(0, MAX_FILENAME_LENGTH);
}

function workspaceRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Store encrypted WeCom media in the same workspace uploads directory used by
 * the Chat Web UI. The SDK owns download and AES decryption; this class only
 * validates the resulting bytes and persists them.
 */
export class WeComMediaStore {
  private readonly workspacePath: string;
  private readonly maxInboundBytes: number;

  constructor(options: WeComMediaStoreOptions) {
    const workspacePath = options.workspacePath.trim();
    if (workspacePath.length === 0) {
      throw new Error("WeCom media workspacePath must not be blank");
    }
    this.workspacePath = workspacePath;
    this.maxInboundBytes = safePositiveLimit(
      options.maxInboundBytes,
      DEFAULT_MAX_INBOUND_MEDIA_BYTES,
    );
  }

  async downloadAndStore(
    client: WeComMediaDownloadClient,
    reference: WeComMediaReference,
    messageId: string,
    index: number,
  ): Promise<StoredWeComMedia> {
    let downloaded: WeComDownloadedMedia;
    try {
      downloaded = await client.downloadFile(
        reference.url,
        reference.aesKey,
      );
    } catch (error) {
      throw new WeComMediaError(
        "download_failed",
        error instanceof Error ? error.message : "WeCom media download failed",
      );
    }
    if (!Buffer.isBuffer(downloaded.buffer)) {
      throw new WeComMediaError(
        "invalid_download",
        "WeCom media download did not return a Buffer",
      );
    }
    if (downloaded.buffer.byteLength > this.maxInboundBytes) {
      throw new WeComMediaError(
        "too_large",
        `WeCom inbound media exceeds ${this.maxInboundBytes} bytes`,
      );
    }

    const uploadDir = path.join(this.workspacePath, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const name = mediaFilename(
      reference,
      downloaded.filename,
      downloaded.buffer,
      messageId,
      index,
    );
    const target = path.join(uploadDir, name);
    await writeFile(target, downloaded.buffer, { mode: 0o600 });
    return {
      kind: reference.kind,
      name,
      path: workspaceRelativePath(path.join("uploads", name)),
      size: downloaded.buffer.byteLength,
    };
  }
}

export async function sendWeComOutboundArtifacts(
  client: WeComMediaUploadClient,
  chatId: string,
  artifacts: readonly WeComOutboundArtifact[],
  logger: WeComMediaStoreLogger,
): Promise<void> {
  for (const artifact of artifacts) {
    try {
      const uploaded = await client.uploadMedia(artifact.buffer, {
        type: artifact.kind,
        filename: artifact.name,
      });
      if (typeof uploaded.media_id !== "string" || uploaded.media_id.length === 0) {
        throw new Error("WeCom media upload returned no media_id");
      }
      await client.sendMediaMessage(chatId, artifact.kind, uploaded.media_id);
    } catch {
      logger.error(`WeCom attachment delivery failed for ${artifact.path}`);
    }
  }
}
