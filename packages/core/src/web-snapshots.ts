import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { getDSCodeHome } from "./home.ts";
import { getWebSnapshotRetentionDays } from "./settings.ts";

export const WEB_SNAPSHOT_ENTRY = "dscode-web-snapshot";
const idSchema = z.string().uuid();
const referenceSchema = z.object({
  id: idSchema,
  url: z.string(),
  title: z.string(),
  created_at: z.string(),
  source: z.enum(["search", "fetch"]),
});
const snapshotSchema = referenceSchema.extend({ content: z.string() });
export type WebSnapshot = z.infer<typeof snapshotSchema>;
export type WebSnapshotReference = z.infer<typeof referenceSchema>;

// Reload replaces extension instances, but keeps the SessionManager. Weak keys
// retain non-persistent pages across reload without keeping closed sessions alive.
const sessionPages = new WeakMap<ExtensionContext["sessionManager"], Map<string, WebSnapshot>>();
const displayLines = new WeakMap<WebSnapshot, string[]>();
function pagesFor(ctx: ExtensionContext): Map<string, WebSnapshot> {
  let pages = sessionPages.get(ctx.sessionManager);
  if (!pages) {
    pages = new Map();
    sessionPages.set(ctx.sessionManager, pages);
  }
  return pages;
}

export class WebSnapshotStore {
  private readonly directory: string;

  constructor(directory = path.join(getDSCodeHome(), "web-snapshots")) {
    this.directory = directory;
  }

  async cleanup(retentionDays = getWebSnapshotRetentionDays()): Promise<void> {
    if (retentionDays === 0) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !idSchema.safeParse(entry.name.slice(0, -5)).success) continue;
      const file = path.join(this.directory, entry.name);
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        // Cleanup is best effort; inaccessible files and concurrent cleanup must not block startup.
      }
    }
  }

  references(ctx: ExtensionContext): WebSnapshotReference[] {
    return ctx.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== WEB_SNAPSHOT_ENTRY) return [];
      const parsed = referenceSchema.safeParse(entry.data);
      return parsed.success ? [parsed.data] : [];
    });
  }

  latest(ctx: ExtensionContext, url: string): WebSnapshotReference | undefined {
    return this.references(ctx).findLast((entry) => entry.url === url);
  }

  async save(
    page: { url: string; title: string; content: string; source: "search" | "fetch" },
    ctx: ExtensionContext,
  ): Promise<WebSnapshot> {
    const snapshot: WebSnapshot = { ...page, id: randomUUID(), created_at: new Date().toISOString() };
    if (ctx.sessionManager.getSessionFile() !== undefined) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Immutable files also allow forked sessions to share historical references.
      await fs.writeFile(path.join(this.directory, `${snapshot.id}.json`), JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
    }
    pagesFor(ctx).set(snapshot.id, snapshot);
    return snapshot;
  }

  async read(ctx: ExtensionContext, id: string): Promise<WebSnapshot> {
    idSchema.parse(id);
    if (!this.references(ctx).some((entry) => entry.id === id)) {
      throw new Error("Web snapshot does not belong to this session");
    }
    const cached = pagesFor(ctx).get(id);
    if (cached) return cached;
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, `${id}.json`), "utf8")));
      if (snapshot.id !== id) throw new Error("Web snapshot ID mismatch");
      pagesFor(ctx).set(id, snapshot);
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Web snapshot is unavailable. Fetch the URL with refresh: true to create a new version.");
      }
      throw error;
    }
  }
}

export function snapshotReference(snapshot: WebSnapshot): WebSnapshotReference {
  const { content: _content, ...reference } = snapshot;
  return reference;
}

export function readSnapshotPage(snapshot: WebSnapshot, offset = 1, limit = 200) {
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error("offset must be a positive line number; limit must be between 1 and 2000");
  }
  // Wrap exceptional long lines for display so every byte remains reachable
  // under the per-result limit. The stored original Markdown stays unchanged.
  let lines = displayLines.get(snapshot);
  if (!lines) {
    lines = snapshot.content.split("\n").flatMap((line) => {
      if (line.length <= 4000) return [line];
      const wrapped: string[] = [];
      let start = 0;
      let characters = 0;
      for (let index = 0; index < line.length;) {
        index += line.codePointAt(index)! > 0xffff ? 2 : 1;
        if (++characters === 4000) {
          wrapped.push(line.slice(start, index));
          start = index;
          characters = 0;
        }
      }
      if (start < line.length) wrapped.push(line.slice(start));
      return wrapped;
    });
    displayLines.set(snapshot, lines);
  }
  if (offset > lines.length) throw new Error(`offset exceeds the ${lines.length} display lines in this snapshot`);
  const selected: string[] = [];
  let bytes = 0;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const numbered = `${i + 1}: ${lines[i]!}`;
    const size = Buffer.byteLength(numbered, "utf8") + 1;
    if (bytes + size > 50 * 1024) break;
    selected.push(numbered);
    bytes += size;
  }
  const end = offset + selected.length - 1;
  const { id, ...reference } = snapshotReference(snapshot);
  return {
    ...reference,
    snapshot_id: id,
    total_lines: lines.length,
    start_line: offset,
    end_line: end,
    next_offset: end < lines.length ? end + 1 : null,
    content: selected.join("\n"),
  };
}
