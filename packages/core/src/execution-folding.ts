import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  getSelectListTheme,
  InteractiveMode,
  ToolExecutionComponent,
  type AgentSessionEvent,
  type ExtensionAPI,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";

const PATCH_MARKER = Symbol.for("dscode.execution-folding");

interface CompletedExecution {
  user: SessionMessageEntry;
  final: SessionMessageEntry;
  durationMs: number;
}

/** Use entry timestamps: assistant message timestamps can precede streaming. */
export function findCompletedExecutions(entries: readonly SessionEntry[]): CompletedExecution[] {
  const completed: CompletedExecution[] = [];
  let user: SessionMessageEntry | undefined;
  let last: SessionMessageEntry | undefined;
  const finish = (): void => {
    if (!user || !last || last.message.role !== "assistant") return;
    const message = last.message;
    if (
      message.stopReason !== "stop" ||
      !message.content?.some((part) => part.type === "text" && part.text.trim()) ||
      message.content.some((part) => part.type === "toolCall")
    ) return;
    const durationMs = Date.parse(last.timestamp) - Date.parse(user.timestamp);
    if (Number.isFinite(durationMs) && durationMs >= 0) completed.push({ user, final: last, durationMs });
  };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      finish();
      user = last = undefined;
    } else if (entry.type === "message") {
      if (entry.message.role === "user") {
        finish();
        user = entry;
        last = undefined;
      } else if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
        last = entry;
      }
    }
  }
  finish();
  return completed;
}

