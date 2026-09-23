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
import {
  DEFAULT_DANGEROUS_COMMAND_INTENT,
  type DangerousCommandResult,
} from "./dangerous-command.js";

/** Terminal confirmation with a scrollable command and a fixed decision area. */
export function confirmDestructiveCommand(
  ui: ExtensionUIContext,
  command: string,
  assessment: DangerousCommandResult,
): Promise<boolean> {
  return ui.custom(
    (tui, theme, keybindings, done) =>
      new DestructiveCommandDialog(tui, theme, keybindings, command, assessment, done),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 },
    },
  );
}

class DestructiveCommandDialog implements Component {
  private readonly commandPreview: CommandPreview;
  private readonly prefix: Component[];
  private readonly suffix: Component[];
  private readonly spacers: [Spacer, Spacer, Spacer, Spacer];
  private readonly choices: Container;
  private readonly borderColor: (value: string) => string;
  private commandStartRow = 0;
  private commandViewportHeight = 0;
  private selectedChoice = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    command: string,
    assessment: DangerousCommandResult,
    private readonly done: (approved: boolean) => void,
  ) {
    const commandPreview = new CommandPreview(command);
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

    this.commandPreview = commandPreview;
    this.spacers = spacers;
    this.borderColor = (value) => theme.fg("accent", value);
    this.prefix = [
      new SingleLineText(theme.fg("error", theme.bold("Run destructive command?"))),
      spacers[0],
    ];
    this.suffix = [
      spacers[1],
      new SingleLineText(
        theme.fg("warning", assessment.intent ?? DEFAULT_DANGEROUS_COMMAND_INTENT),
      ),
      spacers[2],
      choices,
      spacers[3],
      new SingleLineText(
        [
          scrollHint,
          chooseHint,
          actionHint("tui.select.confirm", "run"),
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
    const commandHeight = Math.max(0, contentHeight - prefixLines.length - suffixLines.length);

    this.commandStartRow = prefixLines.length + 1;
    this.commandPreview.setViewportHeight(commandHeight);
    const commandLines = this.commandPreview.render(innerWidth);
    this.commandViewportHeight = commandLines.length;

    const contentLines = [...prefixLines, ...commandLines, ...suffixLines]
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
      this.commandPreview.scrollBy(-Math.max(1, this.commandPreview.viewportHeight - 1));
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.commandPreview.scrollBy(Math.max(1, this.commandPreview.viewportHeight - 1));
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedChoice = Math.max(0, this.selectedChoice - 1);
      this.updateChoices();
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedChoice = Math.min(1, this.selectedChoice + 1);
      this.updateChoices();
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.selectedChoice === 0);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(false);
    }
  }

  handleMouse(event: TuiMouseEvent): { handled: true; render: boolean } | undefined {
    if (
      event.type !== "wheel" ||
      !event.wheelDelta ||
      event.y < this.commandStartRow ||
      event.y >= this.commandStartRow + this.commandViewportHeight
    ) {
      return undefined;
    }

    return { handled: true, render: this.commandPreview.scrollBy(event.wheelDelta) };
  }

  invalidate(): void {
    for (const component of [...this.prefix, ...this.suffix]) component.invalidate();
    this.commandPreview.invalidate();
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
    // Separate the command, intent, choices, and hints when space allows. On
    // short terminals, keep at least one command line and collapse gaps first.
    const priority = [
      1, // command-intent
      2, // intent-choices
      0, // title-command
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
    const options = ["Run command", "Cancel"];
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

class CommandPreview implements Component {
  private readonly text: Text;
  private scrollTop = 0;
  private currentViewportHeight = 0;
  private contentHeight = 0;

  constructor(command: string) {
    this.text = new Text(command, 1, 0);
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
