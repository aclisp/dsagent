import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type InputEvent = {
  deltaY?: number;
  pointerType?: string;
  touches?: { clientY: number }[];
};

// Run the actual scroll handlers with controllable animation frames and geometry.
// This lets a touch gesture interrupt a queued streaming update before it scrolls.
function harness() {
  const source = readFileSync(new URL("../static/chat.js", import.meta.url), "utf8");
  const listeners = new Map<string, (event: InputEvent) => void>();
  const frames = new Map<number, () => void>();
  const scrollWrites: number[] = [];
  let nextFrame = 0;
  let scrollTop = 1400;
  let jumpLatest = () => {};
  let resizeLayout = () => {};
  const scroller = {
    scrollHeight: 2000,
    clientHeight: 600,
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) {
      scrollWrites.push(value);
      scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
    addEventListener(name: string, listener: (event: InputEvent) => void) {
      listeners.set(name, listener);
    },
    scrollTo({ top }: { top: number }) { this.scrollTop = top; },
  };
  const jumpLatestButton = {
    hidden: true,
    addEventListener(_name: string, listener: () => void) { jumpLatest = listener; },
  };
  const state = {
    followLatest: true,
    jumpingToLatest: false,
    scrollingToEarliest: false,
    scrollIntent: null as "older" | "newer" | null,
  };
  const context = createContext({
    scroller, jumpLatestButton, state,
    trimTimelineIfNeeded: vi.fn(),
    positionJumpButton() {},
    setHeaderCollapsed() {},
    updateHeaderFromTouch() {},
    ResizeObserver: class {
      constructor(callback: () => void) { resizeLayout = callback; }
    },
    requestAnimationFrame(callback: () => void) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  runInContext(`
    ${source.match(/^const (?:NEAR_BOTTOM_PX|BOTTOM_EPSILON_PX|JUMP_LATEST_DISTANCE_PX) = .*;$/gm)?.join("\n")}
    let followLatestFrame = null, pointerScrollTop = null, previousTouchY = null;
    let lastScrollTop = scroller.scrollTop, headerGestureDistance = 0;
    ${source.slice(source.indexOf("function isNearBottom()"), source.indexOf("function isBackForwardNavigation()"))}
    ${source.slice(source.indexOf('scroller.addEventListener("scroll"'), source.indexOf('scrollEarliestHotspot.addEventListener'))}
    ${source.slice(source.indexOf("const layoutResizeObserver = new ResizeObserver("), source.indexOf("function observeChatLayout()"))}
  `, context);

  function emit(name: string, event: InputEvent = {}) { listeners.get(name)?.(event); }
  return {
    state, scroller, jumpLatestButton, frames, scrollWrites, emit,
    contentChange(height = 40) {
      scroller.scrollHeight += height;
      runInContext("afterContentChange()", context);
    },
    resize(clientHeight: number) {
      const before = scroller.scrollTop;
      scroller.clientHeight = clientHeight;
      scroller.scrollTop = scroller.scrollTop;
      if (scroller.scrollTop !== before) emit("scroll");
      resizeLayout();
    },
    scrollTo(top: number) {
      scroller.scrollTop = top;
      emit("scroll");
    },
    overscrollTo(top: number) {
      scrollTop = top;
      emit("scroll");
    },
    touchStart(y = 300) {
      emit("pointerdown", { pointerType: "touch" });
      emit("touchstart", { touches: [{ clientY: y }] });
    },
    touchMove(y: number) { emit("touchmove", { touches: [{ clientY: y }] }); },
    touchEnd() {
      emit("pointerup", { pointerType: "touch" });
      emit("touchend");
    },
    jumpLatest() { jumpLatest(); emit("scroll"); },
    forceFollow() { runInContext("afterContentChange(true)", context); },
    flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      const before = scroller.scrollTop;
      for (const callback of pending) callback();
      if (scroller.scrollTop !== before) emit("scroll");
    },
  };
}

describe("chat scroll following", () => {
  it("keeps following streaming content until the reader scrolls away", () => {
    const browser = harness();
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
    expect(browser.state.followLatest).toBe(true);
    expect(browser.jumpLatestButton.hidden).toBe(true);
  });

  it("pauses on a small upward touch without showing the jump button nearby", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(330);
    browser.scrollTo(1370);
    browser.touchEnd();
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1370);
    expect(browser.state.followLatest).toBe(false);
    expect(browser.jumpLatestButton.hidden).toBe(true);
  });

  it("shows the jump button only after the gap grows to 960px and hides it on the way back", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(330);
    browser.scrollTo(1370);
    browser.touchEnd();
    browser.contentChange(929);
    expect(browser.jumpLatestButton.hidden).toBe(true);
    browser.contentChange(1);
    expect(browser.jumpLatestButton.hidden).toBe(false);
    browser.touchStart();
    browser.touchMove(280);
    browser.scrollTo(1390);
    expect(browser.jumpLatestButton.hidden).toBe(true);
    expect(browser.state.followLatest).toBe(false);
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1390);
    expect(browser.jumpLatestButton.hidden).toBe(false);
  });

  it.each([640, 250])("uses a fixed 960px threshold with a %ipx viewport", (height) => {
    const browser = harness();
    browser.resize(height);
    browser.flushFrame();
    const bottom = browser.scroller.scrollHeight - height;
    browser.emit("wheel", { deltaY: -1 });
    browser.scrollTo(bottom - 959);
    expect(browser.state.followLatest).toBe(false);
    expect(browser.jumpLatestButton.hidden).toBe(true);
    browser.scrollTo(bottom - 960);
    expect(browser.jumpLatestButton.hidden).toBe(false);
    browser.emit("wheel", { deltaY: 1 });
    browser.scrollTo(bottom - 959);
    expect(browser.jumpLatestButton.hidden).toBe(true);
    expect(browser.state.followLatest).toBe(false);
  });

  it("updates jump button visibility when resizing crosses the distance threshold", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(1200);
    browser.scrollTo(500);
    browser.touchEnd();
    browser.resize(500);
    expect(browser.jumpLatestButton.hidden).toBe(false);
    browser.resize(600);
    expect(browser.jumpLatestButton.hidden).toBe(true);
    expect(browser.state.followLatest).toBe(false);
  });

  it("does not queue or write repeated bottom snaps while swiping farther down", () => {
    const browser = harness();
    browser.touchStart();
    for (const y of [290, 280, 270]) browser.touchMove(y);
    browser.touchEnd();
    expect(browser.frames.size).toBe(0);
    browser.flushFrame();
    expect(browser.scrollWrites).toEqual([]);
    expect(browser.state.followLatest).toBe(true);
  });

  it("does not queue bottom snaps for downward wheels or unchanged layout", () => {
    const browser = harness();
    for (let index = 0; index < 3; index += 1) browser.emit("wheel", { deltaY: 10 });
    browser.contentChange(0);
    expect(browser.frames.size).toBe(0);
    browser.flushFrame();
    expect(browser.scrollWrites).toEqual([]);
  });

  it("leaves native bottom overscroll and its rebound alone", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(290);
    browser.overscrollTo(1420);
    browser.touchMove(280);
    browser.contentChange(10);
    browser.touchEnd();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1420);
    browser.overscrollTo(1410);
    expect(browser.scrollWrites).toEqual([]);
    expect(browser.state.followLatest).toBe(true);
    expect(browser.jumpLatestButton.hidden).toBe(true);
  });

  it("defers following new output until the finger is released", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(290);
    browser.contentChange();
    expect(browser.frames.size).toBe(0);
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1400);
    browser.touchEnd();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
    expect(browser.state.followLatest).toBe(true);
  });

  it("defers an already queued follow when a touch starts before the frame runs", () => {
    const browser = harness();
    browser.contentChange();
    browser.touchStart();
    browser.flushFrame();
    expect(browser.scrollWrites).toEqual([]);
    browser.touchEnd();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
  });

  it("cancels an already queued follow before the touch produces a scroll event", () => {
    const browser = harness();
    browser.contentChange();
    expect(browser.frames.size).toBe(1);
    browser.touchStart();
    browser.touchMove(310);
    expect(browser.frames.size).toBe(0);
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1400);
    expect(browser.state.followLatest).toBe(false);
  });

  it("does not let a programmatic scroll overwrite the upward touch direction", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(310);
    browser.scroller.scrollHeight += 40;
    // A scroll event from an earlier programmatic write arrives during the touch.
    browser.scrollTo(1440);
    expect(browser.state.followLatest).toBe(false);
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
  });

  it("preserves the pause through touch cancellation and upward momentum", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(310);
    browser.scrollTo(1390);
    browser.emit("pointercancel");
    browser.emit("touchcancel");
    browser.scrollTo(1380);
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1380);
    expect(browser.state.followLatest).toBe(false);
  });

  it("waits for the actual bottom before resuming, including downward momentum", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(430);
    browser.scrollTo(1270);
    browser.touchEnd();
    browser.touchStart();
    browser.touchMove(200);
    browser.scrollTo(1370);
    expect(browser.state.followLatest).toBe(false);
    browser.touchEnd();
    browser.scrollTo(1399);
    expect(browser.state.followLatest).toBe(true);
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
  });

  it("keeps following through layout changes when the reader has not scrolled away", () => {
    const browser = harness();
    browser.resize(500);
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1500);
    expect(browser.state.followLatest).toBe(true);
  });

  it("does not resume just because a layout change puts the paused reader at the bottom", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(430);
    browser.scrollTo(1270);
    browser.touchMove(330);
    browser.scrollTo(1370);
    browser.touchEnd();
    // A shrinking composer makes the viewport taller and clamps scrollTop.
    browser.resize(700);
    browser.flushFrame();
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1300);
    expect(browser.state.followLatest).toBe(false);
  });

  it("resumes on an explicit downward gesture when already at the bottom after resizing", () => {
    const browser = harness();
    browser.emit("wheel", { deltaY: -20 });
    browser.scrollTo(1380);
    browser.resize(700);
    expect(browser.state.followLatest).toBe(false);
    browser.emit("wheel", { deltaY: 20 });
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1340);
    expect(browser.state.followLatest).toBe(true);
  });

  it("also pauses immediately for an upward wheel and ignores horizontal wheels", () => {
    const browser = harness();
    browser.contentChange();
    browser.emit("wheel", { deltaY: -1 });
    expect(browser.frames.size).toBe(0);
    browser.scrollTo(1390);
    browser.emit("wheel", { deltaY: 0 });
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1390);
    expect(browser.state.followLatest).toBe(false);
  });

  it("supports leaving and returning to the bottom with the scrollbar", () => {
    const browser = harness();
    browser.emit("pointerdown", { pointerType: "mouse" });
    browser.scrollTo(1370);
    expect(browser.state.followLatest).toBe(false);
    browser.scrollTo(1400);
    expect(browser.state.followLatest).toBe(true);
    browser.emit("pointerup");
  });

  it.each(["button", "submission"])("resumes explicitly via %s", (action) => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(430);
    browser.scrollTo(1270);
    browser.touchEnd();
    if (action === "button") browser.jumpLatest();
    else browser.forceFollow();
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1440);
    expect(browser.state.followLatest).toBe(true);
    expect(browser.jumpLatestButton.hidden).toBe(true);
  });
});
