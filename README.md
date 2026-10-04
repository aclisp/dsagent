<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

<p align="center">
  A heavily customized Pi coding agent and Linux server operations companion.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.en.md">Comparison</a>
</p>

## Why DSCode

- **A coding agent on infrastructure you control.** Run DSCode on your Linux server and work with
  your projects over SSH, where you can inspect services, run commands, track their output, and
  review or undo file changes.
- **One runtime, multiple ways to work.** Choose an interface: the CLI/TUI, REST+SSE API, or Web UI.
  All three use the same Core, show live agent activity, and let you
  respond to prompts for confirmation or choices.
- **Bring your team’s chat into the workflow.** In WeCom, teammates can message DSCode directly or
  mention it in a group to delegate tasks, share images and files, and receive replies and generated
  files. They can also ask DSCode to schedule one-time or recurring tasks. DSCode sends each result to
  the conversation where the task was requested.

## Quick start

### Standalone executable (recommended)

Start with a standalone executable. No Node.js, Bun, package manager, or source build is required.

1. Open [GitHub Releases](https://github.com/aclisp/dsagent/releases) and download the archive for your computer from **Assets**:

   | Computer | Download |
   | --- | --- |
   | macOS with Apple Silicon (M1 or later) | `dscode-v<version>-darwin-arm64.tar.gz` |
   | Linux x86_64 / AMD64 | `dscode-v<version>-linux-x64.tar.gz` |

2. Extract the archive and open a terminal in the extracted folder.
3. Start DSCode:

```bash
./dscode
```

Only the `dscode` executable is needed; you can move it to any folder. The included `dscode.sha256`
file is its checksum. Standalone downloads currently support the two platforms above. The macOS
executable is not notarized, so macOS may ask you to allow it in **System Settings → Privacy & Security**.

For login, first-run guidance, and CLI/runtime details, see the
[CLI & Runtime Reference](docs/CLI_REFERENCE.md).

### One-click installer

Alternatively, run the one-click installer. It installs DSCode into `~/.local/share/dscode`, builds it,
and creates a `dscode` launcher in `~/.local/bin`.

```bash
curl -fsSL https://raw.githubusercontent.com/aclisp/dsagent/main/scripts/install.sh | sh
```

### Developers: build from source

Use Node.js 22.19 or newer. `pnpm dev` runs the CLI source with Node's native
TypeScript type stripping; `pnpm check` builds and verifies the emitted JavaScript.

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
corepack enable
pnpm install
pnpm check
```

The repository's npm packages are private workspace packages and are not currently published to npm.

## Web UI

DSCode also ships a self-hosted web chat server in `packages/web-ui`. The public Docker Hub image
(`docker.io/aclisp/dsagent`) packages this server for cloud deployment. Run and configure it via the
[web UI README](packages/web-ui/README.md); Compose templates and deployment instructions are in
[deploy/cloud/dscode](deploy/cloud/dscode/README.md).

## Project origins

DSCode originated as a fork of [dscode](https://github.com/thinkany-ai/dscode) and is now developed
independently. See [Upstream integration notes](docs/UPSTREAM.md).

## License

[MIT](LICENSE)
