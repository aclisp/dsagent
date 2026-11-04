import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  initTheme,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findCompletedExecutions,
  formatWorkedDuration,
  installDSCodeExecutionFolding,
  registerDSCodeExecutionFoldingShortcut,
} from "../packages/core/src/execution-folding.ts";
import { renderCollapsibleToolResult, renderToolCall } from "../packages/core/src/tool-ui.ts";

const user = (text = "USER"): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop", tools: string[] = []): AssistantMessage => ({
  role: "assistant", content: [
    { type: "text", text },
    ...tools.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })),
  ], api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 0, stopReason,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
let sequence = 0;
function entry(message: AgentMessage, ms = 0): SessionEntry {
  return { type: "message", id: `entry-${++sequence}`, parentId: null, timestamp: new Date(ms).toISOString(), message };
}
function execution(start = 0, label = "A"): SessionEntry[] {
  const final = assistant(`FINAL_${label}`);
  final.content.unshift({ type: "thinking", thinking: `FINAL_REASONING_${label}` });
  return [
    entry(user(`USER_${label}`), start),
    entry(assistant(`PROGRESS_${label}`, "toolUse", [`${label}_1`, `${label}_2`]), start + 1_000),
    ...[1, 2].map((i) => entry({
      role: "toolResult", toolCallId: `${label}_${i}`, toolName: "read", isError: false,
      content: [{ type: "text", text: Array.from({ length: 20 }, (_, n) => `${label}_${i}_OUTPUT_${n}`).join("\n") }],
      timestamp: 0,
    }, start + 2_000)),
    entry(final, start + 193_000),
  ];
}

describe("execution boundaries and persisted elapsed time", () => {
  it("uses entry completion timestamps and partitions at every user message", () => {
    const entries = [...execution(), ...execution(300_000, "B")];
    const groups = findCompletedExecutions(entries);
    expect(groups.map((group) => group.durationMs)).toEqual([193_000, 193_000]);
    expect(groups.map((group) => group.user.message)).toMatchObject([
      { role: "user", content: "USER_A" },
      { role: "user", content: "USER_B" },
    ]);
    expect(formatWorkedDuration(193_000)).toBe("Worked for 3m 13s");
    expect(formatWorkedDuration(12_999)).toBe("Worked for 12s");
    expect(formatWorkedDuration(3_661_000)).toBe("Worked for 1h 1m 1s");
  });

  it.each(["aborted", "error", "length", "toolUse"] as const)("does not mistake %s for a final answer", (reason) => {
    const entries = execution();
    entries[entries.length - 1] = entry(assistant("INCOMPLETE", reason), 193_000);
    expect(findCompletedExecutions(entries)).toEqual([]);
  });

  it("requires a terminal answer with text and no tool calls", () => {
    expect(findCompletedExecutions([entry(user()), entry(assistant("", "stop"), 1_000)])).toEqual([]);
    expect(findCompletedExecutions([entry(user()), entry(assistant("text", "stop", ["call"]), 1_000)])).toEqual([]);
    const entries = execution();
    entries.push(entry({ role: "toolResult", toolCallId: "late", toolName: "read", isError: false, content: [], timestamp: 0 }, 194_000));
    expect(findCompletedExecutions(entries)).toEqual([]);
  });

  it("does not bridge summaries, missing users or invalid elapsed times", () => {
    const entries = execution();
    for (const barrier of [
      { type: "compaction" as const, id: "compact", parentId: null, timestamp: new Date(2_000).toISOString(), summary: "COMPACT", firstKeptEntryId: "x", tokensBefore: 1 },
      { type: "branch_summary" as const, id: "branch", parentId: null, timestamp: new Date(2_000).toISOString(), summary: "BRANCH", fromId: "x" },
    ]) expect(findCompletedExecutions([entries[0]!, entries[1]!, barrier, entries.at(-1)!])).toEqual([]);
    expect(findCompletedExecutions(entries.slice(1))).toEqual([]);
    expect(findCompletedExecutions([{ ...entries[0]!, timestamp: "invalid" }, ...entries.slice(1)])).toEqual([]);
    expect(findCompletedExecutions([entry(user(), 200_000), ...entries.slice(1)])).toEqual([]);
  });
});

