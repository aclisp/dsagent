import { Database } from "bun:sqlite";

// Only the synchronous API used by WeChatStateStore. Bun 1.3.14 does not expose
// node:sqlite. Keep the schema, transactions and on-disk format shared with Node.
// https://bun.sh/docs/runtime/sqlite
export class DatabaseSync {
  constructor(file) { this.database = new Database(file, { strict: true }); }
  exec(sql) { this.database.exec(sql); }
  // Cached statements belong to the database and are finalized on close.
  prepare(sql) { return this.database.query(sql); }
  close() { this.database.close(true); }
}
