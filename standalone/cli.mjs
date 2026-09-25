// Keep initialization before Core: Bun OAuth registers static provider imports.
import "./runtime.mjs";
import { runDSCodeProcess } from "../packages/core/dist/cli-runtime.js";

const args = process.argv.slice(2);
const flags = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
const extensionFlag = flags.find(arg => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="));
if (extensionFlag) {
  process.stderr.write("User extensions are not supported in the standalone CLI. Local skills and MCP remain available.\n");
  process.exitCode = 1;
} else if (["install", "remove", "update", "list", "config"].includes(args[0])) {
  process.stderr.write("Package management is not supported in the standalone CLI. Upgrade by replacing the executable.\n");
  process.exitCode = 1;
} else {
  await runDSCodeProcess(args);
}