// Exercise the adapter with real Pi message/tool components, Container mouse
// dispatch and setToolsExpanded. Replace unrelated session/terminal orchestration
// while checking rendered content and interactions through the real components.
interface Fixture {
  chatContainer: Container;
  loadedResourcesContainer: Container;
  renderer: { mode: "fullscreen" | "regular"; resetTextSelection(): void };
  ui: TUI;
  outputPad: number;
  session: { isStreaming: boolean };
  sessionManager: { getBranch(): SessionEntry[] };
  entries: SessionEntry[];
  toolOutputExpanded: boolean;
  tools: Map<string, ToolExecutionComponent>;
  showStatus(text: string): void;
  addMessageToChat(message: AgentMessage): void;
  renderSessionEntries(entries: SessionEntry[]): void;
  handleEvent(event: AgentSessionEvent): Promise<void>;
  setToolsExpanded(expanded: boolean): void;
  toggleToolOutputExpansion(): void;
  switchTuiMode(mode: "fullscreen" | "regular"): boolean;
}
const prototype = InteractiveMode.prototype as unknown as Fixture;
const methodNames = ["addMessageToChat", "renderSessionEntries", "handleEvent", "setToolsExpanded", "toggleToolOutputExpansion", "switchTuiMode"] as const;
const originals = Object.fromEntries(methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)!]));
const toolRenderer: ToolRenderers = {
  renderShell: "self",
  renderCall: (args, theme, context) => renderToolCall("Read", (args as { path: string }).path, theme, context, context.expanded),
  renderResult: (result, options, theme, context) => renderCollapsibleToolResult(result, options, theme, context),
};
function addTools(runtime: Fixture, message: AgentMessage): void {
  if (message.role !== "assistant") return;
  for (const part of message.content) {
    if (part.type !== "toolCall") continue;
    const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false, outputPad: 0 }, toolRenderer, runtime.ui, "/fixture");
    tool.setExpanded(runtime.toolOutputExpanded);
    runtime.tools.set(part.id, tool);
    runtime.chatContainer.addChild(tool);
  }
}
function fixture(entries: SessionEntry[], mode: "fullscreen" | "regular" = "fullscreen"): Fixture {
  const runtime = Object.create(prototype) as Fixture;
  Object.defineProperties(runtime, {
    session: { value: { isStreaming: false } },
    sessionManager: { configurable: true, value: { getBranch: () => runtime.entries } },
  });
  runtime.entries = entries;
  runtime.chatContainer = new Container();
  runtime.loadedResourcesContainer = new Container();
  runtime.renderer = { mode, resetTextSelection() {} };
  runtime.ui = { requestRender() {} } as unknown as TUI;
  runtime.outputPad = 0;
  runtime.toolOutputExpanded = false;
  runtime.tools = new Map();
  runtime.showStatus = (text) => runtime.chatContainer.addChild(new Text(text, 0, 0));
  return runtime;
}
const lines = (runtime: Fixture, width = 100): string[] => runtime.chatContainer.render(width).map(stripTerminalSequences);
const output = (runtime: Fixture): string => lines(runtime).join("\n");
function click(runtime: Fixture, text: string, width = 100, button: TuiMouseEvent["button"] = "left"): void {
  const rendered = lines(runtime, width);
  const y = rendered.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  runtime.chatContainer.handleMouse({ type: "click", button, x: 0, y, screenX: 0, screenY: y,
    width, height: rendered.length, shift: false, alt: false, ctrl: false });
}
async function complete(runtime: Fixture, entries: SessionEntry[], aborted = false): Promise<void> {
  await runtime.handleEvent({ type: "agent_start" });
  runtime.entries.push(...entries);
  runtime.renderSessionEntries(entries);
  await runtime.handleEvent({ type: "agent_end", messages: [], willRetry: false });
  await runtime.handleEvent({ type: "agent_settled", aborted });
}

function keyboardToggle(): (runtime: Fixture, mode?: ExtensionContext["mode"]) => Promise<void> {
  const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
  registerDSCodeExecutionFoldingShortcut({
    registerShortcut: (key, shortcut) => { shortcuts.set(key, shortcut); },
  });
  return async (runtime, mode = "tui") => {
    const shortcut = shortcuts.get("alt+o");
    if (!shortcut) throw new Error("The execution folding shortcut is not registered");
    await shortcut.handler({ mode, sessionManager: runtime.sessionManager } as ExtensionContext);
  };
}

