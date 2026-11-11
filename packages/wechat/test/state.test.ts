import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WeChatStateStore } from "../src/state.ts";
import { loadWeChatCredentials, saveWeChatCredentials } from "../src/credentials.ts";
import type { WeixinMessage } from "../src/protocol.ts";

const directories: string[] = [];
const stores: WeChatStateStore[] = [];
function directory() { const result = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-wechat-state-")); directories.push(result); return result; }
function state(dir = directory(), account = "bot", owner = "owner", now = Date.now) {
  const store = new WeChatStateStore(dir, account, owner, now); stores.push(store); return store;
}
function message(id: string, from = "owner"): WeixinMessage {
  return { message_id: id, from_user_id: from, message_type: 1, context_token: `token-${id}`, item_list: [{ type: 1, text_item: { text: id } }] };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("WeChat durable state", () => {
  it("commits cursor with pending input, recovers pending only, and dedupes after restart", () => {
    const dir = directory();
    let store = state(dir);
    store.accept([message("pending"), message("running"), message("admitting")], "cursor-1");
    store.admit(["running", "admitting"]); store.accepted(["running"], "turn-1");
    store.putQuote("owner", "server-id", "original text", ["uploads/a.txt"]);
    store.close(); store = state(dir);
    expect(store.cursor).toBe("cursor-1");
    expect(store.pending().map(row => row.id)).toEqual(["pending"]);
    expect(store.status("running")).toBe("interrupted");
    expect(store.status("admitting")).toBe("interrupted");
    expect(store.interruptedCount).toBe(2);
    expect(store.accept([message("pending"), message("running")], "cursor-2")).toEqual([]);
    expect(store.contextToken("owner")).toBe("token-admitting");
    expect(store.quote("owner", "server-id")).toMatchObject({ body: "original text", paths: ["uploads/a.txt"] });
  });
  it("rolls back inbox, token and cursor together when a batch cannot be persisted", () => {
    const store = state();
    const circular = message("bad") as WeixinMessage & { circular?: unknown };
    circular.circular = circular;
    expect(() => store.accept([message("first"), circular], "must-not-advance")).toThrow();
    expect(store.cursor).toBe("");
    expect(store.pending()).toEqual([]);
    expect(store.contextToken("owner")).toBeUndefined();
  });
  it("rejects non-owner/bot/malformed events and isolates account and owner state", () => {
    const dir = directory(); const store = state(dir);
    store.accept([message("foreign", "stranger"), { ...message("echo"), message_type: 2 }, { ...message("no-context"), context_token: "" }], "next");
    expect(store.pending()).toEqual([]); expect(store.contextToken("stranger")).toBeUndefined();
    store.accept([message("ours")], "ours"); store.putQuote("owner", "quote", "private", []);
    expect(state(dir, "other-bot").cursor).toBe("");
    expect(state(dir, "bot", "other-owner").quote("owner", "quote")).toBeUndefined();
    expect(store.quote("stranger", "quote")).toBeUndefined();
  });
  it("expires quote metadata without deleting workspace attachments", () => {
    const dir = directory(); const file = path.join(dir, "user-file.txt"); fs.writeFileSync(file, "keep");
    let now = 1000; const store = state(dir, "bot", "owner", () => now);
    store.putQuote("owner", "old", "old", [file]);
    now += 31 * 24 * 60 * 60 * 1000;
    store.putQuote("owner", "new", "new", []);
    expect(store.quote("owner", "old")).toBeUndefined(); expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });
  it("does not regress a terminal record when acceptance completes after the terminal event", () => {
    const store = state(); store.accept([message("1")], "cursor"); store.admit(["1"]);
    store.finish(["1"], "completed"); store.accepted(["1"], "late-turn");
    expect(store.status("1")).toBe("completed");
  });
  it("requires an owner identity and stores credentials privately", () => {
    const home = directory();
    expect(loadWeChatCredentials(home)).toBeUndefined();
    const value = { accountId: "bot", ownerId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", savedAt: new Date().toISOString() };
    expect(() => saveWeChatCredentials(home, { ...value, ownerId: "" })).toThrow("ownerId");
    saveWeChatCredentials(home, value);
    expect(loadWeChatCredentials(home)).toEqual(value);
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "channels/wechat/credentials.json")).mode & 0o777).toBe(0o600);
  });
  it("retains incomplete delivery diagnostics without making an outbox to replay", () => {
    const dir = directory(); let store = state(dir);
    store.beginDelivery("unfinished"); store.beginDelivery("sent"); store.finishDelivery("sent", "delivered");
    store.close(); store = state(dir);
    expect(store.deliveryStatus("unfinished")).toBe("abandoned");
    expect(store.deliveryStatus("sent")).toBe("delivered");
    expect(store.pending()).toEqual([]);
  });
  it("claims all source messages atomically and rejects a second admission", () => {
    const store = state(); store.accept([message("one"), message("two")], "cursor");
    store.admit(["two"]);
    expect(() => store.admit(["one", "two"])).toThrow("already admitted");
    expect(store.status("one")).toBe("pending");
  });
  it("uses the item message ID if the envelope message_id is absent", () => {
    const store = state(); const input = message("envelope"); delete input.message_id;
    input.item_list = [{ type: 1, msg_id: "18446744073709551615", text_item: { text: "work" } }];
    const accepted = store.accept([input], "cursor");
    expect(accepted[0]?.id).toBe("18446744073709551615");
    expect(store.pending()[0]?.message.message_id).toBe("18446744073709551615");
  });
});
