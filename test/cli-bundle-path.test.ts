import { describe, expect, it } from "vitest";
import { containsCheckoutPath } from "../scripts/checkout-path.mjs";

describe("CLI bundle checkout path detection", () => {
  it("does not treat dependency filenames beginning with app as the /app root", () => {
    const dependencyPaths = [
      '"node_modules/.pnpm/highlight.js/lib/languages/applescript.js"',
      '"node_modules/.pnpm/yaml/dist/doc/applyReviver.js"',
    ].join("\n");

    expect(containsCheckoutPath(dependencyPaths, "/app")).toBe(false);
  });

  it("detects the checkout root at actual path boundaries", () => {
    expect(containsCheckoutPath('const entry = "/app/dist/cli.js";', "/app")).toBe(true);
    expect(containsCheckoutPath("const entry = 'file:///app/dist/cli.js';", "/app")).toBe(true);
    expect(containsCheckoutPath('const root = "/app";', "/app")).toBe(true);
  });
});
