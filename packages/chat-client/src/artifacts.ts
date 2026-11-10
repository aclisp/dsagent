import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ChatOutboundMediaKind = "image" | "file";
export const MAX_OUTBOUND_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_OUTBOUND_MEDIA_COUNT = 5;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
function safePositiveLimit(value: number | undefined, fallback: number): number {
 return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface ChatOutboundArtifact {
  kind: ChatOutboundMediaKind;
  name: string;
  path: string;
  size: number;
  buffer: Buffer;
}

export interface SkippedChatOutboundArtifact {
  path: string;
  reason:
    | "invalid_path"
    | "not_found"
    | "too_large"
    | "too_many"
    | "unreadable";
}

export interface CollectChatOutboundArtifactsResult {
  artifacts: ChatOutboundArtifact[];
  skipped: SkippedChatOutboundArtifact[];
}

function looksLikeFilePathToken(value: string): boolean {
  if (value.length === 0 || /\s/u.test(value)) return false;
  if (/[#?@<>=&|:]/u.test(value)) return false;
  return value.includes("/") || /^[^\s.].*\.[A-Za-z0-9]{1,10}$/u.test(value);
}

function normalizeCitedPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!looksLikeFilePathToken(trimmed)) return undefined;
  const relative = trimmed.replace(/^\/workspace\//u, "");
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    relative === ".." ||
    relative.includes("\\")
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(relative);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\\")
  ) {
    return undefined;
  }
  return normalized;
}

async function resolveWorkspaceFile(
  workspacePath: string,
  relativePath: string,
): Promise<string | undefined> {
  let workspaceReal: string;
  try {
    workspaceReal = await realpath(workspacePath);
  } catch {
    return undefined;
  }
  let candidateReal: string;
  try {
    candidateReal = await realpath(path.resolve(workspacePath, relativePath));
  } catch {
    return undefined;
  }
  const within =
    candidateReal === workspaceReal ||
    candidateReal.startsWith(workspaceReal + path.sep);
  return within ? candidateReal : undefined;
}

function outboundKindForPath(relativePath: string): ChatOutboundMediaKind {
  return IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ? "image"
    : "file";
}

/**
 * Extract only explicit inline path citations from assistant output. We do not
 * scan the workspace: sending an artifact must be an intentional Agent action.
 */
export async function collectChatOutboundArtifacts(
  text: string,
  workspacePath: string,
  options: {
    maxBytes?: number;
    maxCount?: number;
  } = {},
): Promise<CollectChatOutboundArtifactsResult> {
  const maxBytes = safePositiveLimit(
    options.maxBytes,
    MAX_OUTBOUND_MEDIA_BYTES,
  );
  const maxCount = safePositiveLimit(
    options.maxCount,
    MAX_OUTBOUND_MEDIA_COUNT,
  );
  const artifacts: ChatOutboundArtifact[] = [];
  const skipped: SkippedChatOutboundArtifact[] = [];
  const seen = new Set<string>();
  // Match inline code only, mirroring Chat UI linkification; paths inside a
  // fenced code block are examples, not delivery requests.
  const citationPattern = /(?<!`)`([^`\r\n]+)`(?!`)/gu;

  for (const match of text.matchAll(citationPattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const relativePath = normalizeCitedPath(raw);
    if (relativePath === undefined || seen.has(relativePath)) continue;
    seen.add(relativePath);
    if (artifacts.length >= maxCount) {
      skipped.push({ path: relativePath, reason: "too_many" });
      continue;
    }

    const absolutePath = await resolveWorkspaceFile(workspacePath, relativePath);
    if (absolutePath === undefined) {
      skipped.push({ path: relativePath, reason: "not_found" });
      continue;
    }
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      skipped.push({ path: relativePath, reason: "unreadable" });
      continue;
    }
    if (!info.isFile()) {
      skipped.push({ path: relativePath, reason: "invalid_path" });
      continue;
    }
    if (info.size > maxBytes) {
      skipped.push({ path: relativePath, reason: "too_large" });
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      skipped.push({ path: relativePath, reason: "unreadable" });
      continue;
    }
    if (buffer.byteLength > maxBytes) {
      skipped.push({ path: relativePath, reason: "too_large" });
      continue;
    }
    artifacts.push({
      kind: outboundKindForPath(relativePath),
      name: path.basename(relativePath),
      path: relativePath,
      size: buffer.byteLength,
      buffer,
    });
  }

  return { artifacts, skipped };
}
