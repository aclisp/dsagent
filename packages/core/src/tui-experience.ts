import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { brandBlue } from "./brand.js";
import type { PermissionMode } from "./config.js";
import { routeDSCodeLogin, scopeLoginSuggestions } from "./login-scope.js";
import type { DSCodeRuntimeOptions } from "./runtime-options.js";
import { isSupportedProviderId } from "./providers.js";
import { DSCODE_VERSION } from "./version.js";
import { DSCodeWelcomeHeader, formatCwd } from "./welcome.js";

export const EDITOR_PLACEHOLDER = "Ask DSCode to change, explain, or test code";
export const HIDDEN_THINKING_LABEL = "DSCode is thinking";
const BLINKING_BLOCK_CURSOR = "\x1b[1 q";
const DEFAULT_CURSOR_STYLE = "\x1b[0 q";

export function registerCodingTui(
  pi: ExtensionAPI,
  options: DSCodeRuntimeOptions,
  getAccess: () => { permission: PermissionMode; sandbox: DSCodeRuntimeOptions["sandbox"]; network: boolean },
): void {
  let activeTui: TUI | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let workingStartedAt = 0;
  let loginAutocompleteInstalled = false;

  const updateModelPresentation = (
    ctx: ExtensionContext,
    model: ExtensionContext["model"] = ctx.model,
  ): void => {
    if (ctx.mode !== "tui") return;
    const modelId = model?.id ?? options.modelId;
    const modelName = model?.name;
    ctx.ui.setHiddenThinkingLabel(formatThinkingLabel(modelName ?? modelId));
    ctx.ui.setHeader(
      (_tui, theme) =>
        new DSCodeWelcomeHeader(
          {
            cwd: ctx.cwd,
            modelId,
            ...(modelName ? { modelName } : {}),
            effort: pi.getThinkingLevel(),
            version: DSCODE_VERSION,
          },
          theme,
        ),
    );
  };

  const stopWorkingTimer = (): void => {
    if (workingTimer) clearInterval(workingTimer);
    workingTimer = undefined;
  };

  pi.on("agent_start", (_event, ctx) => {
    workingStartedAt = Date.now();
    stopWorkingTimer();
    const refresh = (): void => {
      const seconds = Math.max(0, Math.floor((Date.now() - workingStartedAt) / 1_000));
      ctx.ui.setWorkingMessage(`Working (${seconds}s · esc to interrupt)`);
      activeTui?.requestRender();
    };
    refresh();
    workingTimer = setInterval(refresh, 1_000);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopWorkingTimer();
    ctx.ui.setWorkingMessage();
  });

  pi.on("model_select", (event, ctx) => updateModelPresentation(ctx, event.model));
  pi.on("thinking_level_select", (_event, ctx) => updateModelPresentation(ctx));

  pi.on("session_shutdown", () => {
    stopWorkingTimer();
    activeTui?.terminal.write(DEFAULT_CURSOR_STYLE);
    activeTui = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWorkingIndicator({
      frames: ["◦", "○", "●", "○"].map((frame) => brandBlue(frame, ctx.ui.theme)),
      intervalMs: 140,
    });
    ctx.ui.setFooter(() => new EmptyFooter());
    updateModelPresentation(ctx);
    if (!loginAutocompleteInstalled) {
      loginAutocompleteInstalled = true;
      ctx.ui.addAutocompleteProvider((current) => providerAutocomplete(current));
    }

    class DSCodeEditor extends CustomEditor {
      private readonly dscodeTui: TUI;

      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 0 });
        this.dscodeTui = tui;
        activeTui = tui;
        tui.terminal.write(BLINKING_BLOCK_CURSOR);
      }

      render(width: number): string[] {
        if (width <= 0) return [];
        const sourceWidth = Math.max(1, width - 2);
        const lines = super.render(sourceWidth);
        if (lines.length < 3) return lines;
        const theme = ctx.ui.theme;
        const access = getAccess();
        const model = ctx.model?.id ?? options.modelId;
        const effort = pi.getThinkingLevel();
        const autocompleteStart = findAutocompleteStart(lines);
        const bottomIndex = autocompleteStart - 1;
        if (bottomIndex < 2) return lines;

        const hardwareCursor = this.dscodeTui.getShowHardwareCursor();
        const content = lines
          .slice(1, bottomIndex)
          .map((line) => (hardwareCursor ? stripFakeCursorHighlight(line) : line));
        if (this.getText().length === 0 && content.length > 0) {
          content[0] = renderEditorPlaceholder(theme, hardwareCursor);
        }
        const panel = [
          panelLine("", width, theme),
          ...content.map((line, index) =>
            panelLine(
              `${index === 0 ? `${brandBlue(">", theme)} ` : "  "}${line.trimEnd()}`,
              width,
              theme,
            ),
          ),
          panelLine("", width, theme),
        ];
        const autocomplete = lines
          .slice(autocompleteStart)
          .map((line) => padLine(`  ${line.trimEnd()}`, width));
        const status = renderMinimalStatus(
          width,
          {
            model,
            effort,
            permission: access.permission,
            sandbox: access.sandbox,
            network: access.network,
            cwd: ctx.cwd,
            contextPercent: ctx.getContextUsage()?.percent ?? null,
          },
          theme,
        );
        return [...panel, ...autocomplete, status];
      }
    }

    let editor: DSCodeEditor | undefined;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new DSCodeEditor(tui, theme, keybindings);
      return editor;
    });
    if (editor?.onSubmit) {
      const submit = editor.onSubmit;
      editor.onSubmit = (text) => {
        const currentProvider = ctx.model?.provider;
        const route = routeDSCodeLogin(
          text,
          currentProvider && isSupportedProviderId(currentProvider)
            ? currentProvider
            : options.providerId,
        );
        if (route.action === "reject") {
          editor?.setText("");
          ctx.ui.notify(
            "Supported providers: deepseek, openai-codex, and openai. Use /login.",
            "warning",
          );
          return;
        }
        submit(route.text);
      };
    }
  });
}

