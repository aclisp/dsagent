# @thinkany/dscode-web-ui

Minimal example UI for `@thinkany/dscode-http-adapter`: a terminal-style chat served by
the adapter's own Fastify server. It exists to verify the adapter's REST + SSE surface
against a live client — it is not a product frontend. `static/` holds `index.html`
(markup), `app.js` (page logic), `style.css` (styling), and the vendored `termino.js`.

## Run

```sh
pnpm install
pnpm --dir packages/web-ui build
node packages/web-ui/dist/server.js
```

Then open http://127.0.0.1:8899.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKSPACES` | `demo=/tmp/dscode-web-ui-demo` | Comma-separated `id=path` pairs; directories are created if missing |
| `RUNTIME_ARGS` | — | Whitespace-split DSCode flags forwarded to every session (e.g. `--provider openrouter --model qwen3.7-plus`) |
| `HOST` / `PORT` | `127.0.0.1` / `8899` | Listen address |

## What the page does

Boots from `GET /v1/sessions` (workspace picker when more than one), attaches to an active
session or creates/resumes one, renders history from `GET /v1/sessions/:id/messages`, then
chats over `POST /turns` while watching the SSE stream — assistant text streams live,
tools print one line per phase, thinking/compaction show as indicators, and
`confirm`/`select`/`input`/`editor` requests are answered inline. Multiple open clients
see each other's input: the `running` turn event carries the submitted message, and a
page skips only its own (matched by `clientId`). The Stop button aborts
the running turn. Refreshing the page reattaches and re-renders. After a server restart,
the page silently reattaches on the next message — resuming the persisted session — and
redelivers that message.

## v1 limitations

- Single-line input only; `editor` requests degrade to one line.
- Plain-text rendering — assistant markdown is shown raw.
- Input is disabled while a turn runs; dialogs and the Stop button are the only
  interactions mid-turn.
- One attached session at a time (matches the adapter's one-session-per-workspace rule).

## Vendored dependency

`static/termino.js` is the upstream source of
[Termino.js](https://github.com/MarketingPipeline/Termino.js) (MIT, v2.0.0) — it is not
published on npm. Planned phase-2 improvements (multi-line input, richer rendering,
mid-turn input) will be made directly on the vendored copy.

Local modifications so far:

- `termInput` folds the answer into the question line on Enter instead of re-echoing it
  with a `> ` caret (keeps the transcript one line per exchange, matching the history
  rendering); empty answers no longer emit a blank prompt line. The answer is appended
  as a text node, not parsed as HTML.
- `cancel_input()` settles a pending `input()` question without keypress input — it
  resolves `undefined` (like an empty answer) and detaches the question's keypress
  listener. The page uses it to drop a dialog prompt when its turn ends.
