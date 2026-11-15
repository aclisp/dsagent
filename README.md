<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

<p align="center">
  A heavily customized Pi coding agent.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.en.md">Comparison</a>
</p>

## Why DSCode

- **A harness you can inspect and control.** DSCode is an open-source agent harness: inspect and
  change its prompts, tools, permissions, and runtime behavior. Use your chosen LLM API without
  relying on a provider-controlled agent harness.
- **A personal and team agent in WeCom.** Message DSCode privately or mention it in a group to
  delegate tasks, exchange files, and schedule recurring work.

## How DSCode builds on Pi

- **Permissions and sandboxing:** `ask`, `auto`, and `full` permission modes control approvals;
  command sandbox and network settings provide separate execution boundaries. In `auto` mode,
  potentially destructive commands require approval.
- **Long-running processes:** `exec_command` and `write_stdin` can start, monitor, interact with,
  and terminate managed processes.
- **Checkpoints and undo:** `apply_patch` adds, edits, deletes, or moves files and saves checkpoints
  for successful patches; `/undo` checks for conflicts before restoring changes.
- **DeepSeek and images:** For official `deepseek-flash` Responses requests, uploaded images can
  be reused via `file_id` instead of repeatedly sending their bytes.
- **Web research:** DeepSeek-backed `web_search` and `web_fetch` are available on demand to all chat
  providers when DeepSeek credentials and network access are available.
- **Shared runtime:** The CLI/TUI, REST+SSE API, and Web UI use the same Core runtime, exposing
  live agent activity and interactive confirmations and choices.
- **Interaction and diagnostics:** The fullscreen TUI groups and folds completed execution steps;
  `/status` and `/doctor` expose runtime information.

## Quick start

### Standalone executable (recommended)

Start with a standalone executable. No Node.js, Bun, package manager, or source build is required.

1. Open [GitHub Releases](https://github.com/aclisp/dsagent/releases) and download the archive for your computer from **Assets**:

   | Computer | Download |
   | --- | --- |
   | macOS with Apple Silicon (M1 or later) | `dscode-v<version>-darwin-arm64.tar.gz` |
   | Linux x86_64 / AMD64 | `dscode-v<version>-linux-x64.tar.gz` |
   | Windows 11 x64 (preview) | `dscode-v<version>-windows-x64.zip` |

2. Extract the archive and open a terminal in the extracted folder.
3. Start DSCode:

```bash
./dscode
```

On Windows, run `./dscode.exe` from PowerShell or Windows Terminal. Only the executable is needed;
you can move it to any folder. The included `dscode.sha256` (Windows: `dscode.exe.sha256`) file is
its checksum. Windows preview limitations and validation steps are listed in the
[standalone guide](standalone/README.md#windows-11-preview). The macOS
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

Use Node.js 26.x and pnpm 12.x. `pnpm dev` runs the CLI source with Node's native
TypeScript type stripping; `pnpm check` builds and verifies the emitted JavaScript.

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
npm install --global pnpm@12
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
