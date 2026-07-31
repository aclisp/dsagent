import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

const PATCH_MARKER = Symbol.for("dscode.markdown-code-blocks");
const THEME_MARKER = Symbol.for("dscode.markdown-theme");

interface RuntimeAssistant {
  markdownTheme: MarkdownTheme;
}

interface RuntimeAssistantPrototype {
  [PATCH_MARKER]?: boolean;
  updateContent(message: unknown): void;
}

type BrandedMarkdownTheme = MarkdownTheme & { [THEME_MARKER]?: boolean };

/** Remove Pi's literal fence rows while retaining parsing and syntax highlighting. */
export function codexStyleMarkdownTheme(theme: MarkdownTheme): MarkdownTheme {
  if ((theme as BrandedMarkdownTheme)[THEME_MARKER]) return theme;
  return {
    ...theme,
    [THEME_MARKER]: true,
    codeBlockBorder: () => "",
    codeBlockIndent: "  ",
  } as BrandedMarkdownTheme;
}

export function installPiMarkdownCodeBlocks(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as RuntimeAssistantPrototype;
  if (prototype[PATCH_MARKER]) return;
  prototype[PATCH_MARKER] = true;
  const originalUpdateContent = prototype.updateContent;
  prototype.updateContent = function (message: unknown): void {
    const component = this as unknown as RuntimeAssistant;
    component.markdownTheme = codexStyleMarkdownTheme(component.markdownTheme);
    originalUpdateContent.call(this, message);
  };
}
