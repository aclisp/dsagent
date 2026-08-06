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

Then open http://127.0.0.1:8899/chat/<workspaceId>.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKSPACES` | *(required)* | Comma-separated `id=path` pairs; directories are created if missing. The ids are **secrets** — use a random high-entropy value per deployment |
| `RUNTIME_ARGS` | — | Whitespace-split DSCode flags forwarded to every session (e.g. `--provider openrouter --model qwen3.7-plus`) |
| `HOST` / `PORT` | `127.0.0.1` / `8899` | Listen address |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | Per-file upload size cap |

## Workspaces as a secret

There is no default or discoverable workspace. The chat page is served only at
`/chat/:workspaceId`; `/` and unknown ids return 404. The id is the bearer credential for
the whole deployment — whoever holds the URL can open the page and, because the same id
gates the API (`GET /v1/sessions` requires `?workspaceId=`), reach the full-access agent.
Share the URL out-of-band (e.g. `https://host/chat/k9x7…`). The id is high-entropy, so
it can't be guessed; the server starts only when `WORKSPACES` is set explicitly.

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
  -e WORKSPACES='k9x7q2m4v8w1z5t3=/workspace' \
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

## File upload / download

These endpoints are web-ui layer (not part of the http-adapter API). Files live in the
workspace's `uploads/` subdirectory, so the agent reads and writes them by workspace-relative
paths from its working directory.

- `POST /v1/workspaces/:workspaceId/files` — multipart upload (field `files`, one part per file).
  Writes each file to `<workspace>/uploads/<name>` (overwrites an existing file of the same name)
  and returns `{ files: [{ name, path, size }] }`. Filenames are sanitized to a bare basename;
  oversized files are rejected with 413 (`MAX_UPLOAD_BYTES`).
- `GET /v1/workspaces/:workspaceId/files?path=<relative>` — download. Resolves within the
  workspace (rejects `..` escapes and symlinks pointing outside), serves images/PDF/text inline
  and everything else as an attachment, always with `X-Content-Type-Options: nosniff`.

The page's Upload button posts to the upload endpoint and prints a confirmation line with a
download link; the agent references them from the workspace. Upload and Stop share one header
slot — Upload shows while idle, Stop replaces it while a turn runs (uploading mid-turn would be
useless: the agent reads files only at the next prompt). The uploaded paths are injected into the
next message the page submits, so the agent learns about them in context; the hint is sent once
and cleared. Download links are rendered client-side: a backticked span
counts as a file only when it looks like a path (no whitespace, and either a directory separator
or a letter file extension), and `/workspace/…` paths always link. Anything else — `exec_command`,
`npm install`, `v1.2` — stays plain text. To make the agent always cite files by path, add a line
to `~/.dscode/APPEND_SYSTEM.md`:

```md
When you create a file the user should see, save it in the workspace and cite it as a
backticked workspace-relative path (e.g. `uploads/report.pdf`).
```

## What the page does

Boots from the `workspaceId` in the URL, attaches to an active
session or creates/resumes one, renders history from `GET /v1/sessions/:id/messages`, then
chats over `POST /turns` while watching the SSE stream — assistant text streams live,
tools print one line per phase, and
`confirm`/`select`/`input`/`editor` requests are answered inline. Multiple open clients
see each other's input: the `running` turn event carries the submitted message, and a
page skips only its own (matched by `clientId`). Thinking and compaction show as transient indicators, and the agent's
live working status counts up in the disabled input line (the TUI's
"esc to interrupt" suffix becomes " · Stop to interrupt"). The Stop button aborts
the running turn. Refreshing the page reattaches and re-renders. 

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
