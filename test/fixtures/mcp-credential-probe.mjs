// No argument means the key must be absent, not merely empty.
const expected = process.argv[2];
if (process.env.DEEPSEEK_API_KEY !== expected) {
  throw new Error(expected === undefined
    ? "Unexpected inherited DEEPSEEK_API_KEY"
    : "Missing or incorrect configured DEEPSEEK_API_KEY");
}

await import("./mcp-server.mjs");
