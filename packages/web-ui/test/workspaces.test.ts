import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ID,
  defaultWorkspacesConfig,
  parseWorkspaces,
  resolveWorkspacesConfig,
} from "../src/workspaces.js";

describe("default workspace configuration", () => {
  it("uses a URL-safe stable id under the DSCode home", () => {
    const config = defaultWorkspacesConfig("/tmp/dscode-home");

    expect(DEFAULT_WORKSPACE_ID).toBe("dscode-workspace");
    expect(config).toBe("dscode-workspace=/tmp/dscode-home/workspace");
    expect(parseWorkspaces(config)).toEqual({
      "dscode-workspace": "/tmp/dscode-home/workspace",
    });
  });

  it("uses the default only on a loopback host", () => {
    expect(resolveWorkspacesConfig(undefined, "127.0.0.1", "/tmp/dscode-home")).toBe(
      "dscode-workspace=/tmp/dscode-home/workspace",
    );
    expect(() => resolveWorkspacesConfig(undefined, "0.0.0.0", "/tmp/dscode-home")).toThrow(
      "WORKSPACES is required when HOST is not a loopback address",
    );
  });

  it("preserves explicit values and rejects an explicitly blank value", () => {
    const configured = "workspace_123456=/custom/workspace";

    expect(resolveWorkspacesConfig(configured, "0.0.0.0", "/tmp/dscode-home")).toBe(configured);
    expect(() => resolveWorkspacesConfig("  ", "127.0.0.1", "/tmp/dscode-home")).toThrow(
      "WORKSPACES is required",
    );
  });
});

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
