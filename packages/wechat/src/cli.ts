import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { loginWeChat } from "./login.ts";
import { WECHAT_UPSTREAM_LICENSE } from "./license.ts";

const HELP = `Usage: dscode channels login wechat [--qr-output <new-file.png>] [--timeout <seconds>]

在终端扫码绑定当前部署的微信通道。需要手机确认时按提示输入验证码。
凭据保存在 DSCODE_HOME/channels/wechat；登录后手动重启服务。
Docker: docker compose exec -it dscode dscode channels login wechat
Third-party license: dscode channels --license
`;

export async function runWeChatCli(args: readonly string[], home: string): Promise<void> {
  if (args.length === 1 && args[0] === "--license") { process.stdout.write(WECHAT_UPSTREAM_LICENSE); return; }
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  if (args[0] !== "login" || args[1] !== "wechat") throw new Error(HELP);
  let qrFile: string | undefined;
  let timeoutMs = 480_000;
  for (let index = 2; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!value) throw new Error(HELP);
    if (flag === "--qr-output") qrFile = value;
    else if (flag === "--timeout" && /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 3600) {
      timeoutMs = Number(value) * 1000;
    } else throw new Error(HELP);
  }
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(new Error("微信登录已取消。"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let qrCreated = false;
  try {
    await loginWeChat({ home, timeoutMs, signal: lifetime.signal, io: {
      write(message) { process.stdout.write(message); },
      async showQr(content) {
        process.stdout.write("请用本人微信扫描二维码并确认绑定：\n");
        process.stdout.write(await QRCode.toString(content, { type: "terminal", small: true }));
        if (qrFile) {
          const bytes = await QRCode.toBuffer(content, { type: "png", width: 480, margin: 3 });
          await fs.writeFile(qrFile, bytes, { flag: qrCreated ? "w" : "wx", mode: 0o600 });
          qrCreated = true;
          process.stdout.write(`二维码图片：${qrFile}\n`);
        }
      },
      async readCode(prompt, signal) {
        const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        try { return await reader.question(prompt, { signal }); }
        finally { reader.close(); process.stdin.pause(); }
      },
    } });
  } catch (error) {
    if (lifetime.signal.aborted) throw new Error("微信登录已取消。");
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("微信登录超时，请重新运行命令。");
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
