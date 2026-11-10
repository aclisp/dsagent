import { getDSCodeHome } from "../packages/core/dist/home.js";
import { runWeChatCli } from "../packages/wechat/dist/cli.js";

export async function runChannelCli(args: readonly string[]): Promise<void> {
  try { await runWeChatCli(args, getDSCodeHome()); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "微信通道命令失败。"}\n`);
    process.exitCode = 1;
  }
}
