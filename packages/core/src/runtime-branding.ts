import path from "node:path";
import {
  hasTrustRequiringProjectResources,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";

const PATCH_MARKER = Symbol.for("dscode.runtime-branding");

interface RuntimeInteractiveMode {
  ui: {
    terminal: {
      setTitle(title: string): void;
    };
  };
  sessionManager: {
    getCwd(): string;
    getSessionName(): string | undefined;
  };
  settingsManager: {
    isProjectTrusted(): boolean;
  };
  chatContainer: {
    children: unknown[];
    addChild(child: unknown): void;
  };
}

interface RuntimeInteractivePrototype {
  [PATCH_MARKER]?: boolean;
  updateTerminalTitle(this: RuntimeInteractiveMode): void;
  renderProjectTrustWarningIfNeeded(this: RuntimeInteractiveMode): void;
}

export function installDSCodeRuntimeBranding(): void {
  const prototype = InteractiveMode.prototype as unknown as RuntimeInteractivePrototype;
  if (prototype[PATCH_MARKER]) return;
  prototype[PATCH_MARKER] = true;

  prototype.updateTerminalTitle = function (): void {
    const cwd = path.basename(this.sessionManager.getCwd());
    const session = this.sessionManager.getSessionName();
    this.ui.terminal.setTitle(session ? `DSCode — ${session} — ${cwd}` : `DSCode — ${cwd}`);
  };

  prototype.renderProjectTrustWarningIfNeeded = function (): void {
    const cwd = this.sessionManager.getCwd();
    if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
      return;
    }
    if (this.chatContainer.children.length > 0) {
      this.chatContainer.addChild(new Spacer(1));
    }
    this.chatContainer.addChild(
      new Text(
        "This project is not trusted. Project-local DSCode settings, packages, and extensions are disabled. Use /trust to save a decision, then restart DSCode.",
        1,
        0,
      ),
    );
  };
}
