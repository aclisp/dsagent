import { writeSync } from "node:fs";
import { ManagedProcessRegistry } from "../../packages/core/src/managed-process.ts";

const mode = process.argv[2];
const registry = new ManagedProcessRegistry();
const script = mode === "graceful"
  ? "process.on('SIGTERM', () => { process.stdout.write('graceful'); process.exit(0); }); console.log(process.pid); setInterval(() => {}, 1000);"
  : "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const started = await registry.start(`exec ${quote(process.execPath)} -e ${quote(script)}`, {
  cwd: process.cwd(), sandbox: { mode: "danger-full-access", network: false },
  yieldTimeMs: 0, timeoutMs: 30_000, thinkingLevel: "low",
});
let output = "";
while (!/\d+/.test(output)) {
  output = (await registry.interact(started.processId, { yieldTimeMs: 10 })).output;
}
// Ensure the test receives the child PID even when the host immediately exits.
writeSync(1, `child:${output.trim()}\n`);

if (mode === "crash") {
  // Mirrors pi's fatal handler exiting without session_shutdown.
  process.on("uncaughtException", () => process.exit(1));
  setImmediate(() => { throw new Error("shutdown regression fixture"); });
} else if (mode === "uncaught") {
  setImmediate(() => { throw new Error("shutdown regression fixture"); });
} else if (mode === "exit-during-dispose") {
  void registry.dispose();
  process.exit(0);
} else if (mode === "exit") {
  process.exit(0);
} else {
  const completion = registry.interact(started.processId, { yieldTimeMs: 10_000 });
  const disposing = registry.dispose();
  if (disposing !== registry.dispose()) throw new Error("dispose must be idempotent");
  await disposing;
  const result = await completion;
  writeSync(1, `result:${JSON.stringify(result)}\n`);
  process.exit(0);
}
