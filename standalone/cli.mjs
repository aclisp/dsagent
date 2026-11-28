// Keep initialization before Core: Bun OAuth registers static provider imports.
import "./runtime.mjs";
import { runDSCodeProcess } from "../packages/core/dist/cli-runtime.js";
import { updateBundledTools } from "./tools-manager.mjs";

async function handleStandaloneCommand(args) {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  if (flags.includes("--update-bundled-tools")) {
    if (args.length !== 1) {
      process.stderr.write("Usage: dscode [--agent-dir <dir>] --update-bundled-tools\n");
      process.exitCode = 1;
    } else {
      try {
        for (const result of await updateBundledTools()) process.stdout.write(`${result.tool}: ${result.message}\n`);
      } catch (error) {
        process.stderr.write(`Bundled tool update failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    }
  } else if (args[0] === "channels") {
    const { getDSCodeHome } = await import("../packages/core/dist/home.js");
    const { runWeChatCli } = await import("../packages/wechat/dist/cli.js");
    try { await runWeChatCli(args.slice(1), getDSCodeHome()); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  } else if (flags.some(arg => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="))) {
    process.stderr.write("User extensions are not supported in the standalone CLI. Local skills and MCP remain available.\n");
    process.exitCode = 1;
  } else if (["install", "remove", "update", "list", "config"].includes(args[0])) {
    process.stderr.write("Package management is not supported in the standalone CLI. Upgrade by replacing the executable.\n");
    process.exitCode = 1;
  } else {
    return false;
  }
  return true;
}

await runDSCodeProcess(process.argv.slice(2), {
  handleCommand: handleStandaloneCommand,
  startWebContinuation: async (options) => {
    const { startWebContinuation } = await import("../packages/web-ui/dist/continuation.js");
    return startWebContinuation(options);
  },
});
