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
  let nextFrame = 0;
  let scrollTop = 1400;
  let jumpLatest = () => {};
  const scroller = {
    scrollHeight: 2000,
    clientHeight: 600,
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) {
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
    setHeaderCollapsed() {},
    updateHeaderFromTouch() {},
    requestAnimationFrame(callback: () => void) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  runInContext(`
    ${source.match(/^const (?:NEAR_BOTTOM_PX|BOTTOM_EPSILON_PX) = .*;$/gm)?.join("\n")}
    let followLatestFrame = null, pointerScrollTop = null, previousTouchY = null;
    let lastScrollTop = scroller.scrollTop, headerGestureDistance = 0;
    ${source.slice(source.indexOf("function isNearBottom()"), source.indexOf("function isBackForwardNavigation()"))}
    ${source.slice(source.indexOf('scroller.addEventListener("scroll"'), source.indexOf('scrollEarliestHotspot.addEventListener'))}
  `, context);

  function emit(name: string, event: InputEvent = {}) { listeners.get(name)?.(event); }
  return {
    state, scroller, jumpLatestButton, frames, emit,
    contentChange(height = 40) {
      scroller.scrollHeight += height;
      runInContext("afterContentChange()", context);
    },
    resize(clientHeight: number) {
      scroller.clientHeight = clientHeight;
      scroller.scrollTop = scroller.scrollTop;
      emit("scroll");
      runInContext("scheduleFollowLatest()", context);
    },
    scrollTo(top: number) {
      scroller.scrollTop = top;
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

  it("pauses on a small upward touch and stays paused after release and more content", () => {
    const browser = harness();
    browser.touchStart();
    browser.touchMove(330);
    browser.scrollTo(1370);
    browser.touchEnd();
    browser.contentChange();
    browser.flushFrame();
    expect(browser.scroller.scrollTop).toBe(1370);
    expect(browser.state.followLatest).toBe(false);
    expect(browser.jumpLatestButton.hidden).toBe(false);
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