export function formatWorkedDuration(durationMs: number): string {
  const total = Math.floor(durationMs / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  return `Worked for ${hours ? `${hours}h ${minutes}m ` : minutes ? `${minutes}m ` : ""}${seconds}s`;
}

interface RuntimeInteractiveMode {
  chatContainer: Container;
  renderer: TUI & { resetTextSelection?(): void };
  ui: Pick<TUI, "requestRender">;
  outputPad: number;
  session: { isStreaming: boolean };
  sessionManager: { getBranch(): SessionEntry[] };
  toolOutputExpanded: boolean;
  setToolsExpanded(expanded: boolean): void;
}

interface RuntimeInteractivePrototype {
  [PATCH_MARKER]?: boolean;
  addMessageToChat(this: RuntimeInteractiveMode, message: AgentMessage, ...args: unknown[]): void;
  renderSessionEntries(this: RuntimeInteractiveMode, ...args: unknown[]): void;
  handleEvent(this: RuntimeInteractiveMode, event: AgentSessionEvent): Promise<void>;
  setToolsExpanded(this: RuntimeInteractiveMode, expanded: boolean): void;
  toggleToolOutputExpansion(this: RuntimeInteractiveMode): void;
  switchTuiMode(this: RuntimeInteractiveMode, ...args: unknown[]): boolean;
}

type Expandable = Component & { setExpanded(expanded: boolean): void };
const isExpandable = (component: Component): component is Expandable =>
  "setExpanded" in component && typeof component.setExpanded === "function";

interface ExecutionGroup {
  members: Component[];
  final: AssistantMessageComponent;
  thinking: Component | undefined;
  answer: Component;
  expanded: boolean;
  summary: Component;
}

interface RuntimeAssistant {
  lastMessage?: AssistantMessage;
  contentContainer: Container;
}

interface RuntimeTool {
  expanded: boolean;
}

/**
 * Pi's contentContainer has Markdown for text and MouseRegion for thinking.
 * Reuse those children, including their original thinking click handlers, so
 * settings and theme updates still come from the complete original component.
 * Each projection needs its own Container for independent mouse coordinates.
 */
function assistantPart(component: AssistantMessageComponent, thinking: boolean): Component {
  const view = new Container();
  const spacer = new Spacer(1);
  return {
    render(width) {
      const content = (component as unknown as RuntimeAssistant).contentContainer;
      const selected = content.children.filter((child) =>
        !(child instanceof Spacer) && (child instanceof MouseRegion) === thinking,
      );
      view.children = selected.length > 0 ? [spacer, ...selected] : [];
      if (thinking) return view.render(width);
      // Preserve Pi's semantic prompt markers for the answer, without changing
      // lastMessage, its content, or the persisted session entry.
      const original = component.children;
      component.children = [view];
      try { return component.render(width); } finally { component.children = original; }
    },
    handleMouse: (event) => view.handleMouse(event),
    invalidate: () => view.invalidate(),
  };
}

/** Keep Pi's flat component tree intact for theme, image, thinking and tool updates. */
class ExecutionFolding {
  readonly messages = new WeakMap<Component, AgentMessage>();
  private groups = new Map<string, ExecutionGroup>();
  private owners = new WeakMap<Component, ExecutionGroup>();
  private entriesBeforeRun: Set<string> | undefined;
  private readonly runtime: RuntimeInteractiveMode;

  constructor(runtime: RuntimeInteractiveMode) {
    this.runtime = runtime;
    const chat = runtime.chatContainer;
    const render = chat.render;
    const handleMouse = chat.handleMouse;
    chat.render = (width) => this.withVisibleChildren(() => render.call(chat, width));
    chat.handleMouse = (event) => this.withVisibleChildren(() => handleMouse.call(chat, event));
  }

  private messageOf(component: Component): AgentMessage | undefined {
    // Pi retains the final streamed message here; unlike message_start it has
    // complete tool arguments. Keep this original message even when projecting.
    return component instanceof AssistantMessageComponent
      ? (component as unknown as RuntimeAssistant).lastMessage
      : this.messages.get(component);
  }

  begin(): void {
    this.entriesBeforeRun ??= new Set(this.runtime.sessionManager.getBranch().map((entry) => entry.id));
  }

  finish(aborted: boolean): void {
    this.entriesBeforeRun = undefined;
    const entries = this.runtime.sessionManager.getBranch();
    const last = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!aborted && last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "stop") {
      this.refresh();
    }
  }

  refresh(): void {
    if (this.runtime.renderer.mode !== "fullscreen") return;
    const children = this.runtime.chatContainer.children;
    const positions = new Map<AgentMessage, number>();
    const barriers: number[] = [];
    children.forEach((child, index) => {
      const message = this.messageOf(child);
      if (message) positions.set(message, index);
      if (message?.role === "compactionSummary" || message?.role === "branchSummary") barriers.push(index);
    });
    const next = new Map<string, ExecutionGroup>();
    for (const execution of findCompletedExecutions(this.runtime.sessionManager.getBranch())) {
      // Compaction can rebuild the transcript during a run. Never fold a new
      // segment until retries and queued continuations have settled.
      if (this.runtime.session.isStreaming && !this.entriesBeforeRun?.has(execution.final.id)) continue;
      const start = positions.get(execution.user.message);
      const end = positions.get(execution.final.message);
      if (start === undefined || end === undefined || end <= start || barriers.some((i) => i > start && i < end)) continue;
      const final = children[end];
      if (!(final instanceof AssistantMessageComponent)) continue;
      const message = this.messageOf(final);
      const hasThinking = message?.role === "assistant" && message.content.some((part) =>
        part.type === "thinking" && part.thinking.trim(),
      );
      const members = children.slice(start + 1, end);
      if (!hasThinking && !members.some((child) => {
        if (child instanceof Spacer) return false;
        if (!(child instanceof AssistantMessageComponent)) return true;
        const message = this.messageOf(child);
        return message?.role === "assistant" && message.content?.some((part) =>
          part.type === "toolCall" || (part.type === "text" && part.text.trim()) || (part.type === "thinking" && part.thinking.trim()),
        );
      })) continue;
      const previous = this.groups.get(execution.final.id);
      const group = previous && previous.final === final && previous.members.length === members.length && previous.members.every((child, i) => child === members[i])
        ? previous
        : this.createGroup(members, final, hasThinking, execution.durationMs);
      next.set(execution.final.id, group);
    }
    this.groups = next;
    this.owners = new WeakMap();
    for (const group of next.values()) {
      for (const child of group.members) this.owners.set(child, group);
      this.owners.set(group.final, group);
    }
    this.runtime.renderer.resetTextSelection?.();
    this.runtime.ui.requestRender();
  }

  toggleAll(): void {
    if (this.runtime.renderer.mode !== "fullscreen" || this.groups.size === 0) return;
    const expanded = [...this.groups.values()].some((group) => !group.expanded);
    for (const group of this.groups.values()) this.setGroupExpanded(group, expanded);
    this.runtime.renderer.resetTextSelection?.();
    this.runtime.ui.requestRender();
  }

  private resetTools(group: ExecutionGroup): void {
    for (const child of group.members) if (isExpandable(child)) child.setExpanded(false);
  }

  private setGroupExpanded(group: ExecutionGroup, expanded: boolean): void {
    if (group.expanded === expanded) return;
    group.expanded = expanded;
    this.resetTools(group);
  }

  private createGroup(
    members: Component[],
    final: AssistantMessageComponent,
    hasThinking: boolean,
    durationMs: number,
  ): ExecutionGroup {
    const summary = new Container();
    const group: ExecutionGroup = {
      members,
      final,
      thinking: hasThinking ? assistantPart(final, true) : undefined,
      answer: hasThinking ? assistantPart(final, false) : final,
      expanded: false,
      summary,
    };
    this.resetTools(group);
    summary.addChild(new Spacer(1));
    summary.addChild(new MouseRegion({
      render: (width) => new Text(
        getSelectListTheme().description(`${formatWorkedDuration(durationMs)}${group.expanded ? "" : " ›"}`),
        this.runtime.outputPad,
        0,
      ).render(width),
      invalidate() {},
    }, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      this.setGroupExpanded(group, !group.expanded);
      this.runtime.renderer.resetTextSelection?.();
      this.runtime.ui.requestRender();
      return { handled: true };
    }));
    return group;
  }

  private withVisibleChildren<T>(action: () => T): T {
    if (this.runtime.renderer.mode !== "fullscreen" || this.groups.size === 0) return action();
    const chat = this.runtime.chatContainer;
    const original = chat.children;
    const visible: Component[] = [];
    for (const child of original) {
      const group = this.owners.get(child);
      if (!group) {
        visible.push(child);
      } else {
        if ((group.members[0] ?? group.final) === child) visible.push(group.summary);
        if (child === group.final) {
          if (group.expanded && group.thinking) visible.push(group.thinking);
          visible.push(group.answer);
        } else if (group.expanded) {
          visible.push(child);
        }
      }
    }
    // Container records mouse bounds from exactly these rendered children.
    // Restore the actual tree before any other Pi update can observe it.
    chat.children = visible;
    try { return action(); } finally { chat.children = original; }
  }

  withVisibleTools<T>(action: () => T): T {
    if (this.runtime.renderer.mode !== "fullscreen") return action();
    const restore: Array<() => void> = [];
    for (const child of this.runtime.chatContainer.children) {
      if (!this.owners.get(child) || this.owners.get(child)?.expanded || !isExpandable(child)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(child, "setExpanded");
      Object.defineProperty(child, "setExpanded", { configurable: true, writable: true, value: () => {} });
      restore.push(() => {
        if (descriptor) Object.defineProperty(child, "setExpanded", descriptor);
        else Reflect.deleteProperty(child, "setExpanded");
      });
    }
    try { return action(); } finally { for (const reset of restore) reset(); }
  }

  nextToolExpansion(): boolean | undefined {
    if (this.runtime.renderer.mode !== "fullscreen") return undefined;
    const tools = this.runtime.chatContainer.children.filter((child) => {
      const owner = this.owners.get(child);
      return (!owner || owner.expanded) &&
        (child instanceof ToolExecutionComponent || child instanceof BashExecutionComponent);
    });
    // With no visible tools, keep Pi's header/resource toggle behavior.
    if (tools.length === 0) return undefined;
    return tools.some((child) => !(child as unknown as RuntimeTool).expanded);
  }
}

