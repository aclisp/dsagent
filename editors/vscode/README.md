# DSCode for VS Code

This thin local extension opens the real DSCode TUI inside an integrated terminal and can send:

- the current selection (or a small cursor neighborhood);
- VS Code language diagnostics for the current file.

From a completed repository developer setup, link the local DSCode CLI and package this directory:

```bash
pnpm link --global
cd editors/vscode
npx @vscode/vsce package --no-dependencies
code --install-extension dscode-vscode-0.3.0.vsix
```

Make sure VS Code inherits `DEEPSEEK_API_KEY`, or configure your shell so the integrated terminal can
read it. Set `dscode.executable` if the binary is not on VS Code's `PATH`.

Commands:

- `DSCode: Open Coding Agent`
- `DSCode: Ask About Selection` (`Cmd/Ctrl+Shift+D`)
- `DSCode: Fix File Diagnostics`

For richer custom IDE clients, start `dscode --mode rpc`; it exposes Pi's full JSONL RPC protocol,
including streaming events, session operations, commands, tool state, and extension approval dialogs.
