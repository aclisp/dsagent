const vscode = require("vscode");

let terminal;
let startupTimer;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.text = "$(sparkle) DSCode";
  status.tooltip = "Open the DSCode coding agent";
  status.command = "dscode.open";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("dscode.open", () => ensureTerminal(true)),
    vscode.commands.registerCommand("dscode.askSelection", askSelection),
    vscode.commands.registerCommand("dscode.fixDiagnostics", fixDiagnostics),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) terminal = undefined;
    }),
  );
}

function deactivate() {
  if (startupTimer) clearTimeout(startupTimer);
}

async function askSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a file before sending editor context to DSCode.");
    return;
  }
  const document = editor.document;
  const selection = editor.selection;
  const question = await vscode.window.showInputBox({
    title: "Ask DSCode",
    prompt: "What should DSCode do with this editor context?",
    placeHolder: "Explain, review, refactor, or fix…",
  });
  if (!question) return;
  const selected = selection.isEmpty
    ? document.getText(
        new vscode.Range(
          Math.max(0, selection.active.line - 20),
          0,
          Math.min(document.lineCount - 1, selection.active.line + 20),
          document.lineAt(Math.min(document.lineCount - 1, selection.active.line + 20)).text.length,
        ),
      )
    : document.getText(selection);
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const prompt = [
    question,
    "",
    `Editor context from ${relative}:${selection.start.line + 1}:`,
    "```",
    selected.slice(0, 50_000),
    "```",
    "",
    "Inspect the workspace before changing files and preserve unrelated edits.",
  ].join("\n");
  sendPrompt(prompt);
}

async function fixDiagnostics() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a file with diagnostics first.");
    return;
  }
  const diagnostics = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
    .slice(0, 100);
  if (diagnostics.length === 0) {
    void vscode.window.showInformationMessage("No errors or warnings in the active file.");
    return;
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  const rendered = diagnostics
    .map(
      (item) =>
        `${relative}:${item.range.start.line + 1}:${item.range.start.character + 1} ` +
        `[${item.source ?? "diagnostic"}${item.code ? ` ${String(item.code)}` : ""}] ${item.message}`,
    )
    .join("\n");
  sendPrompt(
    `Fix the following IDE diagnostics. Inspect the surrounding code, preserve unrelated changes, and run relevant checks.\n\n${rendered}`,
  );
}

function ensureTerminal(focus) {
  if (!terminal) {
    const folder = activeWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting DSCode.");
      return undefined;
    }
    const configuration = vscode.workspace.getConfiguration("dscode");
    terminal = vscode.window.createTerminal({
      name: "DSCode",
      cwd: folder.uri.fsPath,
      shellPath: configuration.get("executable", "dscode"),
      shellArgs: ["-C", folder.uri.fsPath, ...configuration.get("extraArgs", [])],
      iconPath: new vscode.ThemeIcon("sparkle"),
    });
    terminal.show();
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
    }, 750);
  } else if (focus) {
    terminal.show();
  }
  return terminal;
}

function sendPrompt(prompt) {
  const target = ensureTerminal(true);
  if (!target) return;
  const deliver = () => target.sendText(prompt, true);
  if (startupTimer) setTimeout(deliver, 800);
  else deliver();
}

function activeWorkspaceFolder() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

module.exports = { activate, deactivate };
