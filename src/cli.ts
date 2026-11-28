#!/usr/bin/env node

import process from "node:process";
import { runDSCodeProcess } from "../packages/core/dist/index.js";

void runDSCodeProcess(process.argv.slice(2), {
  handleCommand: async (args) => {
    if (args[0] !== "channels") return false;
    await import("./channel-cli.ts").then(({ runChannelCli }) => runChannelCli(args.slice(1))).catch(() => {
      process.stderr.write("微信通道命令加载失败，请检查安装或重新构建。\n");
      process.exitCode = 1;
    });
    return true;
  },
  startWebContinuation: async (options) => {
    const { startWebContinuation } = await import("./web-continuation.ts");
    return startWebContinuation(options);
  },
});
