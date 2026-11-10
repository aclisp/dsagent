import type { MessageItem, WeixinMessage } from "./protocol.ts";
import type { WeChatApi } from "./api.ts";
import type { WeChatStateStore } from "./state.ts";
import { storeWeChatMedia, resolveWeChatWorkspaceFile } from "./media.ts";
import { resolvePartialQuote } from "./partial-quote.ts";
import { weChatMessageIds, weChatReferenceId } from "./identity.ts";

export function weChatText(message: WeixinMessage): string {
  return (message.item_list ?? []).flatMap(item => {
    const text = item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : undefined;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  }).join("\n");
}

export function weChatHasAttachments(message: WeixinMessage): boolean {
  return (message.item_list ?? []).some(item => item.type === 2 || item.type === 4);
}

export class WeChatPreparationError extends Error {
  constructor() { super("本次附件下载或解密失败，尚未开始处理。请重发附件和说明文字。"); }
}

export async function prepareWeChatBatch(options: {
  messages: readonly WeixinMessage[]; api: WeChatApi; state: WeChatStateStore;
  workspace: string; maxBytes: number; signal: AbortSignal;
}): Promise<string> {
  const { messages, api, state, workspace, maxBytes, signal } = options;
  const contents: string[] = [];
  const allPaths: string[] = [];
  // Stage every current attachment before writing quote entries or submitting a Turn.
  const prepared: { message: WeixinMessage; body: string; paths: string[] }[] = [];
  try {
    for (const message of messages) {
      const paths: string[] = [];
      for (const item of message.item_list ?? []) {
        if (item.type === 2 || item.type === 4) {
          signal.throwIfAborted();
          const media = await api.download(item, maxBytes, signal);
          paths.push(await storeWeChatMedia(workspace, media));
        }
      }
      prepared.push({ message, body: weChatText(message), paths });
    }
  } catch {
    signal.throwIfAborted();
    throw new WeChatPreparationError();
  }
  for (const entry of prepared) {
    for (const messageId of weChatMessageIds(entry.message)) {
      state.putQuote(entry.message.from_user_id!, messageId, entry.body, entry.paths);
    }
    if (entry.body) contents.push(entry.body);
    allPaths.push(...entry.paths);
    for (const item of entry.message.item_list ?? []) {
      if (!item.ref_msg) continue;
      const ref = item.ref_msg;
      const referenceId = weChatReferenceId(ref);
      const cached = referenceId ? state.quote(entry.message.from_user_id!, referenceId) : undefined;
      const quoted = ref.message_item;
      let body = cached?.body || (quoted?.type === 1 ? quoted.text_item?.text : quoted?.type === 3 ? quoted.voice_item?.text : undefined) || ref.title || "";
      if (body && ref.partial_text) {
        body = resolvePartialQuote(body, ref.partial_text).resolved ?? "[选中的引用文字暂不可用，请补充原文]";
      }
      if (body) contents.push(`[引用消息]\n${body}`);
      let usableMedia = false;
      for (const relative of cached?.paths ?? []) {
        if (await resolveWeChatWorkspaceFile(workspace, relative)) { allPaths.push(relative); usableMedia = true; }
        else contents.push("[引用附件暂不可用，请重发附件]");
      }
      if (!usableMedia && quoted && (quoted.type === 2 || quoted.type === 4)) {
        try {
          const media = await api.download(quoted, maxBytes, signal);
          allPaths.push(await storeWeChatMedia(workspace, media));
          usableMedia = true;
        } catch { signal.throwIfAborted(); contents.push("[引用附件暂不可用，请重发附件]"); }
      }
      if (!body && !usableMedia && !cached) contents.push("[引用消息暂不可用，请补充原文或重发附件]");
    }
  }
  const paths = [...new Set(allPaths)];
  const text = contents.join("\n\n").trim();
  if (!text && !paths.length) return "";
  return `${paths.length ? `[Uploaded files: ${paths.join(", ")}]\n` : ""}${text || "请查看我上传的文件"}`;
}

/** Plain-text channel formatting; collect artifact citations before this conversion. */
export function formatWeChatText(text: string): string {
  let fence: string | undefined;
  return text.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker && (!fence || marker[0] === fence)) { fence = fence ? undefined : marker[0]; return ""; }
    if (fence) return line;
    return line.replace(/^ {0,3}#{1,6}\s+/u, "")
      .replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/`([^`\n]+)`/gu, "$1")
      .replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gu, "$1 ($2)");
  }).join("\n").trim();
}

export function splitWeChatText(text: string, limit = 2000): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    const slice = chars.slice(offset, offset + limit).join("");
    let size = Array.from(slice).length;
    if (offset + size < chars.length) {
      const paragraph = slice.lastIndexOf("\n");
      if (paragraph > slice.length / 2) size = Array.from(slice.slice(0, paragraph + 1)).length;
    }
    parts.push(chars.slice(offset, offset + size).join(""));
    offset += size;
  }
  return parts;
}

export function textItem(text: string): MessageItem { return { type: 1, text_item: { text } }; }
