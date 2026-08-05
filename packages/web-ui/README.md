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

## Docker

The image stays lean (Node + app). Office/PDF tools for the agent (LibreOffice, poppler,
ghostscript, qpdf, pandoc) are added by a derived image built once on the live env server.

```sh
# On the dev machine — build the lean image (amd64, so it deploys to AMD64 hosts like
# EC2/ECS; on Apple Silicon this runs under emulation and is slower on the first build).
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build -t dscode-server:lean .

# On the live env server — build the derived image once (adds the tool layer, cached locally).
docker build -f deploy/tools.Dockerfile -t dscode-server .   # FROM dscode-server:lean

# Run (yolo + volumes + security).
docker run -d --name dscode \
  -p 8899:8899 \
  -v dscode-home:/root/.dscode \
  -v dscode-workspace:/workspace \
  -e WORKSPACES=ws=/workspace \
  -e 'RUNTIME_ARGS=--permission full --network --sandbox danger-full-access' \
  --cap-drop ALL --security-opt no-new-privileges \
  dscode-server
```

- **Volumes.** `/root/.dscode` holds the adapter's config (models.json, provider credentials) and
  its persisted sessions — mount it so agent state survives container restarts. `/workspace` is
  the agent's working directory (where it generates documents) — mount it to keep the output.
- **`RUNTIME_ARGS` is mandatory in a container.** The default `workspace-write` sandbox has no
  backend inside a Linux container (macOS `sandbox-exec` is unavailable and no `DSCODE_SANDBOX_IMAGE`
  is configured), so every `exec_command` would fail without `--sandbox danger-full-access`. The
  full trio also skips all mid-chat approval dialogs — the right posture for a non-technical
  product, and the container already bounds the blast radius.
- **`HOST=0.0.0.0`** is set in the image; the app default (`127.0.0.1`) is unreachable from outside
  a container.
- **Security.** `--cap-drop ALL --security-opt no-new-privileges` keeps the full-access agent from
  escalating beyond the container. The lean image itself only adds `git` (the agent's tools run it
  in the workspace).
- **LibreOffice headless gotcha.** In a container, conversion can hang on the user profile lock —
  add `--env:UserInstallation=file:///tmp/lo_profile` to `libreoffice --convert-to` commands.

## What the page does

Boots from `GET /v1/sessions` (workspace picker when more than one), attaches to an active
session or creates/resumes one, renders history from `GET /v1/sessions/:id/messages`, then
chats over `POST /turns` while watching the SSE stream — assistant text streams live,
tools print one line per phase, and
`confirm`/`select`/`input`/`editor` requests are answered inline. Multiple open clients
see each other's input: the `running` turn event carries the submitted message, and a
page skips only its own (matched by `clientId`). Thinking, compaction, and the agent's
live working status show as transient indicators. The Stop button aborts
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
