import {
  type ExtensionUIContext,
  type KeybindingsManager,
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  type Component,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface ScrollableConfirmationOptions<T> {
  title: string;
  titleColor: "error" | "accent";
  content: string;
  summary: string;
  choices: readonly { label: string; value: T }[];
  cancelValue: T;
  confirmLabel: string;
}

/** Bounded content with fixed choices; the first choice is selected by default. */
export function confirmScrollable<T>(
  ui: ExtensionUIContext,
  options: ScrollableConfirmationOptions<T>,
): Promise<T> {
  return ui.custom<T>(
    (tui, theme, keybindings, done) =>
      new ScrollableConfirmationDialog(tui, theme, keybindings, options, done),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 },
    },
  );
}

class ScrollableConfirmationDialog<T> implements Component {
  private readonly contentPreview: ScrollablePreview;
  private readonly prefix: Component[];
  private readonly suffix: Component[];
  private readonly spacers: [Spacer, Spacer, Spacer, Spacer];
  private readonly choices: Container;
  private readonly borderColor: (value: string) => string;
  private contentStartRow = 0;
  private contentViewportHeight = 0;
  private selectedChoice = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: ScrollableConfirmationOptions<T>,
    private readonly done: (value: T) => void,
  ) {
    const contentPreview = new ScrollablePreview(options.content);
    const choices = new Container();
    const spacers: [Spacer, Spacer, Spacer, Spacer] = [
      new Spacer(0),
      new Spacer(0),
      new Spacer(0),
      new Spacer(0),
    ];
    const scrollHint = [
      theme.fg("dim", tui.mode === "fullscreen" ? "Wheel/PgUp/PgDn" : "PgUp/PgDn"),
      theme.fg("muted", " scroll"),
    ].join("");
    const chooseHint =
      theme.fg("dim", formatKeybindingText(keyText("tui.select.up"))) +
      theme.fg("dim", "/") +
      theme.fg("dim", formatKeybindingText(keyText("tui.select.down"))) +
      theme.fg("muted", " choose");
    const actionHint = (
      binding: "tui.select.confirm" | "tui.select.cancel",
      description: string,
    ) =>
      `${theme.fg("dim", formatKeybindingText(keyText(binding)))}${theme.fg("muted", ` ${description}`)}`;

    this.contentPreview = contentPreview;
    this.spacers = spacers;
    this.borderColor = (value) => theme.fg("accent", value);
    this.prefix = [
      new SingleLineText(theme.fg(options.titleColor, theme.bold(options.title))),
      spacers[0],
    ];
    this.suffix = [
      spacers[1],
      new SingleLineText(
        theme.fg("warning", options.summary),
      ),
      spacers[2],
      choices,
      spacers[3],
      new SingleLineText(
        [
          scrollHint,
          chooseHint,
          actionHint("tui.select.confirm", options.confirmLabel),
          actionHint("tui.select.cancel", "cancel"),
        ].join(theme.fg("dim", " · ")),
      ),
    ];
    this.choices = choices;
    this.updateChoices();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const maxHeight = this.getMaxHeight();
    const contentHeight = Math.max(0, maxHeight - 2);
    this.updateSpacing(contentHeight, innerWidth);
    const prefixLines = this.prefix.flatMap((component) => component.render(innerWidth));
    const suffixLines = this.suffix.flatMap((component) => component.render(innerWidth));
    const previewHeight = Math.max(0, contentHeight - prefixLines.length - suffixLines.length);

    this.contentStartRow = prefixLines.length + 1;
    this.contentPreview.setViewportHeight(previewHeight);
    const previewLines = this.contentPreview.render(innerWidth);
    this.contentViewportHeight = previewLines.length;

    const contentLines = [...prefixLines, ...previewLines, ...suffixLines]
      .slice(0, contentHeight)
      .map((line) => this.frameContentLine(line, innerWidth));
    return [
      this.frameBorderLine("┌", "┐", width),
      ...contentLines,
      this.frameBorderLine("└", "┘", width),
    ].slice(0, maxHeight);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.contentPreview.scrollBy(-Math.max(1, this.contentPreview.viewportHeight - 1));
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.contentPreview.scrollBy(Math.max(1, this.contentPreview.viewportHeight - 1));
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedChoice = Math.max(0, this.selectedChoice - 1);
      this.updateChoices();
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedChoice = Math.min(this.options.choices.length - 1, this.selectedChoice + 1);
      this.updateChoices();
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.options.choices[this.selectedChoice]!.value);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(this.options.cancelValue);
    }
  }

  handleMouse(event: TuiMouseEvent): { handled: true; render: boolean } | undefined {
    if (
      event.type !== "wheel" ||
      !event.wheelDelta ||
      event.y < this.contentStartRow ||
      event.y >= this.contentStartRow + this.contentViewportHeight
    ) {
      return undefined;
    }

    return { handled: true, render: this.contentPreview.scrollBy(event.wheelDelta) };
  }

  invalidate(): void {
    for (const component of [...this.prefix, ...this.suffix]) component.invalidate();
    this.contentPreview.invalidate();
  }

  private getMaxHeight(): number {
    const rows = Math.max(1, this.tui.terminal.rows);
    const availableHeight = Math.max(1, rows - 2);
    return Math.max(1, Math.min(Math.floor((rows * 90) / 100), availableHeight));
  }

  private updateSpacing(contentHeight: number, width: number): void {
    for (const spacer of this.spacers) spacer.setLines(0);

    const fixedLines = [...this.prefix, ...this.suffix].reduce(
      (count, component) => count + component.render(width).length,
      0,
    );
    const availableSpacers = Math.min(
      this.spacers.length,
      Math.max(0, contentHeight - fixedLines - 1),
    );
    // Separate the content, summary, choices, and hints when space allows. On
    // short terminals, keep at least one content line and collapse gaps first.
    const priority = [
      1, // content-summary
      2, // summary-choices
      0, // title-content
      3, // choices-hint
    ];
    for (const index of priority.slice(0, availableSpacers)) this.spacers[index]!.setLines(1);
  }

  private frameBorderLine(left: string, right: string, width: number): string {
    return this.borderColor(`${left}${"─".repeat(Math.max(1, width - 2))}${right}`);
  }

  private frameContentLine(line: string, contentWidth: number): string {
    const content = truncateToWidth(line, contentWidth, "");
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
    return `${this.borderColor("│")}${content}${padding}${this.borderColor("│")}`;
  }

  private updateChoices(): void {
    this.choices.clear();
    const options = this.options.choices.map((choice) => choice.label);
    for (let index = 0; index < options.length; index++) {
      const selected = index === this.selectedChoice;
      const label = selected
        ? this.theme.fg("accent", `→ ${options[index]}`)
        : `  ${this.theme.fg("text", options[index]!)}`;
      this.choices.addChild(new Text(label, 1, 0));
    }
  }
}

