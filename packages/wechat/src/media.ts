import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WeChatDownloadedMedia } from "./api.ts";

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ".png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ".jpg";
  if (/^GIF8[79]a/u.test(bytes.subarray(0, 6).toString("ascii"))) return ".gif";
  if (bytes.subarray(0,4).toString("ascii") === "RIFF" && bytes.subarray(8,12).toString("ascii") === "WEBP") return ".webp";
  return ".bin";
}

export async function resolveWeChatWorkspaceFile(workspace: string, relative: string): Promise<string | undefined> {
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) return undefined;
  try {
    const root = await realpath(workspace);
    const file = await realpath(path.resolve(root, relative));
    return file.startsWith(root + path.sep) ? file : undefined;
  } catch { return undefined; }
}

export async function storeWeChatMedia(workspace: string, media: WeChatDownloadedMedia): Promise<string> {
  const root = await realpath(workspace);
  const uploads = path.join(root, "uploads");
  await mkdir(uploads, { recursive: true });
  const uploadReal = await realpath(uploads);
  if (!uploadReal.startsWith(root + path.sep)) throw new Error("Uploads directory leaves workspace");
  let name = path.basename(media.name.replaceAll("\\", "/"))
    .replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/u, "").slice(-100) || "attachment";
  if (media.kind === "image") name = `image${imageExtension(media.buffer)}`;
  const filename = `wechat-${randomUUID()}-${name}`;
  await writeFile(path.join(uploadReal, filename), media.buffer, { mode: 0o600, flag: "wx" });
  return `uploads/${filename}`;
}