// The public shortcut context and InteractiveMode share the session manager.
// Weak keys keep this bridge scoped to the active session without extra Pi hooks.
const foldingsBySession = new WeakMap<RuntimeInteractiveMode["sessionManager"], ExecutionFolding>();

export function registerDSCodeExecutionFoldingShortcut(pi: Pick<ExtensionAPI, "registerShortcut">): void {
  pi.registerShortcut("alt+o", {
    description: "Toggle all fullscreen execution processes",
    handler: (ctx) => {
      if (ctx.mode === "tui") foldingsBySession.get(ctx.sessionManager)?.toggleAll();
    },
  });
}

/**
 * Adapter for the pinned Pi InteractiveMode. No source/build transformations:
 * the shared CLI entry installs this for Node bundles and Bun standalone alike.
 * Check these six methods, InteractiveMode.toolOutputExpanded, tool components'
 * expanded flag, and AssistantMessageComponent.lastMessage and contentContainer
 * (thinking MouseRegions, text Markdown) on upgrades.
 */
export function installDSCodeExecutionFolding(): void {
  const prototype = InteractiveMode.prototype as unknown as RuntimeInteractivePrototype;
  if (prototype[PATCH_MARKER]) return;
  for (const name of ["addMessageToChat", "renderSessionEntries", "handleEvent", "setToolsExpanded", "toggleToolOutputExpansion", "switchTuiMode"] as const) {
    if (typeof prototype[name] !== "function") throw new Error(`Pi InteractiveMode.${name} changed; review DSCode execution folding`);
  }
  const states = new WeakMap<RuntimeInteractiveMode, ExecutionFolding>();
  const stateFor = (runtime: RuntimeInteractiveMode): ExecutionFolding => {
    let state = states.get(runtime);
    if (!state) { state = new ExecutionFolding(runtime); states.set(runtime, state); }
    // /new and /resume can replace the manager while retaining InteractiveMode.
    foldingsBySession.set(runtime.sessionManager, state);
    return state;
  };
  const addMessage = prototype.addMessageToChat;
  prototype.addMessageToChat = function (message, ...args): void {
    const state = stateFor(this);
    const before = this.chatContainer.children.length;
    addMessage.call(this, message, ...args);
    for (const child of this.chatContainer.children.slice(before)) state.messages.set(child, message);
  };
  const renderEntries = prototype.renderSessionEntries;
  prototype.renderSessionEntries = function (...args): void {
    const state = stateFor(this);
    renderEntries.apply(this, args);
    state.refresh();
  };
  const handleEvent = prototype.handleEvent;
  prototype.handleEvent = async function (event): Promise<void> {
    const state = stateFor(this);
    if (event.type === "agent_start") state.begin();
    await handleEvent.call(this, event);
    if (event.type === "agent_settled") state.finish(event.aborted);
  };
  const setToolsExpanded = prototype.setToolsExpanded;
  prototype.setToolsExpanded = function (expanded): void {
    stateFor(this).withVisibleTools(() => setToolsExpanded.call(this, expanded));
  };
  const toggleTools = prototype.toggleToolOutputExpansion;
  prototype.toggleToolOutputExpansion = function (): void {
    const expanded = stateFor(this).nextToolExpansion();
    if (expanded === undefined) { toggleTools.call(this); return; }
    // Parent resets and mouse clicks can leave Pi's remembered flag already at
    // the desired value. Let its original setter apply the state and side effects
    // instead of returning early; hidden tools remain protected by the wrapper.
    const previous = this.toolOutputExpanded;
    this.toolOutputExpanded = !expanded;
    try { this.setToolsExpanded(expanded); } catch (error) {
      this.toolOutputExpanded = previous;
      throw error;
    }
  };
  const switchMode = prototype.switchTuiMode;
  prototype.switchTuiMode = function (...args): boolean {
    const switched = switchMode.apply(this, args);
    if (switched && this.renderer.mode === "fullscreen") stateFor(this).refresh();
    return switched;
  };
  prototype[PATCH_MARKER] = true;
}