export function formatThinkingLabel(modelName?: string): string {
  const name = modelName?.trim();
  return name ? `${name} is thinking` : HIDDEN_THINKING_LABEL;
}

export function renderEditorPlaceholder(theme: Theme, hardwareCursor: boolean): string {
  if (hardwareCursor) {
    return `${CURSOR_MARKER}${theme.fg("dim", EDITOR_PLACEHOLDER)}`;
  }
  return `${CURSOR_MARKER}${theme.inverse(EDITOR_PLACEHOLDER[0]!)}${theme.fg(
    "dim",
    EDITOR_PLACEHOLDER.slice(1),
  )}`;
}

export function stripFakeCursorHighlight(line: string): string {
  const markerEnd = line.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length;
  if (markerEnd < CURSOR_MARKER.length || !line.startsWith("\x1b[7m", markerEnd)) return line;
  const characterStart = markerEnd + "\x1b[7m".length;
  const resetStart = line.indexOf("\x1b[0m", characterStart);
  if (resetStart === -1) return line;
  return `${line.slice(0, markerEnd)}${line.slice(characterStart, resetStart)}${line.slice(
    resetStart + "\x1b[0m".length,
  )}`;
}

function providerAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions) return null;
      const text = lines[cursorLine]?.slice(0, cursorCol) ?? "";
      return { ...suggestions, items: scopeLoginSuggestions(text, suggestions.items) };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    ...(current.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
            current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
        }
      : {}),
  };
}

export interface MinimalStatusDetails {
  model: string;
  effort: string;
  permission: PermissionMode;
  sandbox: DSCodeRuntimeOptions["sandbox"];
  network: boolean;
  cwd: string;
  contextPercent: number | null;
}

export function minimalStatusParts(details: MinimalStatusDetails): string[] {
  const parts = [`${details.model}  ${details.effort}`];
  if (details.permission === "plan") parts.push("plan");
  if (details.permission !== "plan" && details.sandbox === "danger-full-access") {
    parts.push("danger full access");
  } else if (details.permission === "full") {
    parts.push("full permission");
  }
  if (details.network && details.sandbox !== "danger-full-access") parts.push("network");
  if (details.contextPercent !== null && details.contextPercent >= 70) {
    parts.push(`ctx ${details.contextPercent.toFixed(0)}%`);
  }
  parts.push(formatCwd(details.cwd));
  return parts;
}

export function renderMinimalStatus(
  width: number,
  details: MinimalStatusDetails,
  theme: Theme,
): string {
  if (width <= 0) return "";
  const parts = minimalStatusParts(details);
  const painted = parts.map((part, index) => {
    if (index === 0) return brandBlue(part, theme);
    if (index === parts.length - 1) return theme.fg("text", part);
    if (
      part === "danger full access" ||
      (part.startsWith("ctx ") && (details.contextPercent ?? 0) >= 90)
    ) {
      return theme.fg("error", part);
    }
    if (part === "plan" || part === "full permission" || part.startsWith("ctx ")) {
      return theme.fg("warning", part);
    }
    return theme.fg("muted", part);
  });
  return truncateToWidth(
    `  ${painted.join(theme.fg("dim", " · "))}`,
    width,
    theme.fg("dim", "…"),
  );
}

export function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!usage || usage.percent === null || !contextWindow) return "ctx ?";
  return `${usage.percent.toFixed(1)}%/${compactNumber(contextWindow)}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function findAutocompleteStart(lines: string[]): number {
  // The editor's final border is the last full-width horizontal line; autocomplete rows follow it.
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (lines[index]?.includes("─")) return index + 1;
  }
  return lines.length;
}

function padLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function panelLine(line: string, width: number, theme: Theme): string {
  const background = theme.getBgAnsi("userMessageBg");
  const padded = padLine(line, width).replaceAll("\x1b[0m", `\x1b[0m${background}`);
  return `${background}${padded}\x1b[49m`;
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}
