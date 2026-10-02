# @aclisp/dsagent-core

Reusable DSCode agent runtime for graphical clients, IDE integrations, and other headless hosts.

The package owns the same provider routing, tools, permissions, sessions, Skills, MCP, hooks,
checkpoints, and RPC behavior used by the `@aclisp/dsagent` terminal client. DeepSeek remains the
default; Codex, OpenAI, Anthropic, OpenRouter, Z.AI, Kimi, MiniMax, xAI, and OpenCode Zen Go are supported by the same
runtime.

The runtime uses Pi 1.0.0 with DSCode's own MCP integration. Pi's built-in MCP,
Codemode, and tool search extensions are disabled; DSCode does not add virtual
model routing or classifier calls. The upstream packages still include those APIs
and transitive dependencies.

```ts
import { createDSCodeRpcClient } from "@aclisp/dsagent-core/rpc";

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

Storage follows the same split used by the Codex desktop architecture: JSONL transcripts remain
the durable source of truth, while `state.sqlite` indexes thread metadata and pin/archive state.
Transcripts are date-partitioned under `sessions/YYYY/MM/DD`; flat hard links preserve compatibility
with the current terminal resume implementation. Credentials use an injectable `CredentialStore`
with `auto`, `keyring`, and owner-only `file` modes. The default `auto` mode uses the OS keyring in
desktop/interactive processes and falls back safely for headless processes.

For graphical authentication, use `saveProviderApiKey()` for API-key providers or pass UI callbacks
to `authenticateProvider()` for provider OAuth and API-key flows. No terminal rendering is required.

## Themes

The DSCode CLI defaults to `dscode-light/dscode-dark`, following the terminal's
appearance. These bundled themes preserve Pi 0.87.1's colors exactly; only their
names differ. The previous `light/dark` default migrates once to the DSCode pair.
Explicit single-theme and custom selections remain unchanged. Pi's current
`light`, `dark`, and `system` themes remain available in `/settings`.
