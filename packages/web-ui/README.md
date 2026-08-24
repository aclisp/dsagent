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
| `WORKSPACES` | *(required)* | Comma-separated `id=path` pairs; IDs must be 16-128 URL-safe characters (`A-Z`, `a-z`, `0-9`, `_`, `-`). Directories are created if missing; IDs are **secrets** — use a random high-entropy value per deployment |
| `RUNTIME_ARGS` | — | Whitespace-split DSCode flags forwarded to every session. Must include `--permission full --sandbox danger-full-access` (the only modes with a backend in the container) and `--tools exec_command,write_stdin,apply_patch,read` to keep the agent toolset to what the web-ui can display (`read` is required for skills to be advertised — see "Agent toolset") |
| `DSCODE_SUBAGENT_DEPTH` | — | `1` disables the `delegate` tool (subagents are TUI/CLI-first and don't work in the container) |
| `DSCODE_VISION_MODEL` | — | OpenRouter model ID used by `dscode-vision`; the matching `models.json` entry must declare `input: ["text", "image"]` |
| `CHAT_AGENT_NAME` | `Steve Code` | Display name used throughout the friendly `/chat/:workspaceId` page; does not rename the raw debug UI |
| `HOST` / `PORT` | `127.0.0.1` / `8899` | Listen address |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | Per-file upload size cap |
| `CORS_ORIGINS` | — | Comma-separated exact HTTP(S) origins allowed to call `/health` and `/v1/*`. Wildcards are rejected; `/share/*` remains unavailable to cross-origin JavaScript |

## Headless Chat Provider composition

`createWebUiServer` accepts an optional `chatProvider` for in-process group chat integration. The
Provider publishes normalized messages through `subscribe`, implements `reply` and `send`, and
supplies the one fixed `groupChatId`. The Server binds it to the first configured workspace through
the shared `SessionPort`; receiving a Provider message lazily activates the same Session used by the
browser clients.

The binding adds no HTTP routes and is removed when the Server closes. Provider transport,
credentials, protocol startup, and the first real IM implementation remain outside the Web UI
Server composition boundary.

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
DSCODE_PROMPT_PROFILE=steve
docker run -d --name dscode \
  -p 8899:8899 \
  -v dscode-home:/root/.dscode \
  -v dscode-workspace:/workspace \
  -v "$HOME/.dscode/models.json":/root/.dscode/models.json:ro \
  -v "$PWD/deploy/prompt-profiles/$DSCODE_PROMPT_PROFILE/SYSTEM.md":/root/.dscode/SYSTEM.md:ro \
  -v "$PWD/deploy/prompt-profiles/$DSCODE_PROMPT_PROFILE/favicon.png":/app/packages/web-ui/static/favicon.png:ro \
  -v "$PWD/deploy/default-files/APPEND_SYSTEM.md":/root/.dscode/APPEND_SYSTEM.md:ro \
  -v "$PWD/deploy/default-files/AGENTS.md":/root/.dscode/AGENTS.md:ro \
  -v "$PWD/deploy/locked-workspace-pi":/workspace/.pi:ro \
  -e "WORKSPACES='<workspace-id>=/workspace'" \
  -e 'RUNTIME_ARGS=--permission full --network --sandbox danger-full-access --provider openrouter --model <model> --effort max --tools exec_command,write_stdin,apply_patch,read' \
  -e DSCODE_SUBAGENT_DEPTH=1 \
  -e DSCODE_VISION_MODEL='<vision model>' \
  -e CHAT_AGENT_NAME='Steve Code' \
  -e OPENROUTER_API_KEY='<your key>' \
  --init \
  --cap-drop ALL --security-opt no-new-privileges \
  dscode-server
```

The same deployment is available as the generic `docker-compose.example.yml` at the repo root.
Copy it and `.env.example` into `.local/<instance>/`, then configure that instance's `.env`:
`DSCODE_INSTANCE_NAME`, `DSCODE_HOST_PORT`, `WORKSPACE_ID`, `OPENROUTER_API_KEY`, `MODEL`, and
`VISION_MODEL`, and `DSCODE_PROMPT_PROFILE`. Run `docker compose up -d` from the instance directory
to create or update it;
`docker compose down` stops it without touching its project-scoped named volumes. Creating another
instance only requires another local directory and different `.env` values. The template contains
no machine-specific paths; its prompt mounts resolve through the repository-relative `../../deploy`.

- **Volumes.** The `docker run` example uses `dscode-home` and `dscode-workspace`; Compose creates
  `<instance>_home` and `<instance>_workspace`. They hold the adapter's config, persisted sessions,
  and working directory. `models.json` is mounted `:ro` so the container can't rewrite it.
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
- **Provider keys and models.** Keys referenced in `models.json` as `$ENV` must be passed with
  `-e`. An example lives at `deploy/models.json.example` — copy it to
  `~/.dscode/models.json`, replace the `baseUrl` placeholder, and declare both the main model
  and the `DSCODE_VISION_MODEL`. The vision entry must include `"image"` in its `input` array.
- **LibreOffice.** In a container, conversion can hang on the user profile lock — add
  `--env:UserInstallation=file:///tmp/lo_profile` to `libreoffice --convert-to`.

## Agent toolset

The web-ui restricts the agent to four tools (`--tools exec_command,write_stdin,apply_patch,read`
plus `DSCODE_SUBAGENT_DEPTH=1`). `read` is pi's built-in file reader — it's included because pi
only advertises skills to the model when the `read` tool is active: `~/.dscode/skills` is
auto-discovered and listed in the system prompt, and the model loads a skill's `SKILL.md` via
`read`.
The other DSCode tools are TUI-first and don't fit this deployment:

- `update_plan` is excluded: plan state is rendered through a TUI widget the web-ui doesn't
  display, and plan mode is unreachable here (the deployment runs `--permission full` in `rpc`
  mode, and every plan-mode path is gated on `permission === "plan"`).
- `delegate` is excluded: subagents re-invoke the process entrypoint (`./dist/server.js`, not
  the DSCode CLI), require a Git repository for implementer worktrees, and need a sandbox
  backend for their `read-only`/`workspace-write` modes — none of which exist inside the
  container. `DSCODE_SUBAGENT_DEPTH=1` also skips its registration.

### Vision analysis CLI

The lean image installs `/usr/local/bin/dscode-vision`, backed by the minified standalone
bundle at `/app/dist/vision-cli.js`. It analyzes one PNG, JPEG, GIF, or WebP image through the
OpenRouter model selected by `DSCODE_VISION_MODEL`:

```sh
dscode-vision --image "uploads/screenshot.png" --prompt "Explain this error"
```

When the command is issued through `exec_command`, Core recognizes only this exact, narrow
syntax and starts the fixed bundle without a shell. The child receives `OPENROUTER_API_KEY`,
the vision model setting, and the current main-agent thinking level through an environment
allowlist. Ordinary commands still have all model credentials stripped; wrappers, pipes,
redirections, command substitution, and command chaining do not enter the trusted path.

The vision process reads the mounted `models.json` but does not read the shared `auth.json`,
load skills or context files, create a session, or expose tools to the vision model. Its text
result returns to the main agent as ordinary `exec_command` output. The bundled `dscode-vision`
skill tells the main agent when to call the CLI and to turn its observations into a natural answer
rather than forwarding raw output.

Common failures are a missing `DSCODE_VISION_MODEL`, no matching `models.json` entry, a model that
does not declare image input, a missing OpenRouter key, and an invalid, unsupported, or oversized
image. Ordinary commands seeing an empty `OPENROUTER_API_KEY` is expected: only the strictly parsed
vision command receives it. This protects against accidental disclosure, not an actively hostile
root process inside the same container.

### Default skills

The image ships four skills — `dscode-vision`, `grill-me`, `skill-creator`, and `youxin-cli` —
bundled in `deploy/default-skills/`. Because `/root/.dscode` is a named volume, the entrypoint
(`deploy/docker-entrypoint.sh`) copies them into `~/.dscode/skills` on every container start,
only when missing, so existing deployments pick them up without user skills being overwritten.
They're auto-discovered by pi (the user skills dir is not trust-gated) and listed in the system
prompt now that the `read` tool is active. Add user skills by dropping directories into the
volume's `/root/.dscode/skills/`.

### Prompt profiles and protected prompt files

Compose selects the product identity with `DSCODE_PROMPT_PROFILE` and directly mounts the matching
`deploy/prompt-profiles/<name>/SYSTEM.md` over `/root/.dscode/SYSTEM.md`, and mounts the profile's
`favicon.png` over the Web UI static asset. The default is `steve`; `assistant` is also bundled.
Both replace Pi's built-in base prompt. The favicon is also used as the friendly chat header and
assistant-message avatar. Adding another product profile requires a directory containing both
files and that name in the instance's `.env`:

```text
deploy/prompt-profiles/<name>/
├── SYSTEM.md
└── favicon.png
```

All product profiles share `deploy/default-files/APPEND_SYSTEM.md`, which contains the
implementation-confidentiality boundary. `AGENTS.md` remains the shared Web UI output and
file-citation guidance. Compose mounts all three effective global files read-only, so the agent
cannot edit, replace, or delete them. `CHAT_AGENT_NAME` is independent of the prompt profile; set it
in `.env` when a profile should use a different name in the friendly chat UI.

Pi gives prompt files in a trusted workspace's `.pi` directory precedence over global prompt
files. The normal Compose template therefore mounts `deploy/locked-workspace-pi` read-only at
`/workspace/.pi`, preventing a full-access agent from creating a workspace `SYSTEM.md` or
`APPEND_SYSTEM.md` to bypass the protected global files.

For developer Debug mode, copy `docker-compose.debug.example.yml` next to the instance Compose file
and recreate with both files:

```sh
cp ../../docker-compose.debug.example.yml docker-compose.debug.yml
docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d
```

The override mounts `deploy/debug-workspace-pi` instead. Its zero-byte `SYSTEM.md` shadows the
product identity and restores Pi's built-in base; its zero-byte `APPEND_SYSTEM.md` shadows and
removes the confidentiality boundary. `AGENTS.md`, skills, and DSCode's engineering contract remain
available. The workspace must be trusted for Pi to load these workspace-level overrides; direct
HTTP sessions use a trusted workspace by default. Debug mode retains the selected product profile's
favicon unless its Compose override explicitly mounts a different image.

The image entrypoint still seeds missing `APPEND_SYSTEM.md` and `AGENTS.md` into `DSCODE_HOME` for
deployments that do not use these Compose mounts. Existing named-volume files are preserved, while
the direct read-only mounts above take precedence in the normal deployment.

## File upload / download

These endpoints are web-ui layer (not part of the http-adapter API). Files live in the
workspace's `uploads/` subdirectory, so the agent reads and writes them by workspace-relative
paths from its working directory.

- `POST /v1/workspaces/:workspaceId/files` — multipart upload (field `files`, one part per file).
  Writes each file to `<workspace>/uploads/<name>` (overwrites an existing file of the same name)
  and returns `{ files: [{ name, path, size }] }`. Filenames are sanitized to a bare basename;
  oversized files are rejected with 413 (`MAX_UPLOAD_BYTES`).
- `GET /share/:workspaceId/<relative-path>` — share/view a workspace file. Resolves within the
  workspace (rejects `..` escapes and symlinks pointing outside), serves browser-consumable
  files inline and everything else as an attachment, always with `X-Content-Type-Options: nosniff`.

The page's Upload button posts to the upload endpoint and prints a confirmation line with a
share link; the agent references them from the workspace. Upload and Stop share one header
slot — Upload shows while idle, Stop replaces it while a turn runs (uploading mid-turn would be
useless: the agent reads files only at the next prompt). The uploaded paths are injected into the
next message the page submits, so the agent learns about them in context; the hint is sent once
and cleared. Share links are rendered client-side: a backticked span
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