function formatKeybindingText(text: string): string {
  return text
    .split("/")
    .map((alternative) =>
      alternative
        .split("+")
        .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)
        .join("+"),
    )
    .join("/");
}

class SingleLineText implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    return new Text(truncateToWidth(this.text, contentWidth), 1, 0).render(width).slice(0, 1);
  }

  invalidate(): void {}
}

class ScrollablePreview implements Component {
  private readonly text: Text;
  private scrollTop = 0;
  private currentViewportHeight = 0;
  private contentHeight = 0;

  constructor(content: string) {
    this.text = new Text(content, 1, 0);
  }

  get viewportHeight(): number {
    return this.currentViewportHeight;
  }

  setViewportHeight(height: number): void {
    this.currentViewportHeight = Math.max(0, Math.floor(height));
  }

  scrollBy(lines: number): boolean {
    if (this.currentViewportHeight <= 0) return false;

    const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
    const next = Math.max(0, Math.min(maxScrollTop, this.scrollTop + Math.trunc(lines)));
    if (next === this.scrollTop) return false;

    this.scrollTop = next;
    return true;
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    this.contentHeight = lines.length;
    const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
    this.scrollTop = Math.min(this.scrollTop, maxScrollTop);
    return lines.slice(this.scrollTop, this.scrollTop + this.currentViewportHeight);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}
