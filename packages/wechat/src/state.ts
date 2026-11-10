import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "./credentials.ts";
import type { WeixinMessage } from "./protocol.ts";
import { weChatMessageIds } from "./identity.ts";

export interface WeChatQuote { body: string; paths: string[]; createdAt: number }
export interface WeChatInboundRecord { id: string; message: WeixinMessage }
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10_000;

/** Cursor, recoverable inbox, dedupe and quote metadata share transactional storage.
 * No output queue is persisted, and cleanup never removes workspace files. */
export class WeChatStateStore {
  private readonly db: DatabaseSync;
  private closed = false;
  readonly interruptedCount: number;

  private readonly ownerId: string;
  private readonly now: () => number;
  constructor(directory: string, accountId: string, ownerId: string, now = Date.now) {
    this.ownerId = ownerId;
    this.now = now;
    ensurePrivateDirectory(directory);
    const key = createHash("sha256").update(JSON.stringify([accountId, ownerId])).digest("hex").slice(0, 32);
    const file = path.join(directory, `${key}.sqlite`);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) {
      throw new Error("WeChat state database must be a regular file");
    }
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (
          id TEXT PRIMARY KEY, message TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
          turn_id TEXT
        );
        CREATE TABLE IF NOT EXISTS tokens (peer TEXT PRIMARY KEY, token TEXT NOT NULL, updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS quotes (
          peer TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, paths TEXT NOT NULL, created INTEGER NOT NULL,
          PRIMARY KEY(peer,id)
        );
        CREATE INDEX IF NOT EXISTS quotes_created ON quotes(created);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL);
        UPDATE deliveries SET state='abandoned' WHERE state='sending';`);
      this.db.prepare("UPDATE inbox SET state='interrupted' WHERE state IN ('admitting','running')").run();
      this.interruptedCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE state='interrupted'").get() as { count: number }).count);
      this.prune();
    } catch (error) { this.db.close(); throw error; }
  }

  get cursor(): string {
    return (this.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as { value: string } | undefined)?.value ?? "";
  }

  /** Invalid/foreign messages are consumed with the cursor but never cached or dispatched. */
  accept(messages: WeixinMessage[], cursor?: string): WeChatInboundRecord[] {
    return this.transaction(() => {
      const added: WeChatInboundRecord[] = [];
      for (const message of messages) {
        if (message.message_type !== 1 || message.from_user_id !== this.ownerId ||
          Boolean(message.group_id) ||
          typeof message.context_token !== "string" || !message.context_token.trim() ||
          !Array.isArray(message.item_list)) continue;
        const id = weChatMessageIds(message)[0];
        if (!id) continue;
        const normalized = { ...message, message_id: id };
        const result = this.db.prepare("INSERT OR IGNORE INTO inbox (id,message,state,created) VALUES (?,?,'pending',?)")
          .run(id, JSON.stringify(normalized), this.now());
        if (result.changes === 0) continue;
        const created = typeof message.create_time_ms === "number" && Number.isFinite(message.create_time_ms)
          ? message.create_time_ms : this.now();
        this.db.prepare(`INSERT INTO tokens VALUES (?,?,?) ON CONFLICT(peer) DO UPDATE SET
          token=excluded.token, updated=excluded.updated WHERE excluded.updated >= tokens.updated`)
          .run(this.ownerId, message.context_token, created);
        added.push({ id, message: normalized });
      }
      if (typeof cursor === "string" && cursor) {
        this.db.prepare("INSERT INTO meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor);
      }
      return added;
    });
  }

  pending(): WeChatInboundRecord[] {
    return (this.db.prepare("SELECT id,message FROM inbox WHERE state='pending' ORDER BY created,rowid").all() as { id: string; message: string }[])
      .map(row => ({ id: row.id, message: JSON.parse(row.message) as WeixinMessage }));
  }

  admit(ids: readonly string[]): void {
    this.transition(ids, "admitting", "pending");
  }
  accepted(ids: readonly string[], turnId: string): void {
    this.transaction(() => {
      for (const id of ids) this.db.prepare("UPDATE inbox SET state='running',turn_id=? WHERE id=? AND state='admitting'").run(turnId, id);
    });
  }
  finish(ids: readonly string[], status: string): void {
    this.transaction(() => {
      for (const id of ids) this.db.prepare("UPDATE inbox SET state=?,message='{}' WHERE id=?").run(status, id);
    });
    this.prune();
  }
  status(id: string): string | undefined {
    return (this.db.prepare("SELECT state FROM inbox WHERE id=?").get(id) as { state: string } | undefined)?.state;
  }
  contextToken(peer: string): string | undefined {
    return (this.db.prepare("SELECT token FROM tokens WHERE peer=?").get(peer) as { token: string } | undefined)?.token;
  }
  beginDelivery(id: string): void {
    this.db.prepare("INSERT INTO deliveries VALUES (?,'sending',?) ON CONFLICT(id) DO NOTHING").run(id, this.now());
  }
  finishDelivery(id: string, status: string): void {
    if (!this.closed) this.db.prepare("UPDATE deliveries SET state=? WHERE id=?").run(status, id);
  }
  deliveryStatus(id: string): string | undefined {
    return (this.db.prepare("SELECT state FROM deliveries WHERE id=?").get(id) as { state: string } | undefined)?.state;
  }
  putQuote(peer: string, id: string, body: string, paths: readonly string[]): void {
    if (peer !== this.ownerId || !id) return;
    this.db.prepare(`INSERT INTO quotes VALUES (?,?,?,?,?) ON CONFLICT(peer,id) DO UPDATE SET
      body=excluded.body, paths=excluded.paths, created=excluded.created`)
      .run(peer, id, body, JSON.stringify(paths), this.now());
    this.prune();
  }
  quote(peer: string, id: string): WeChatQuote | undefined {
    if (peer !== this.ownerId) return undefined;
    const row = this.db.prepare("SELECT body,paths,created FROM quotes WHERE peer=? AND id=? AND created>?")
      .get(peer, id, this.now() - RETENTION_MS) as { body: string; paths: string; created: number } | undefined;
    return row ? { body: row.body, paths: JSON.parse(row.paths) as string[], createdAt: row.created } : undefined;
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private transition(ids: readonly string[], state: string, previous: string): void {
    this.transaction(() => {
      for (const id of ids) {
        const changed = this.db.prepare("UPDATE inbox SET state=? WHERE id=? AND state=?").run(state, id, previous);
        if (Number(changed.changes) !== 1) throw new Error("WeChat input was already admitted or settled");
      }
    });
  }
  private prune(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM quotes WHERE created <= ?").run(this.now() - RETENTION_MS);
      this.db.prepare("DELETE FROM deliveries WHERE state!='sending' AND created<=?").run(this.now() - RETENTION_MS);
      this.db.exec(`DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE state!='sending'
        ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ${MAX_RECORDS});`);
      this.db.exec(`DELETE FROM quotes WHERE rowid IN (
        SELECT rowid FROM quotes ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ${MAX_RECORDS});`);
      this.db.prepare("DELETE FROM inbox WHERE state NOT IN ('pending','admitting','running') AND created<=?")
        .run(this.now() - RETENTION_MS);
      this.db.exec(`DELETE FROM inbox WHERE id IN (SELECT id FROM inbox
        WHERE state NOT IN ('pending','admitting','running') ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ${MAX_RECORDS});`);
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
