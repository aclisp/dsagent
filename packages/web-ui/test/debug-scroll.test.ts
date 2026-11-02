import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

type InputEvent = {
  deltaY?: number;
  pointerType?: string;
  key?: string;
  keyCode?: number;
  shiftKey?: boolean;
  touches?: { clientY: number }[];
  preventDefault?: () => void;
};
type Listener = (event: InputEvent) => void;

class Element {
  listeners = new Map<string, Set<Listener>>();
  children: Element[] = [];
  parentElement: Element | null = null;
  style: Record<string, string> = {};
  classList = { add() {} };
  id = "";
  value = "";
  textContent = "";
  innerHTML = "";
  scrollHeight = 32;
  content = this;

  get lastElementChild(): Element | null { return this.children.at(-1) ?? null; }
  get previousElementSibling(): Element | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  appendChild(child: Element) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
  }
  append(value: string) { this.textContent += value; }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  addEventListener(name: string, listener: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string, event: InputEvent = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  focus() {}
  setAttribute() {}
  removeAttribute() {}
}

// Execute both browser scripts, excluding only import/boot. Geometry is controlled
// here so native scrolls and layout changes remain distinct from script writes.
function harness() {
  const appSource = readFileSync(new URL("../static/app.js", import.meta.url), "utf8")
    .replace(/^import .*\n/, "")
    .replace(/\nvoid boot\(\);\s*$/, "");
  const terminoSource = readFileSync(new URL("../static/termino.js", import.meta.url), "utf8")
    .replace("export function Termino", "function Termino");
  const terminal = new Element();
  const input = new Element();
  const windowEvents = new Element();
  const frames = new Map<number, () => void>();
  const writes: number[] = [];
  let nextFrame = 0;
  let scrollTop = 1400;
  const scroller = Object.assign(new Element(), {
    scrollHeight: 2000,
    clientHeight: 600,
    scrollTop: 1400,
    scrollTo({ top }: { top: number }) { this.scrollTop = top; },
  });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set(value: number) {
      writes.push(value);
      scrollTop = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight));
    },
  });
  const selectors = new Map([
    [".termino-console", scroller],
    [".termino-input", input],
  ]);
  Object.assign(terminal, { querySelector: (selector: string) => selectors.get(selector) });
  const ids = new Map<string, Element>([
    ["terminal", terminal], ["stop", new Element()],
    ["upload", new Element()], ["file-input", new Element()],
  ]);
  const elements: Element[] = [];
  const context = createContext({
    document: {
      getElementById: (id: string) => ids.get(id) ?? elements.find((element) => element.id === id),
      querySelector: (selector: string) => selectors.get(selector),
      createElement() {
        const element = new Element();
        elements.push(element);
        return element;
      },
    },
    window: {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      getComputedStyle: () => ({
        borderTopWidth: "1px", borderBottomWidth: "1px",
        minHeight: "34px", maxHeight: "74px",
      }),
    },
    sessionStorage: { getItem: () => "test-client" },
    requestAnimationFrame(callback: () => void) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  runInContext(`${terminoSource}\n${appSource}`, context);

  return {
    scroller, terminal, windowEvents, frames, writes,
    content(height = 40, kind: "text" | "tool" | "indicator" = "text") {
      scroller.scrollHeight += height;
      const calls = {
        text: "appendDelta('more output');",
        tool: "outToolCall('read_file', { path: 'file.ts' });",
        indicator: "showIndicator('thinking');",
      };
      runInContext(calls[kind], context);
    },
    nativeScroll(top: number) {
      scrollTop = top;
      scroller.emit("scroll");
    },
    touchStart(y = 300) {
      scroller.emit("pointerdown", { pointerType: "touch" });
      scroller.emit("touchstart", { touches: [{ clientY: y }] });
    },
    touchMove(y: number) { scroller.emit("touchmove", { touches: [{ clientY: y }] }); },
    touchEnd(event = "touchend") { scroller.emit(event); },
    ask() {
      scroller.scrollHeight += 40;
      return runInContext('ask("❯ ", "user-message")', context) as Promise<string | undefined>;
    },
    submit(value: string) {
      input.value = value;
      input.emit("keypress", { keyCode: 13, shiftKey: false, preventDefault() {} });
    },
    cancelInput() { runInContext("term.cancel_input()", context); },
    flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
      scroller.emit("scroll");
    },
  };
}

