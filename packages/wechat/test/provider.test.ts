import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, raw, image, file, text } from "./helpers.ts";
import { WeChatApiError } from "../src/api.ts";
import { WeChatStateStore } from "../src/state.ts";
import { createWeChatChatProviderFromHome } from "../src/wechat-chat-provider.ts";
import type { ChatConversation } from "../../chat-client/src/index.ts";

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
async function harness(root?: string, deferStart = false) { const h = await createHarness(root, deferStart); harnesses.push(h); return h; }
afterEach(async () => {
  const active = harnesses.splice(0);
  for (const h of active) await h.close(false);
  for (const root of new Set(active.map(h => h.root))) await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const conversation: ChatConversation = { providerId: "wechat", type: "direct", address: "owner" };

describe("WeChat Provider over the shared Chat Client", () => {
  it("prepares private state without polling, consuming messages or notifying the server before commit", async () => {
    const h = await harness(undefined, true);
    const commit = h.provider.prepare();
    h.api.push([raw("held")]);
    expect(h.api.cursors).toEqual([]); expect(h.api.notify).not.toHaveBeenCalled();
    expect(h.port.prompts).toEqual([]); expect(h.provider.resourceKey).toBe("wechat:bot");
    const states: string[] = []; h.provider.subscribeStatus(status => states.push(status));
    commit();
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    expect(states).toContain("connecting"); expect(h.provider.getStatus()).toBe("connected");
  });

  it("uses opaque prompt identities, reports typing and replies with the original token", async () => {
    const h = await harness(); h.api.push([raw("first", [text("检查项目")])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    expect(h.port.prompts[0]).toMatch(/^\[IM message: direct=conv-/u);
    expect(h.port.prompts[0]).toContain("检查项目");
    expect(h.port.prompts[0]).not.toMatch(/owner|context-first|secret-bot-token/u);
    await vi.waitFor(() => expect(h.api.sendTyping).toHaveBeenCalledWith("owner", "typing-ticket", 1, expect.anything()));
    h.api.push([raw("busy", [text("再做一项")])]);
    await vi.waitFor(() => expect(h.api.sendItem.mock.calls.some(call => call[1].text_item?.text?.includes("正在处理其他工作"))).toBe(true));
    expect(h.port.prompts).toHaveLength(1);
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "完成 https://example.com/chat/abcdefghijklmnop1234567890" });
    const reply = h.api.sendItem.mock.calls.find(call => call[1].text_item?.text?.startsWith("完成"));
    expect(reply?.[2]).toBe("context-first");
    expect(reply?.[1].text_item?.text).toContain("私密链接已隐藏");
    expect(h.api.sendTyping).toHaveBeenCalledWith("owner", "typing-ticket", 2, expect.anything());
  });

  it("merges attachment bursts and following instructions, preserving each original quote", async () => {
    const h = await harness();
    h.api.push([raw("image-1", [image()]), raw("image-2", [image()]), raw("instruction", [text("比较这两张图")])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    const prompt = h.port.prompts[0]!;
    expect(prompt).toContain("比较这两张图");
    expect(prompt.match(/uploads\/wechat-/gu)).toHaveLength(2);
    expect(h.api.download).toHaveBeenCalledTimes(2);
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "比较完成" });
    h.api.push([raw("quote", [{ type: 1, text_item: { text: "只看第一张" }, ref_msg: { svr_id: "image-1" } }])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(2));
    expect(h.port.prompts[1]!.match(/uploads\/wechat-/gu)).toHaveLength(1);
    expect(h.api.download).toHaveBeenCalledTimes(2);
  });

  it("filters foreign users, echoes and unusable identities before dispatch or token caching", async () => {
    const h = await harness();
    h.api.push([{ ...raw("foreign"), from_user_id: "stranger" }, { ...raw("echo"), message_type: 2 }, { ...raw("no-context"), context_token: "" }]);
    await vi.waitFor(() => expect(h.api.cursors.length).toBeGreaterThan(1));
    expect(h.port.prompts).toEqual([]);
    expect(await h.provider.send(conversation, "hello")).toEqual({ status: "permanent_failure" });
    expect(await h.provider.send({ ...conversation, address: "stranger" }, "hello")).toEqual({ status: "permanent_failure" });
    expect(h.api.sendItem).not.toHaveBeenCalled();
  });

  it("rejects an entire batch if one current attachment fails preparation", async () => {
    const h = await harness();
    h.api.download.mockImplementation(async item => {
      if (item.file_item?.file_name === "bad.txt") throw new Error("private signed CDN URL");
      return { buffer: Buffer.from("good"), name: "good.txt", kind: "file" };
    });
    h.api.push([raw("good", [file("good.txt")]), raw("bad", [file("bad.txt")]), raw("compare", [text("比较文件")])]);
    await vi.waitFor(() => expect(h.api.sendItem).toHaveBeenCalled());
    expect(h.port.prompts).toEqual([]);
    expect(h.api.sendItem.mock.calls[0]![1].text_item?.text).toContain("附件读取失败");
    expect(h.api.sendItem.mock.calls[0]![1].text_item?.text).not.toContain("private");
  });

  it("uses voice transcripts and explicitly rejects untranscribed voice", async () => {
    const h = await harness(); h.api.push([raw("silent", [{ type: 3, voice_item: {} }])]);
    await vi.waitFor(() => expect(h.api.sendItem).toHaveBeenCalled());
    expect(h.port.prompts).toEqual([]);
    expect(h.api.sendItem.mock.calls[0]![1].text_item?.text).toContain("请改发文字");
    h.api.push([raw("voice", [{ type: 3, voice_item: { text: "查看订单" } }])]);
    await vi.waitFor(() => expect(h.port.prompts[0]).toContain("查看订单"));
  });

  it.each(["failed", "aborted"] as const)("cleans typing and notifies on %s", async status => {
    const h = await harness(); h.api.push([raw("request")]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    await vi.waitFor(() => expect(h.api.sendTyping).toHaveBeenCalled());
    await h.port.emit({ status, turnId: "turn-1" });
    expect(h.api.sendItem.mock.calls.some(call => call[1].text_item?.text?.includes(status === "failed" ? "处理失败" : "已中止"))).toBe(true);
    expect(h.api.sendTyping).toHaveBeenCalledWith("owner", "typing-ticket", 2, expect.anything());
  });

  it("restores pending input but never reruns admitted requests after restart", async () => {
    const h = await harness(); await h.close(false);
    const state = new WeChatStateStore(path.join(h.root, "state"), "bot", "owner");
    state.accept([raw("pending", [text("待提交的请求")]), raw("in-flight", [text("不能重跑的请求")])], "saved-cursor");
    state.admit(["in-flight"]); state.accepted(["in-flight"], "old-turn"); state.close();
    const restarted = await harness(h.root);
    await vi.waitFor(() => expect(restarted.port.prompts).toHaveLength(1));
    expect(restarted.port.prompts[0]).toContain("待提交的请求");
    expect(restarted.port.prompts[0]).not.toContain("不能重跑");
    expect(restarted.api.cursors[0]).toBe("saved-cursor");
    restarted.api.push([raw("pending"), raw("in-flight")]);
    await vi.waitFor(() => expect(restarted.api.cursors.length).toBeGreaterThan(1));
    expect(restarted.port.prompts).toHaveLength(1);
  });

  it("restores quoted text and file paths across restart without redownloading", async () => {
    const h = await harness(); h.api.push([raw("source-file", [file("contract.txt"), text("合同原文说明")])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "已收到合同" });
    await h.close(false);
    const restarted = await harness(h.root);
    restarted.api.push([raw("reference", [{ type: 1, text_item: { text: "按这个修改" }, ref_msg: { svr_id: "source-file" } }])]);
    await vi.waitFor(() => expect(restarted.port.prompts).toHaveLength(1));
    expect(restarted.port.prompts[0]).toContain("合同原文说明");
    expect(restarted.port.prompts[0]).toContain("[Uploaded files:");
    expect(restarted.api.download).not.toHaveBeenCalled();
  });

  it("marks unavailable quotes without failing the current text request", async () => {
    const h = await harness();
    h.api.push([raw("reference", [{ type: 1, text_item: { text: "继续分析" }, ref_msg: { svr_id: "unknown" } }])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    expect(h.port.prompts[0]).toContain("引用消息暂不可用");
    expect(h.port.prompts[0]).toContain("继续分析");
  });
  it("restores references carried only in message_item.msg_id, including item ID aliases", async () => {
    const h = await harness();
    h.api.push([raw("envelope-id", [{ ...image(), msg_id: "image-server-id" }])]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "image received" });
    await h.close(false);
    const restarted = await harness(h.root);
    restarted.api.push([raw("reference", [{ type: 1, text_item: { text: "这是哪张图" },
      ref_msg: { message_item: { msg_id: "image-server-id" } } }])]);
    await vi.waitFor(() => expect(restarted.port.prompts).toHaveLength(1));
    expect(restarted.port.prompts[0]).toContain("[Uploaded files:");
    expect(restarted.port.prompts[0]).not.toContain("引用消息暂不可用");
    expect(restarted.api.download).not.toHaveBeenCalled();
  });

  it("retries only an unconfirmed file with the same client ID, keeping sent text/chunks", async () => {
    const h = await harness(); await fs.mkdir(path.join(h.workspace, "reports"));
    await fs.writeFile(path.join(h.workspace, "reports/result.txt"), "result");
    h.api.push([raw("request")]); await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    let failed = false;
    h.api.sendItem.mockImplementation(async (_peer, item) => {
      if (item.type === 4 && !failed) { failed = true; throw new WeChatApiError("temporary", -2, true); }
      return `sent-${h.api.sendItem.mock.calls.length}`;
    });
    await h.port.emit({ status: "completed", turnId: "turn-1", output: `${"字".repeat(2100)}\n\n文件：\`reports/result.txt\`` });
    const textCalls = h.api.sendItem.mock.calls.filter(call => call[1].type === 1);
    const fileCalls = h.api.sendItem.mock.calls.filter(call => call[1].type === 4);
    expect(textCalls).toHaveLength(2); expect(fileCalls).toHaveLength(2);
    expect(fileCalls[0]![3]).toBe(fileCalls[1]![3]);
    expect(h.api.upload).toHaveBeenCalledTimes(1);
  });

  it("uses restored context for scheduled output and reports permanent file failure", async () => {
    const h = await harness(); h.api.push([raw("bootstrap")]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "ready" });
    await fs.writeFile(path.join(h.workspace, "result.txt"), "artifact");
    h.api.upload.mockRejectedValue(new WeChatApiError("forbidden", 403));
    const listener = vi.fn(); expect(h.client.registerTurnForDelivery("scheduled", conversation, listener)).toBe(true);
    await h.port.emit({ status: "completed", turnId: "scheduled", output: "报告已生成：`result.txt`" });
    expect(listener).toHaveBeenCalledWith({ turnId: "scheduled", status: "failed" });
    expect(h.api.upload).toHaveBeenCalledTimes(1);
    expect(h.api.sendItem.mock.calls.filter(call => call[1].text_item?.text?.includes("部分文件发送失败"))).toHaveLength(1);
  });

  it("does not submit if durable admission fails", async () => {
    const h = await harness();
    vi.spyOn(WeChatStateStore.prototype, "admit").mockImplementationOnce(() => { throw new Error("disk full"); });
    h.api.push([raw("request")]);
    await vi.waitFor(() => expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("could not save private state")));
    expect(h.port.prompts).toEqual([]);
  });

  it("can explicitly disable the channel without reading missing credentials", async () => {
    const h = await harness();
    expect(createWeChatChatProviderFromHome({ homePath: h.root, workspacePath: h.workspace, enabled: "false" })).toBeUndefined();
    expect(() => createWeChatChatProviderFromHome({ homePath: h.root, workspacePath: h.workspace, enabled: "true" })).toThrow("not bound");
  });
  it("does not consume a legitimate reply reference when a foreign target is rejected", async () => {
    const h = await harness(); h.api.push([raw("request")]);
    await vi.waitFor(() => expect(h.port.prompts).toHaveLength(1));
    expect(await h.provider.reply({ messageId: "request", conversation: { ...conversation, address: "stranger" } }, "wrong target"))
      .toEqual({ status: "permanent_failure" });
    await h.port.emit({ status: "completed", turnId: "turn-1", output: "correct result" });
    expect(h.api.sendItem.mock.calls.some(call => call[1].text_item?.text === "correct result" && call[2] === "context-request")).toBe(true);
  });
});
