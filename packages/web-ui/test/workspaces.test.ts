import { describe, expect, it } from "vitest";
import { parseWorkspaces } from "../src/workspaces.js";

describe("parseWorkspaces", () => {
  it("accepts URL-safe workspace IDs", () => {
    expect(parseWorkspaces("workspace_123456=/workspace")).toEqual({
      workspace_123456: "/workspace",
    });
  });

  it("rejects IDs that cannot safely be used in URLs", () => {
    for (const id of [
      "short",
      "workspace with spaces",
      "workspace/id/with/slashes",
      "workspace?id=1",
    ]) {
      expect(() => parseWorkspaces(`${id}=/workspace`)).toThrow(
        "id must be 16-128 URL-safe characters",
      );
    }
  });
});
