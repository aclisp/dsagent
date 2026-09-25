<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

<p align="center">
  Your self-hosted AI coding and operations companion, right on your server.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.en.md">Comparison</a>
</p>

## Why DSCode

- **DeepSeek-first, with the freedom to choose.** DSCode pairs DeepSeek Flash with a dedicated Responses
  integration and native free-form patching. Switch to Codex, OpenAI,
  Anthropic, OpenRouter, Z.AI, Kimi, MiniMax, Grok, or OpenCode Zen Go while keeping your tools and sessions.
- **Your AI operations companion, right on the server.** Install DSCode on the Linux server you manage.
  From its TUI, inspect services and workspaces, run and follow commands, and apply patch changes you
  can review and undo. A focused four-tool workflow—`read`, `exec_command`, `write_stdin`, and
  `apply_patch`—covers inspection, command execution, live process control, and reviewable changes.
- **One runtime, from terminal to integration.** Work in the CLI/TUI, embed the same Core through
  REST+SSE, or bring DSCode to a self-hosted Web UI. Live agent and tool activity, interactive requests,
  and persistent sessions let each interface take part in the same workflow.
- **Built-in WeCom turns chats into operational work.** Teammates can message DSCode directly or
  mention it in a group chat to assign tasks, send images and files, and receive replies and generated
  files. Schedule one-time or recurring tasks and have the results delivered to the originating conversation.

DSCode is opinionated by default, lightweight at its core, and flexible where it matters: choose your
model, then use the same runtime from the terminal, REST+SSE API, self-hosted Web UI, or WeCom.

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
