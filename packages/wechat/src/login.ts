// QR state machine adapted from Tencent/openclaw-weixin@0ad1ae9 (MIT).
// Copyright (C) 2026 Tencent. See ../LICENSE.tencent.
import { WeChatApiClient, WECHAT_BASE_URL, httpsUrl } from "./api.ts";
import { loadWeChatCredentials, saveWeChatCredentials, type WeChatCredentials } from "./credentials.ts";

export interface WeChatLoginIo {
  showQr(content: string): Promise<void>;
  readCode(prompt: string, signal: AbortSignal): Promise<string>;
  write(message: string): void;
}
interface QrResponse { qrcode?: string; qrcode_img_content?: string }
interface QrStatus {
  status?: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string;
  baseurl?: string; redirect_host?: string;
}

export function waitWeChat(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, delayMs);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function loginWeChat(options: {
  home: string; io: WeChatLoginIo; signal: AbortSignal; timeoutMs?: number;
  pollIntervalMs?: number;
  api?: WeChatApiClient;
}): Promise<WeChatCredentials> {
  const { io, home } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 480_000)]);
  const api = options.api ?? new WeChatApiClient({});
  const existing = loadWeChatCredentials(home);
  let qrcode = "";
  let pollBase = WECHAT_BASE_URL;
  let pin: string | undefined;
  let refreshes = 0;
  const newQr = async () => {
    if (++refreshes > 3) throw new Error("二维码多次失效，请稍后重新运行登录命令。");
    // Self-binding only: no other-owner real-name authorization flow.
    const result = await api.request<QrResponse>("ilink/bot/get_bot_qrcode?bot_type=3", {
      signal, authenticated: false, body: { local_token_list: existing ? [existing.token] : [] },
      baseUrl: WECHAT_BASE_URL,
    });
    if (!result.qrcode || !result.qrcode_img_content) throw new Error("微信未返回可用二维码，请稍后重试。");
    qrcode = result.qrcode;
    pollBase = WECHAT_BASE_URL;
    pin = undefined;
    await io.showQr(result.qrcode_img_content);
  };
  await newQr();
  while (!signal.aborted) {
    let response: QrStatus;
    try {
      response = await api.request<QrStatus>(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${pin ? `&verify_code=${encodeURIComponent(pin)}` : ""}`, {
        signal, authenticated: false, timeoutMs: 35_000, baseUrl: pollBase,
      });
    } catch {
      signal.throwIfAborted();
      await waitWeChat(options.pollIntervalMs ?? 1000, signal);
      continue;
    }
    const status = response.status ?? "wait";
    if (status.includes("need_verifycode")) {
      pin = (await io.readCode(pin ? "数字不匹配，请重新输入手机微信显示的数字：" : "请输入手机微信显示的数字：", signal)).trim();
      if (!/^\d{1,16}$/u.test(pin)) throw new Error("验证码应为手机微信显示的数字，请重新登录。");
      continue;
    }
    switch (status) {
      case "wait": break;
      case "scaned": pin = undefined; io.write("已扫码，请在手机微信确认。\n"); break;
      case "expired":
      case "verify_code_blocked": io.write("二维码已失效，正在刷新。\n"); await newQr(); break;
      case "scaned_but_redirect": {
        if (!response.redirect_host || !/^[A-Za-z0-9.-]+$/u.test(response.redirect_host)) {
          throw new Error("微信返回了无效的登录重定向，请重新登录。");
        }
        pollBase = httpsUrl(`https://${response.redirect_host}`).origin;
        break;
      }
      case "binded_redirect":
        if (existing) { io.write("当前绑定已存在；重启 DSCode 服务后启用。\n"); return existing; }
        throw new Error("微信已有绑定，但本机没有对应凭据。请在手机解除原绑定后重试。");
      case "confirmed": {
        if (!response.bot_token?.trim() || !response.ilink_bot_id?.trim() || !response.ilink_user_id?.trim()) {
          throw new Error("登录响应缺少账号、凭据或扫码者身份，未保存绑定。");
        }
        const credentials: WeChatCredentials = {
          accountId: response.ilink_bot_id, ownerId: response.ilink_user_id,
          token: response.bot_token, baseUrl: httpsUrl(response.baseurl || WECHAT_BASE_URL).toString(),
          savedAt: new Date().toISOString(),
        };
        saveWeChatCredentials(home, credentials);
        io.write("微信登录成功，已保存私有凭据。请在服务空闲时重启 DSCode 服务以启用。\n");
        return credentials;
      }
      default: throw new Error("微信返回了当前版本不支持的登录状态，请核对协议版本。");
    }
    await waitWeChat(options.pollIntervalMs ?? 1000, signal);
  }
  signal.throwIfAborted();
  throw new Error("微信登录已停止。");
}
