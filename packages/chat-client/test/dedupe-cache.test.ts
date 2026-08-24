import { describe, expect, it } from "vitest";
import { DedupeCache } from "../src/dedupe-cache.js";

describe("DedupeCache", () => {
  it("rejects duplicates until their TTL expires", () => {
    let now = 1_000;
    const cache = new DedupeCache(() => now, 100, 10);

    expect(cache.rememberIfNew("event-1")).toBe(true);
    expect(cache.rememberIfNew("event-1")).toBe(false);
    now = 1_099;
    expect(cache.rememberIfNew("event-1")).toBe(false);
    now = 1_100;
    expect(cache.rememberIfNew("event-1")).toBe(true);
  });

  it("evicts the oldest entry when capacity is reached", () => {
    const cache = new DedupeCache(() => 0, 100, 2);

    expect(cache.rememberIfNew("oldest")).toBe(true);
    expect(cache.rememberIfNew("newer")).toBe(true);
    expect(cache.rememberIfNew("latest")).toBe(true);
    expect(cache.rememberIfNew("newer")).toBe(false);
    expect(cache.rememberIfNew("oldest")).toBe(true);
  });

  it("clears all remembered entries", () => {
    const cache = new DedupeCache(() => 0, 100, 2);
    cache.rememberIfNew("event-1");
    cache.clear();
    expect(cache.rememberIfNew("event-1")).toBe(true);
  });
});
