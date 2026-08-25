import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";

export interface RegisterFileRoutesOptions {
  maxUploadBytes: number;
}

/**
 * Workspace-scoped file upload/download endpoints. The adapter stays a pure agent
 * API; these are web-ui layer (uploads land under `<workspace>/uploads/`).
 */
export function registerFileRoutes(
  server: FastifyInstance,
  workspaces: Readonly<Record<string, string>>,
  options: RegisterFileRoutesOptions,
): void {
  const { maxUploadBytes } = options;

  server.post<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/files",
    { bodyLimit: maxUploadBytes },
    async (request, reply) => {
      const cwd = workspaces[request.params.workspaceId];
      if (!cwd) return reply.code(404).send({ error: "workspace_not_found" });
      if (!request.isMultipart()) {
        return reply.code(400).send({ error: "invalid_upload" });
      }

      const uploadDir = path.join(cwd, "uploads");
      await mkdir(uploadDir, { recursive: true });

      const files: { name: string; path: string; size: number }[] = [];
      let invalidName = false;
      try {
        for await (const part of request.files({
          limits: { fileSize: maxUploadBytes },
          throwFileSizeLimit: true,
        })) {
          const name = sanitizeFilename(part.filename);
          if (name === undefined) {
            invalidName = true;
            part.file.resume();
            continue;
          }
          const target = path.join(uploadDir, name);
          await pipeline(part.file, createWriteStream(target));
          files.push({ name, path: `uploads/${name}`, size: part.file.bytesRead });
        }
      } catch (error) {
        if (isRequestFileTooLarge(error)) {
          return reply.code(413).send({ error: "upload_too_large" });
        }
        throw error;
      }
      if (invalidName || files.length === 0) {
        return reply.code(400).send({ error: "invalid_upload" });
      }
      return reply.code(201).send({ files });
    },
  );

  server.get<{ Params: { workspaceId: string; "*": string } }>(
    "/share/:workspaceId/*",
    async (request, reply) => {
      const cwd = workspaces[request.params.workspaceId];
      if (!cwd) return reply.code(404).send({ error: "workspace_not_found" });
      const rel = request.params["*"];
      if (rel === undefined || rel.length === 0 || path.isAbsolute(rel)) {
        return reply.code(400).send({ error: "invalid_path" });
      }

      const resolved = await resolveWithinWorkspace(cwd, rel);
      if (!resolved) return reply.code(404).send({ error: "file_not_found" });
      const info = await stat(resolved);
      if (!info.isFile()) return reply.code(404).send({ error: "file_not_found" });

      const name = path.basename(resolved);
      reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Type", contentTypeFor(name))
        .header("Content-Disposition", contentDisposition(name));
      return reply.send(createReadStream(resolved));
    },
  );
}

/** Reject path-like filenames outright; only a bare basename is accepted. */
function sanitizeFilename(filename: string): string | undefined {
  const name = filename.trim();
  if (name.length === 0 || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\")) return undefined;
  return name;
}

/** Resolve a workspace-relative path and verify it stays inside the workspace. */
async function resolveWithinWorkspace(
  cwd: string,
  rel: string,
): Promise<string | undefined> {
  let cwdReal: string;
  try {
    cwdReal = await realpath(cwd);
  } catch {
    return undefined;
  }
  let candidateReal: string;
  try {
    candidateReal = await realpath(path.resolve(cwd, rel));
  } catch {
    return undefined;
  }
  const within =
    candidateReal === cwdReal || candidateReal.startsWith(cwdReal + path.sep);
  return within ? candidateReal : undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  // Browsers do not provide a built-in viewer for application/yaml. Serve YAML
  // as safe plain text so inline share links render instead of downloading.
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function contentTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Workspace URLs are bearer share links. Keep browser-consumable HTML/H5 assets
// inline so shared pages can load their relative scripts, styles, fonts, and media.
const INLINE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".svg",
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".yaml",
  ".yml",
  ".webmanifest",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
  ".docx",
  ".xlsx",
  ".pptx",
]);

function contentDisposition(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const disposition = INLINE_EXTENSIONS.has(ext) ? "inline" : "attachment";
  if (/^[\x20-\x7e]*$/.test(name)) return `${disposition}; filename="${name}"`;
  const encoded = encodeURIComponent(name).replace(/['*]/g, (char) =>
    char === "'" ? "%27" : "%2A",
  );
  return `${disposition}; filename*=UTF-8''${encoded}`;
}

function isRequestFileTooLarge(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === "FST_REQ_FILE_TOO_LARGE";
}
