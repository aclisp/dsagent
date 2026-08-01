import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IMAGE_PATH_PATTERN =
  /(^|\s)(@?(?:"[^"\r\n]+\.(?:png|jpe?g|gif|webp)"|'[^'\r\n]+\.(?:png|jpe?g|gif|webp)'|[^\s"'<>]+\.(?:png|jpe?g|gif|webp)))(?=\s|$)/giu;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 8;

interface ImagePathCandidate {
  raw: string;
  value: string;
  start: number;
  end: number;
}

export interface LocalImageInputResult {
  text: string;
  images: ImageContent[];
  paths: string[];
  errors: string[];
}

export interface LocalImageInputOptions {
  maxImageBytes?: number;
  maxImages?: number;
}

export function registerLocalImageInput(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };

    const result = await extractLocalImageInput(event.text, ctx.cwd);
    const images = [...(event.images ?? []), ...result.images];
    if (result.errors.length > 0) {
      ctx.ui.notify(result.errors.join("\n"), result.images.length > 0 ? "warning" : "error");
    }
    if (images.length === 0) {
      return result.errors.length > 0 ? { action: "handled" } : { action: "continue" };
    }
    if (!ctx.model?.input.includes("image")) {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "The selected model";
      ctx.ui.notify(
        `${model} does not support image input. Use /model or /login to select a vision-capable model.`,
        "warning",
      );
      return { action: "handled" };
    }
    if (result.images.length === 0) return { action: "continue" };
    return {
      action: "transform",
      text: result.text,
      images,
    };
  });
}

export async function extractLocalImageInput(
  text: string,
  cwd: string,
  options: LocalImageInputOptions = {},
): Promise<LocalImageInputResult> {
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const images: ImageContent[] = [];
  const paths: string[] = [];
  const errors: string[] = [];
  const consumed: ImagePathCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of findImagePathCandidates(text)) {
    const absolutePath = resolveImagePath(candidate.value, cwd);
    let details;
    try {
      details = await stat(absolutePath);
    } catch {
      continue;
    }
    if (!details.isFile()) continue;
    consumed.push(candidate);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    if (images.length >= maxImages) {
      errors.push(`Only ${maxImages} images can be attached to one message.`);
      continue;
    }
    if (details.size === 0) {
      errors.push(`Image is empty: ${absolutePath}`);
      continue;
    }
    if (details.size > maxImageBytes) {
      errors.push(
        `Image is too large: ${absolutePath} (${formatBytes(details.size)}; limit ${formatBytes(maxImageBytes)}).`,
      );
      continue;
    }
    try {
      const bytes = await readFile(absolutePath);
      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) {
        errors.push(`Unsupported or invalid image: ${absolutePath}`);
        continue;
      }
      images.push({ type: "image", data: bytes.toString("base64"), mimeType });
      paths.push(absolutePath);
    } catch (error) {
      errors.push(
        `Could not read image ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (consumed.length === 0) return { text, images, paths, errors };
  const remainingText = removeCandidates(text, consumed).trim();
  const references = paths.map((_imagePath, index) => `[Image #${index + 1}]`);
  return {
    text: [...references, remainingText || "Describe the attached image."].join("\n"),
    images,
    paths,
    errors,
  };
}

export function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  return undefined;
}

function findImagePathCandidates(text: string): ImagePathCandidate[] {
  const candidates: ImagePathCandidate[] = [];
  for (const match of text.matchAll(IMAGE_PATH_PATTERN)) {
    const prefix = match[1] ?? "";
    const raw = match[2];
    if (!raw || match.index === undefined) continue;
    candidates.push({
      raw,
      value: unwrapPath(raw),
      start: match.index + prefix.length,
      end: match.index + prefix.length + raw.length,
    });
  }
  return candidates;
}

function unwrapPath(raw: string): string {
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  const first = withoutAt[0];
  return (first === '"' || first === "'") && withoutAt.at(-1) === first
    ? withoutAt.slice(1, -1)
    : withoutAt;
}

function resolveImagePath(value: string, cwd: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function removeCandidates(text: string, candidates: ImagePathCandidate[]): string {
  let result = text;
  for (const candidate of [...candidates].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, candidate.start)}${result.slice(candidate.end)}`;
  }
  return result.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
