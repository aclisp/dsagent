// Verify the shared store against Bun's backend and Node's on-disk SQLite reader.
// Run with the pinned Bun: bun standalone/test/wechat-state.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(path.join(os.tmpdir(), "dscode-wechat-sqlite-"));
try {
  const file = path.join(root, `${createHash("sha256").update(JSON.stringify(["account", "owner"])).digest("hex").slice(0, 32)}.sqlite`);
  const node = code => execFileSync("node", ["--input-type=module", "-e", code, file], { encoding: "utf8" });
  node(`import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('cursor','from-node'); db.close();`);
  const built = await Bun.build({
    entrypoints: [path.join(repo, "packages/wechat/src/state.ts")], target: "bun", outdir: path.join(root, "bundle"),
    plugins: [{ name: "wechat-sqlite", setup(build) {
      build.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: path.join(repo, "standalone/wechat-sqlite.mjs") }));
    } }],
  });
  assert.ok(built.success, built.logs.map(String).join("\n"));
  const { WeChatStateStore } = await import(built.outputs[0].path);
  let store = new WeChatStateStore(root, "account", "owner");
  assert.equal(store.cursor, "from-node");
  const incoming = id => ({ message_id: id, message_type: 1, from_user_id: "owner", context_token: "context", item_list: [] });
  store.accept([incoming("running"), incoming("pending"), { ...incoming("foreign"), from_user_id: "stranger" }], "from-bun");
  assert.equal(store.status("foreign"), undefined);
  assert.throws(() => store.admit(["pending", "missing"]));
  assert.equal(store.status("pending"), "pending", "admission rollback must be atomic");
  store.putQuote("owner", "quoted", "quote body", ["uploads/example.png"]);
  store.admit(["running"]); store.accepted(["running"], "turn"); store.beginDelivery("delivery"); store.close();
  store = new WeChatStateStore(root, "account", "owner");
  assert.equal(store.cursor, "from-bun"); assert.equal(store.contextToken("owner"), "context");
  assert.equal(store.status("running"), "interrupted"); assert.equal(store.deliveryStatus("delivery"), "abandoned");
  assert.deepEqual(store.pending().map(record => record.id), ["pending"]);
  assert.deepEqual(store.quote("owner", "quoted").paths, ["uploads/example.png"]); store.close();
  node(`import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='cursor'").get().value, 'from-bun');
    assert.equal(db.prepare("SELECT body FROM quotes WHERE id='quoted'").get().body, 'quote body');
    assert.equal(db.prepare("SELECT state FROM inbox WHERE id='running'").get().state, 'interrupted'); db.close();`);
  console.log("WeChat Bun/Node SQLite interoperability, atomic admission and crash recovery passed");
} finally { await rm(root, { recursive: true, force: true }); }
