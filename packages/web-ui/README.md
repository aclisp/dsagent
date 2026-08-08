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
| `RUNTIME_ARGS` | — | Whitespace-split DSCode flags forwarded to every session. Must include `--permission full --sandbox danger-full-access` (the only modes with a backend in the container) and `--tools exec_command,write_stdin,apply_patch,read` to keep the agent toolset to what the web-ui can display (`read` is required for skills to be advertised — see "Agent toolset") |
| `DSCODE_SUBAGENT_DEPTH` | — | `1` disables the `delegate` tool (subagents are TUI/CLI-first and don't work in the container) |
| `HOST` / `PORT` | `127.0.0.1` / `8899` | Listen address |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | Per-file upload size cap |

## Workspaces as a secret

There is no default or discoverable workspace. The chat page is served only at
`/chat/:workspaceId`; `/` and unknown ids return 404. The id is the bearer credential for
the whole deployment — whoever holds the URL can open the page and, because the same id
gates the API (`GET /v1/sessions` requires `?workspaceId=`), reach the full-access agent.
Share the URL out-of-band (e.g. `https://host/chat/<workspace-id>`). The id is high-entropy, so
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
  -v "$HOME/.dscode/models.json":/root/.dscode/models.json:ro \
  -e "WORKSPACES='<workspace-id>=/workspace'" \
  -e 'RUNTIME_ARGS=--permission full --network --sandbox danger-full-access --provider openrouter --model <model> --effort max --tools exec_command,write_stdin,apply_patch,read' \
  -e DSCODE_SUBAGENT_DEPTH=1 \
  -e OPENROUTER_API_KEY='<your key>' \
  --init \
  --cap-drop ALL --security-opt no-new-privileges \
  dscode-server
```

The same deployment is available as `docker-compose.yml` at the repo root: fill in `.env`
(`WORKSPACE_ID`, `OPENROUTER_API_KEY`, `MODEL` — see `.env.example`), then `docker compose
up -d` creates the container and recreates it after an image rebuild; `docker compose down`
stops it without touching the named volumes.

- **Volumes.** `dscode-home` holds the adapter's config and persisted sessions; `dscode-workspace`
  is the agent's working directory. `models.json` is mounted `:ro` so the container can't rewrite it.
- **`RUNTIME_ARGS` is required in a container** — the default sandbox has no backend inside a Linux
  container, so every `exec_command` fails without `--sandbox danger-full-access` (which also skips
  mid-chat approval dialogs).
- **`HOST=0.0.0.0`** is set in the image; the app default (`127.0.0.1`) is unreachable from outside
  a container.
- **Process reaping.** `--init` starts Docker's minimal init process as PID 1 so orphaned
  subprocesses are reaped and termination signals are forwarded. The Compose deployment uses
  `init: true`; recreate an existing container after enabling it.
- **Security.** `--cap-drop ALL --security-opt no-new-privileges` contains the full-access agent.
  No `--cap-add`: the image pins apt's sandbox to root and ships `git` + `ca-certificates` +
  `ripgrep` + `procps`, so apt, HTTPS git/curl, `rg` search, and process tools (`ps`/`pgrep`/`free`)
  work under the full cap-drop.
- **Provider keys.** Keys referenced in `models.json` as `$ENV` must be passed with `-e`.
  An example lives at `deploy/models.json.example` — copy it to `~/.dscode/models.json` and
  replace the `baseUrl` placeholder with your endpoint.
- **LibreOffice.** In a container, conversion can hang on the user profile lock — add
  `--env:UserInstallation=file:///tmp/lo_profile` to `libreoffice --convert-to`.

## Agent toolset

The web-ui restricts the agent to four tools (`--tools exec_command,write_stdin,apply_patch,read`
plus `DSCODE_SUBAGENT_DEPTH=1`). `read` is pi's built-in file reader — it's included because pi
only advertises skills to the model when the `read` tool is active: `~/.dscode/skills` is
auto-discovered and listed in the system prompt, and the model loads a skill's `SKILL.md` via
`read`. `/system-prompt` shows the rendered system prompt, active tools, and loaded skills.
The other DSCode tools are TUI-first and don't fit this deployment:

- `update_plan` is excluded: plan state is rendered through a TUI widget the web-ui doesn't
  display, and plan mode is unreachable here (the deployment runs `--permission full` in `rpc`
  mode, and every plan-mode path is gated on `permission === "plan"`).
- `delegate` is excluded: subagents re-invoke the process entrypoint (`./dist/server.js`, not
  the DSCode CLI), require a Git repository for implementer worktrees, and need a sandbox
  backend for their `read-only`/`workspace-write` modes — none of which exist inside the
  container. `DSCODE_SUBAGENT_DEPTH=1` also skips its registration.

### Default skills

The image ships three skills — `grill-me`, `skill-creator`, and `youxin-cli` — bundled in
`deploy/default-skills/`. Because `/root/.dscode` is a named volume, the entrypoint
(`deploy/docker-entrypoint.sh`) copies them into `~/.dscode/skills` on every container start,
only when missing, so existing deployments pick them up without user skills being overwritten.
They're auto-discovered by pi (the user skills dir is not trust-gated) and listed in the system
prompt now that the `read` tool is active. Add user skills by dropping directories into the
volume's `/root/.dscode/skills/`.

### Default prompt/context files

The image also bundles `APPEND_SYSTEM.md` and `AGENTS.md` under `deploy/default-files/`. On every
container start, the entrypoint copies each missing file into the global `DSCODE_HOME` directory
(`~/.dscode` by default), where pi loads them as prompt/context files. Existing files are preserved,
so edit them in the named `home` volume to customize the defaults. `APPEND_SYSTEM.md` contains the
global product persona; `AGENTS.md` contains the Web UI output rules and file-citation guidance.
`/system-prompt` shows the resulting prompt.

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
counts as a file only when it looks like a path (no whitespace or shell/URL metacharacters, and
either a directory separator or a dotted name like `report.pdf` — a bare `.md` stays plain), and
`/workspace/…` paths always link. Anything else — `exec_command`,
`npm install`, `v1.2` — stays plain text. The bundled `AGENTS.md` already asks the agent to
cite user-visible files by path; edit `~/.dscode/AGENTS.md` to customize that behavior:

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

## Input behavior

The chat input starts at one row, expands for wrapped or pasted multiline content up to three rows,
and shows a vertical scrollbar beyond that limit. Enter submits the current input; Shift+Enter
inserts a newline.

## v1 limitations

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
