# @thinkany/dscode-core

Reusable DSCode agent runtime for graphical clients, IDE integrations, and other headless hosts.

The package owns the same DeepSeek provider, tools, permissions, sessions, Skills, MCP, hooks,
checkpoints, and RPC behavior used by the `@thinkany/dscode` terminal client.

```ts
import { createDSCodeRpcClient } from "@thinkany/dscode-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => console.log(event));
await client.prompt("Explain this repository");
```

Configuration and sessions use the same `~/.dscode` home as the terminal client. Applications can
use the exported credential and settings functions to build their own login interface without
showing a terminal prompt.
