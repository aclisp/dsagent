# @thinkany/dscode-core

Reusable DSCode agent runtime for graphical clients, IDE integrations, and other headless hosts.

The package owns the same provider routing, tools, permissions, sessions, Skills, MCP, hooks,
checkpoints, and RPC behavior used by the `@thinkany/dscode` terminal client. DeepSeek remains the
default; OpenAI API and eligible ChatGPT/Codex subscriptions are supported by the same runtime.

```ts
import { createDSCodeRpcClient } from "@thinkany/dscode-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => console.log(event));
await client.prompt("Explain this repository");
```

Select another supported provider without changing the host integration:

```ts
const client = createDSCodeRpcClient({
  cwd: "/path/to/project",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
});
```

Configuration and sessions use the same `~/.dscode` home as the terminal client. Applications can
use the exported credential and settings functions to build their own login interface without
showing a terminal prompt.

For graphical authentication, use `saveProviderApiKey()` for API-key providers or pass UI callbacks
to `authenticateProvider()` for OpenAI API/Codex OAuth. No terminal rendering is required.