describe("fullscreen execution folding adapter", () => {
  beforeAll(() => {
    initTheme("dark");
    for (const name of methodNames) expect(originals[name]?.value).toBeTypeOf("function");
    prototype.addMessageToChat = function (message): void {
      if (message.role === "user") {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new UserMessageComponent(typeof message.content === "string" ? message.content : "USER", undefined, 0));
      } else if (message.role === "assistant") {
        this.chatContainer.addChild(new AssistantMessageComponent(message, true, undefined, "Thinking", 0));
      } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
        this.chatContainer.addChild(new Text("SUMMARY_BARRIER", 0, 0));
      }
    };
    prototype.renderSessionEntries = function (entries): void {
      for (const item of entries) {
        if (item.type === "message") {
          this.addMessageToChat(item.message);
          addTools(this, item.message);
          if (item.message.role === "toolResult") this.tools.get(item.message.toolCallId)?.updateResult(item.message);
        }
      }
    };
    prototype.handleEvent = async function (event): Promise<void> {
      if (event.type === "agent_start") this.session.isStreaming = true;
      if (event.type === "agent_settled") this.session.isStreaming = false;
    };
    prototype.switchTuiMode = function (mode): boolean { this.renderer.mode = mode; return true; };
    installDSCodeExecutionFolding();
  });
  afterAll(() => {
    for (const name of methodNames) Object.defineProperty(prototype, name, originals[name]!);
    Reflect.deleteProperty(prototype, Symbol.for("dscode.execution-folding"));
  });

  it("folds completed history while keeping the user message and final answer visible", () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).toContain("Worked for 3m 13s ›");
    expect(output(runtime)).toContain("USER_A");
    expect(output(runtime)).toContain("FINAL_A");
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("Read");
    expect(output(runtime)).not.toContain("Thinking");
    installDSCodeExecutionFolding();
    expect(output(runtime).match(/Worked for/g)).toHaveLength(1);
    click(runtime, "Worked for");
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("USER_A");
    expect(output(runtime)).toContain("FINAL_A");
    click(runtime, "Worked for");
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).toContain("USER_A");
    expect(output(runtime)).toContain("FINAL_A");
  });

  it("folds a final message's thinking even without tools, keeping the stored message intact", () => {
    const final = assistant("FINAL_BODY");
    final.content.unshift({ type: "thinking", thinking: "FINAL_REASONING" });
    Object.freeze(final.content);
    Object.freeze(final);
    const runtime = fixture([entry(user()), entry(final, 193_000)]);
    const stored = JSON.stringify(runtime.entries);
    runtime.renderSessionEntries(runtime.entries);
    const component = runtime.chatContainer.children.findLast((child) => child instanceof AssistantMessageComponent)!;
    if (!(component instanceof AssistantMessageComponent)) throw new Error("fixture");
    component.setHiddenThinkingLabel("DeepSeek Flash is thinking");
    expect(output(runtime)).toContain("Worked for 3m 13s");
    expect(output(runtime)).toContain("FINAL_BODY");
    expect(output(runtime)).not.toContain("DeepSeek Flash is thinking");
    click(runtime, "Worked for");
    expect(output(runtime).indexOf("DeepSeek Flash is thinking")).toBeLessThan(output(runtime).indexOf("FINAL_BODY"));
    click(runtime, "DeepSeek Flash is thinking");
    expect(output(runtime)).toContain("FINAL_REASONING");
    click(runtime, "Worked for");
    expect(output(runtime)).not.toContain("FINAL_REASONING");
    expect(JSON.stringify(runtime.entries)).toBe(stored);
    runtime.switchTuiMode("regular");
    expect(output(runtime)).toContain("FINAL_REASONING");
    expect(output(runtime)).toContain("FINAL_BODY");
    expect(output(runtime)).not.toContain("Worked for");
    runtime.entries = JSON.parse(stored);
    runtime.chatContainer.clear();
    runtime.switchTuiMode("fullscreen");
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).not.toContain("FINAL_REASONING");
    expect(output(runtime)).not.toContain("Thinking");
    click(runtime, "Worked for");
    expect(output(runtime)).toContain("Thinking");
    expect(output(runtime)).not.toContain("FINAL_REASONING");
  });

  it("keeps projected thinking aligned with Pi settings and invalidation", () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    const final = runtime.chatContainer.children.findLast((child) => child instanceof AssistantMessageComponent)!;
    if (!(final instanceof AssistantMessageComponent)) throw new Error("fixture");
    final.setHideThinkingBlock(false);
    final.setOutputPad(2);
    runtime.chatContainer.invalidate();
    expect(output(runtime)).not.toContain("FINAL_REASONING_A");
    expect(output(runtime)).toContain("FINAL_A");
    click(runtime, "Worked for");
    expect(output(runtime)).toContain("FINAL_REASONING_A");
    final.setHideThinkingBlock(true);
    expect(output(runtime)).toContain("Thinking");
    expect(output(runtime)).not.toContain("FINAL_REASONING_A");
    click(runtime, "Thinking");
    expect(output(runtime)).toContain("FINAL_REASONING_A");
    click(runtime, "Worked for");
    expect(output(runtime)).not.toContain("FINAL_REASONING_A");
    expect(output(runtime)).not.toContain("Thinking");
  });

  it("projects all text and separate thinking runs without losing original mouse handlers", () => {
    const final = assistant("unused");
    final.content = [
      { type: "thinking", thinking: "REASON_ONE" }, { type: "text", text: "BODY_ONE" },
      { type: "thinking", thinking: "REASON_TWO" }, { type: "text", text: "BODY_TWO" },
    ];
    const runtime = fixture([entry(user()), entry(final, 193_000)]);
    const stored = JSON.stringify(runtime.entries);
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).toContain("BODY_ONE");
    expect(output(runtime)).toContain("BODY_TWO");
    expect(output(runtime)).not.toContain("Thinking");
    click(runtime, "Worked for");
    expect(output(runtime).match(/Thinking/g)).toHaveLength(2);
    click(runtime, "Thinking");
    expect(output(runtime)).toContain("REASON_ONE");
    expect(output(runtime)).not.toContain("REASON_TWO");
    expect(output(runtime).match(/Thinking/g)).toHaveLength(1);
    expect(JSON.stringify(runtime.entries)).toBe(stored);
  });

  it.each(["aborted", "error", "length"] as const)("leaves final thinking visible for %s segments", (reason) => {
    const final = assistant("FAILED_BODY", "stop");
    final.stopReason = reason;
    final.content.unshift({ type: "thinking", thinking: "FAILED_REASONING" });
    const runtime = fixture([entry(user()), entry(final, 193_000)]);
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).toContain("Thinking");
    expect(output(runtime)).toContain("FAILED_BODY");
    expect(output(runtime)).not.toContain("Worked for");
  });

  it("retains independent Pi tool clicks and resets both outputs on closing/reopening the parent", () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    click(runtime, "Worked for", 80, "right");
    expect(output(runtime)).not.toContain("PROGRESS_A");
    click(runtime, "Worked for", 80);
    expect(lines(runtime).find((line) => line.includes("Worked for"))?.trim()).toBe("Worked for 3m 13s");
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    click(runtime, "Read A_1");
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
    click(runtime, "Worked for");
    click(runtime, "Worked for", 60);
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
  });

  it("uses the original batch toggle but leaves hidden tools closed and preserves status writes", () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    runtime.setToolsExpanded(true);
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).toContain("Tool output: expanded");
    click(runtime, "Worked for");
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    runtime.setToolsExpanded(false);
    runtime.setToolsExpanded(true);
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
  });

  it("expands tools with one keypress after closing and reopening their parent", async () => {
    const toggle = keyboardToggle();
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    await toggle(runtime);
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    await toggle(runtime);
    await toggle(runtime);
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
    expect(output(runtime)).toContain("Tool output: expanded");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
  });

  it("uses actual tool states after individual mouse clicks, including mixed states", () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    click(runtime, "Worked for");
    click(runtime, "Read A_1");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
    click(runtime, "• Read");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
    runtime.toggleToolOutputExpansion();
    click(runtime, "Read A_1");
    click(runtime, "Read A_2");
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
  });

  it("ignores hidden groups and non-tool expandables when deciding whether to collapse", () => {
    const runtime = fixture([...execution(), ...execution(300_000, "B")]);
    runtime.renderSessionEntries(runtime.entries);
    let resourceExpanded = false;
    const resource = {
      render: () => [resourceExpanded ? "RESOURCE_DETAILS" : "RESOURCE_SUMMARY"],
      invalidate() {},
      setExpanded(expanded: boolean) { resourceExpanded = expanded; },
    };
    runtime.loadedResourcesContainer.addChild(resource);
    click(runtime, "Worked for");
    runtime.toggleToolOutputExpansion();
    expect(runtime.loadedResourcesContainer.render(100)).toEqual(["RESOURCE_DETAILS"]);
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
    expect(output(runtime)).not.toContain("PROGRESS_B");
    expect(runtime.loadedResourcesContainer.render(100)).toEqual(["RESOURCE_SUMMARY"]);
    click(runtime, "Worked for 3m 13s ›");
    expect(output(runtime)).toContain("PROGRESS_B");
    expect(output(runtime)).not.toContain("B_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("B_2_OUTPUT_19");
  });

  it("opens newly arriving live tools after toggling while history is folded", async () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("PROGRESS_A");
    await runtime.handleEvent({ type: "agent_start" });
    const live = assistant("LIVE", "toolUse", ["LIVE_1"]);
    runtime.addMessageToChat(live);
    addTools(runtime, live);
    runtime.tools.get("LIVE_1")!.updateResult({
      isError: false, content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `LIVE_OUTPUT_${i}`).join("\n") }],
    });
    expect(output(runtime)).toContain("LIVE_OUTPUT_19");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("LIVE_OUTPUT_19");
    expect(output(runtime)).not.toContain("PROGRESS_A");
  });

  it("counts visible shell executions as tools", () => {
    const runtime = fixture([]);
    runtime.renderSessionEntries([]);
    const shell = new BashExecutionComponent("echo output", runtime.ui);
    shell.setComplete(0, false);
    shell.appendOutput(Array.from({ length: 100 }, (_, i) => `SHELL_OUTPUT_${i}`).join("\n"));
    shell.setExpanded(true);
    runtime.chatContainer.addChild(shell);
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("SHELL_OUTPUT_0");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("SHELL_OUTPUT_0");
  });

  it("keeps regular mode's remembered toggle even when mouse states differ", () => {
    const runtime = fixture(execution(), "regular");
    runtime.renderSessionEntries(runtime.entries);
    click(runtime, "Read A_1");
    click(runtime, "Read A_2");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).toContain("A_2_OUTPUT_19");
    runtime.toggleToolOutputExpansion();
    expect(output(runtime)).not.toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("A_2_OUTPUT_19");
  });

  it("toggles all first-layer groups, preserving open tools until the whole process closes", async () => {
    const toggle = keyboardToggle();
    const runtime = fixture([...execution(), ...execution(300_000, "B")]);
    runtime.renderSessionEntries(runtime.entries);
    // A mixed state must open all groups without resetting already visible tools.
    click(runtime, "Worked for");
    click(runtime, "Read A_1");
    await toggle(runtime);
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("PROGRESS_B");
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("B_1_OUTPUT_19");
    expect(lines(runtime).filter((line) => line.includes("Worked for")).map((line) => line.trim()))
      .toEqual(["Worked for 3m 13s", "Worked for 3m 13s"]);
    runtime.setToolsExpanded(true);
    expect(output(runtime)).toContain("B_2_OUTPUT_19");
    await toggle(runtime);
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("PROGRESS_B");
    expect(output(runtime)).toContain("FINAL_A");
    expect(output(runtime)).toContain("FINAL_B");
    await toggle(runtime);
    for (const label of ["A", "B"]) {
      expect(output(runtime)).toContain(`PROGRESS_${label}`);
      for (const i of [1, 2]) expect(output(runtime)).not.toContain(`${label}_${i}_OUTPUT_19`);
    }
  });

  it("keeps the live segment flat while toggling completed history", async () => {
    const toggle = keyboardToggle();
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    await runtime.handleEvent({ type: "agent_start" });
    const pending = execution(300_000, "B");
    runtime.entries.push(...pending);
    runtime.renderSessionEntries(pending);
    await toggle(runtime);
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("PROGRESS_B");
    await toggle(runtime);
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).toContain("PROGRESS_B");
    expect(output(runtime).match(/Worked for/g)).toHaveLength(1);
  });

  it("scopes the shortcut to its session and fullscreen, including a replaced session manager", async () => {
    const toggle = keyboardToggle();
    const runtime = fixture(execution());
    const other = fixture(execution(300_000, "B"));
    runtime.renderSessionEntries(runtime.entries);
    other.renderSessionEntries(other.entries);
    await toggle(runtime, "rpc");
    expect(output(runtime)).not.toContain("PROGRESS_A");
    await toggle(runtime);
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(other)).not.toContain("PROGRESS_B");
    runtime.switchTuiMode("regular");
    const regularOutput = output(runtime);
    await toggle(runtime);
    expect(output(runtime)).toBe(regularOutput);
    runtime.switchTuiMode("fullscreen");
    runtime.chatContainer.clear();
    runtime.entries = execution(600_000, "C");
    Object.defineProperty(runtime, "sessionManager", { configurable: true, value: { getBranch: () => runtime.entries } });
    runtime.renderSessionEntries(runtime.entries);
    await toggle(runtime);
    expect(output(runtime)).toContain("PROGRESS_C");
    expect(output(other)).not.toContain("PROGRESS_B");
  });

  it("does nothing before a process exists", async () => {
    const toggle = keyboardToggle();
    const runtime = fixture([entry(user()), entry(assistant("FINAL"), 1_000)]);
    await toggle(runtime);
    runtime.renderSessionEntries(runtime.entries);
    const rendered = output(runtime);
    await toggle(runtime);
    expect(output(runtime)).toBe(rendered);
  });

  it("waits for settlement across retries and recognizes the actual streaming component", async () => {
    const runtime = fixture([]);
    await runtime.handleEvent({ type: "agent_start" });
    const entries = execution();
    runtime.entries.push(...entries);
    runtime.renderSessionEntries(entries.slice(0, -1));
    // Streaming assistants bypass addMessageToChat in Pi.
    const final = entries.at(-1)!;
    if (final.type !== "message" || final.message.role !== "assistant") throw new Error("fixture");
    const streaming = new AssistantMessageComponent(undefined, true, undefined, "Thinking", 0);
    runtime.chatContainer.addChild(streaming);
    streaming.updateContent(final.message, false);
    await runtime.handleEvent({ type: "agent_end", messages: [], willRetry: true });
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("Worked for");
    expect(output(runtime)).toContain("Thinking");
    await runtime.handleEvent({ type: "agent_start" });
    await runtime.handleEvent({ type: "agent_settled", aborted: false });
    expect(output(runtime)).toContain("Worked for 3m 13s");
    expect(output(runtime)).toContain("FINAL_A");
    expect(output(runtime)).not.toContain("Thinking");
  });

  it.each(["aborted", "error", "length"] as const)("leaves %s output flat", async (reason) => {
    const runtime = fixture([]);
    const entries = execution();
    entries[entries.length - 1] = entry(assistant("FAILED", reason), 193_000);
    await complete(runtime, entries, reason === "aborted");
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("FAILED");
    expect(output(runtime)).not.toContain("Worked for");
  });

  it("does not fold an answer without a process or a segment superseded by steering", () => {
    const runtime = fixture([entry(user()), entry(assistant("FINAL"), 1_000)]);
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).not.toContain("Worked for");
    const steered = [...execution().slice(0, -1), ...execution(300_000, "B")];
    const other = fixture(steered);
    other.renderSessionEntries(steered);
    expect(output(other)).toContain("PROGRESS_A");
    expect(output(other)).toContain("USER_B");
    expect(output(other).match(/Worked for/g)).toHaveLength(1);
  });

  it("preserves old open groups when a new segment completes, but resets on history rebuild", async () => {
    const runtime = fixture(execution());
    runtime.renderSessionEntries(runtime.entries);
    click(runtime, "Worked for");
    click(runtime, "Read A_1");
    await complete(runtime, execution(300_000, "B"));
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("PROGRESS_B");
    runtime.entries = JSON.parse(JSON.stringify(runtime.entries));
    runtime.chatContainer.clear();
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).not.toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("PROGRESS_B");
    expect(output(runtime).match(/Worked for/g)).toHaveLength(2);
  });

  it("does not mutate regular mode and restores flat output when exiting fullscreen", () => {
    const runtime = fixture(execution(), "regular");
    runtime.toolOutputExpanded = true;
    runtime.renderSessionEntries(runtime.entries);
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).toContain("A_1_OUTPUT_19");
    expect(output(runtime)).not.toContain("Worked for");
    runtime.switchTuiMode("fullscreen");
    expect(output(runtime)).toContain("Worked for");
    runtime.switchTuiMode("regular");
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("Worked for");
  });

  it("honors a summary inserted between components even if the raw entries retain the old user", () => {
    const entries = execution();
    const runtime = fixture(entries);
    runtime.renderSessionEntries(entries.slice(0, -1));
    runtime.addMessageToChat({ role: "compactionSummary", summary: "COMPACT", tokensBefore: 1, timestamp: 0 });
    runtime.renderSessionEntries(entries.slice(-1));
    expect(output(runtime)).toContain("SUMMARY_BARRIER");
    expect(output(runtime)).toContain("PROGRESS_A");
    expect(output(runtime)).not.toContain("Worked for");
  });
});
