#!/usr/bin/env node

import process from "node:process";
import { runDSCodeProcess } from "../packages/core/dist/index.js";

void runDSCodeProcess(process.argv.slice(2), {
  startWebContinuation: async (options) => {
    const { startWebContinuation } = await import("./web-continuation.ts");
    return startWebContinuation(options);
  },
});
