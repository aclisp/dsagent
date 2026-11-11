import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeChatApiClient } from "../src/api.ts";
import { loadWeChatCredentials } from "../src/credentials.ts";
import { loginWeChat } from "../src/login.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup(responses: unknown[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-wechat-login-")); directories.push(home);
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(responses.shift() ?? { status: "wait" })));
  const api = new WeChatApiClient({ fetchImpl });
  const io = { showQr: vi.fn(async (_content: string) => undefined), readCode: vi.fn(async () => "0123"), write: vi.fn() };
  return { home, fetchImpl, api, io, signal: new AbortController().signal, pollIntervalMs: 0 };
}
const qr = { qrcode: "opaque-qr", qrcode_img_content: "https://liteapp.weixin.qq.com/q/code" };
const confirmed = { status: "confirmed", bot_token: "secret-token", ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: "https://ilinkai.weixin.qq.com" };

describe("WeChat self-binding", () => {
  it("uses POST QR login, follows redirect, preserves leading PIN zeroes, and saves the owner", async () => {
    const h = setup([qr, { status: "scaned_but_redirect", redirect_host: "redirect.weixin.qq.com" },
      { status: "confirmed_but_need_verifycode" }, { status: "scaned" }, confirmed]);
    await loginWeChat(h);
    expect(h.fetchImpl.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(h.fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ local_token_list: [] });
    expect(String(h.fetchImpl.mock.calls[3]![0])).toContain("https://redirect.weixin.qq.com/");
    expect(String(h.fetchImpl.mock.calls[3]![0])).toContain("verify_code=0123");
    expect(String(h.fetchImpl.mock.calls[4]![0])).not.toContain("verify_code");
    expect(loadWeChatCredentials(h.home)).toMatchObject({ accountId: "bot", ownerId: "owner", token: "secret-token" });
    expect(h.io.write.mock.calls.flat().join(" ")).not.toContain("secret-token");
  });
  it("refreshes expired/blocked QR codes with the same self-binding payload", async () => {
    const h = setup([qr, { status: "expired" }, { ...qr, qrcode: "new" }, { status: "verify_code_blocked" }, qr, confirmed]);
    await loginWeChat(h);
    expect(h.io.showQr).toHaveBeenCalledTimes(3);
    expect(h.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });
  it("limits refreshes and leaves no credential file on failure", async () => {
    const h = setup([qr, { status: "expired" }, qr, { status: "expired" }, qr, { status: "expired" }]);
    await expect(loginWeChat(h)).rejects.toThrow("多次失效");
    expect(loadWeChatCredentials(h.home)).toBeUndefined();
  });
  it.each(["ilink_user_id", "ilink_bot_id", "bot_token"])("fails closed if confirmed lacks %s", async field => {
    const response: Record<string, unknown> = { ...confirmed }; delete response[field];
    const h = setup([qr, response]);
    await expect(loginWeChat(h)).rejects.toThrow("未保存绑定");
    expect(loadWeChatCredentials(h.home)).toBeUndefined();
  });
  it("cancels a pending login without writing credentials", async () => {
    const h = setup([qr, { status: "wait" }]);
    const controller = new AbortController();
    h.io.showQr.mockImplementationOnce(async () => { controller.abort(new Error("cancelled")); });
    await expect(loginWeChat({ ...h, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(loadWeChatCredentials(h.home)).toBeUndefined();
  });
});