describe("debug scroll following", () => {
  it("coalesces output into one scroll per animation frame", () => {
    const page = harness();
    page.content();
    page.content();
    expect(page.frames.size).toBe(1);
    expect(page.writes).toEqual([]);
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1480);
    expect(page.writes).toEqual([2080]);
  });

  it("cancels a queued follow on an upward wheel and stays paused for every output type", () => {
    const page = harness();
    page.content();
    page.scroller.emit("wheel", { deltaY: -1 });
    expect(page.frames.size).toBe(0);
    page.nativeScroll(1390);
    for (const kind of ["text", "tool", "indicator"] as const) page.content(40, kind);
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1390);
    expect(page.writes).toEqual([]);
  });

  it("keeps an upward touch paused through release, momentum and delayed scroll events", () => {
    const page = harness();
    page.touchStart();
    page.touchMove(310);
    page.nativeScroll(1390);
    page.nativeScroll(1400);
    page.touchEnd();
    page.nativeScroll(1380);
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1380);
    expect(page.writes).toEqual([]);
  });

  it.each(["touchend", "touchcancel"])("defers a queued follow until %s", (event) => {
    const page = harness();
    page.content();
    page.touchStart();
    page.flushFrame();
    page.content();
    page.flushFrame();
    expect(page.writes).toEqual([]);
    page.touchEnd(event);
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1480);
    expect(page.writes).toEqual([2080]);
  });

  it("avoids redundant writes at the bottom, including native overscroll and rebound", () => {
    const page = harness();
    page.content(0);
    page.scroller.emit("wheel", { deltaY: 20 });
    page.windowEvents.emit("resize");
    expect(page.frames.size).toBe(0);
    page.touchStart();
    page.touchMove(290);
    page.nativeScroll(1420);
    page.content(10);
    page.touchEnd();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1420);
    page.nativeScroll(1410);
    expect(page.writes).toEqual([]);
  });

  it("resumes only when the reader scrolls all the way back to the bottom", () => {
    const page = harness();
    page.scroller.emit("wheel", { deltaY: -20 });
    page.nativeScroll(1300);
    page.content();
    page.scroller.emit("wheel", { deltaY: 20 });
    page.nativeScroll(1430);
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1430);
    page.nativeScroll(1480);
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1520);
    expect(page.writes).toEqual([2120]);
  });

  it("supports pausing and resuming with a dragged scrollbar", () => {
    const page = harness();
    page.scroller.emit("pointerdown", { pointerType: "mouse" });
    page.nativeScroll(1370);
    page.content();
    page.flushFrame();
    expect(page.writes).toEqual([]);
    page.nativeScroll(1440);
    page.windowEvents.emit("pointerup");
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1480);
  });

  it("supports keyboard scrolling", () => {
    const page = harness();
    page.terminal.emit("keydown", { key: "ArrowUp", keyCode: 38 });
    page.scroller.emit("scroll");
    expect(page.writes).toEqual([0]);
    page.writes.length = 0;
    page.content();
    page.flushFrame();
    expect(page.writes).toEqual([]);
    page.terminal.emit("keydown", { key: "ArrowDown", keyCode: 40 });
    page.scroller.emit("scroll");
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1480);
    expect(page.writes).toEqual([2040, 2080]);
  });

  it("does not resume when a layout change clamps a paused reader to the bottom", () => {
    const page = harness();
    page.scroller.emit("wheel", { deltaY: -20 });
    page.nativeScroll(1300);
    page.scroller.emit("wheel", { deltaY: 20 });
    page.nativeScroll(1370);
    page.scroller.clientHeight = 700;
    page.nativeScroll(1300);
    page.windowEvents.emit("resize");
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1300);
    expect(page.writes).toEqual([]);
    page.scroller.emit("wheel", { deltaY: 20 });
    page.nativeScroll(1340);
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1380);
  });

  it("keeps Termino prompt creation and cancellation from pulling a paused reader down", async () => {
    const page = harness();
    page.scroller.emit("wheel", { deltaY: -20 });
    page.nativeScroll(1300);
    const prompt = page.ask();
    expect(page.writes).toEqual([]);
    expect(page.frames.size).toBe(0);
    page.cancelInput();
    expect(await prompt).toBeUndefined();
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1300);
    expect(page.writes).toEqual([]);
  });

  it("resumes following on explicit input submission", async () => {
    const page = harness();
    page.scroller.emit("wheel", { deltaY: -20 });
    page.nativeScroll(1300);
    const prompt = page.ask();
    page.submit("hello");
    expect(await prompt).toBe("hello");
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1440);
    expect(page.writes).toEqual([2040]);
    page.content();
    page.flushFrame();
    expect(page.scroller.scrollTop).toBe(1480);
  });
});
