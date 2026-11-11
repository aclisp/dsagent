#!/usr/bin/env node

import process from "node:process";
import { runDSCodeProcess } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
if (args[0] === "channels") {
  void import("./channel-cli.ts").then(({ runChannelCli }) => runChannelCli(args.slice(1))).catch(() => {
    process.stderr.write("微信通道命令加载失败，请检查安装或重新构建。\n");
    process.exitCode = 1;
  });
} else void runDSCodeProcess(args, {
  startWebContinuation: async (options) => {
    const { startWebContinuation } = await import("./web-continuation.ts");
    return startWebContinuation(options);
  },
});
