# @thinkany/dscode-http-adapter

HTTP adapter that runs the DSCode agent in-process and exposes it over REST + SSE, so you can build
an agent-backed chat-bot app.

The package runs a real DSCode session **in-process** via `createAgentSessionHost` — no separate
worker process, no JSONL protocol. A Fastify server (`createHttpAdapter`) maps one HTTP session
to one agent session, streams assistant, tool, status, and interactive UI events over SSE, and
forwards approvals and questions back to the client.

```ts
import { createHttpAdapter } from "@thinkany/dscode-http-adapter";

const { server } = createHttpAdapter({
  workspaces: {
    main: "/path/to/workspace",
  },
});

await server.listen({ host: "127.0.0.1", port: 8787 });
```

## In-process Session Port

Use `createHttpAdapter` when another component in the same process needs to join the Session
without calling loopback HTTP or consuming SSE:

```ts
import { createHttpAdapter } from "@thinkany/dscode-http-adapter";

const { server, sessionPort } = createHttpAdapter({
  workspaces: { main: "/path/to/workspace" },
});

const unsubscribe = sessionPort.subscribe((event) => {
  if (event.status === "completed") {
    console.log(event.turnId, event.output);
  }
});

const submission = await sessionPort.submitTurn("main", "Review the current changes");
if (submission.status === "busy") {
  console.log("The shared Session already has an active Turn");
}
```

`activate(workspaceId)` and `submitTurn(workspaceId, message)` lazily restore the workspace's most
recent persisted Session, creating one when no history exists. Port and HTTP submissions share the
same controller and one-active-Turn guard. Port subscribers receive only terminal `completed`,
`failed`, and `aborted` events; completed events include `output`, which can be `null`.

Each HTTP session owns an isolated agent with its own tools, MCP connections, approvals, and
conversation state. Workspace IDs map to server-controlled paths, so clients never supply a raw
`cwd`. Turns are asynchronous: submit a turn, watch `GET /v1/sessions/:id/events` for progress, and
answer `confirm` / `select` / `input` / `editor` requests as they arrive.

Sessions are persisted to the per-home session store shared with the CLI (`~/.dscode/sessions`) and
can be resumed by ID. Session files are append-only logs and are never rewritten by default.
Opt in to pruning with `createHttpAdapter({ maxSessionFileBytes })`: once a file exceeds the
limit, it is rewritten down to its active context at turn end — compacted-out history and dead
branches are dropped, the live conversation is unchanged.

## Runtime arguments

`createHttpAdapter({ runtimeArgs })` forwards a fixed allowlist of DSCode CLI flags to every
session — values: `--provider --base-url --transport --harness --permission --sandbox --effort
--model --tools`; booleans: `--network --web --no-tools --no-resume`. Anything else is rejected
with `Unsupported direct session argument`. The agent's working directory is always the workspace
path, never client-controlled.

Pass `logger: true` (or pino options) to emit structured logs; logging is disabled by default.

## Security notes

- No built-in authentication. Bind to localhost or a private network and add your own auth.
- Workspace IDs must resolve to server-controlled paths; never derive `cwd` from client input.
- Credentials and the API key live server-side in the shared `~/.dscode` home.
- One active turn per session and one active session per workspace are enforced; sessions are
  isolated (separate conversation state, tools, MCP connections, and managed processes).

See `docs/API.md` for the endpoint reference and an end-to-end orchestration walkthrough.
