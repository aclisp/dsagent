// ID fallbacks follow Tencent/openclaw-weixin@0ad1ae9 (MIT; ../LICENSE.tencent).
import type { RefMessage, WeixinMessage } from "./protocol.ts";

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function weChatMessageIds(message: WeixinMessage): string[] {
  return [...new Set([id(message.message_id), ...(message.item_list ?? []).map(item => id(item.msg_id))]
    .filter((value): value is string => value !== undefined))];
}

export function weChatReferenceId(reference: RefMessage): string | undefined {
  return id(reference.svr_id) ?? id(reference.message_item?.msg_id);
}
