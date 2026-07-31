import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDSCodeProjectTrust } from "../packages/core/src/project-trust.js";

describe("DSCode project trust", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it("replaces the runtime prompt with DSCode-only language", async () => {
    const agentDir = await temporaryAgentDir();
    let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
    const pi = {
      on(event: string, next: typeof handler) {
        if (event === "project_trust") handler = next;
      },
    } as unknown as ExtensionAPI;
    registerDSCodeProjectTrust(pi, agentDir);
    let title = "";
    const result = await handler!(
      { type: "project_trust", cwd: "/work/project" },
      {
        hasUI: true,
        ui: {
          select: async (nextTitle: string) => {
            title = nextTitle;
            return "Trust this project";
          },
          notify: () => undefined,
        },
      },
    );

    expect(result).toEqual({ trusted: "yes", remember: true });
    expect(title).toContain("Trust this DSCode project?");
    expect(title).not.toMatch(/(?:^|\W)pi(?:\W|$)|\.pi/iu);
  });

  it("fails closed without an interactive UI", async () => {
    const agentDir = await temporaryAgentDir();
    let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
    const pi = {
      on(event: string, next: typeof handler) {
        if (event === "project_trust") handler = next;
      },
    } as unknown as ExtensionAPI;
    registerDSCodeProjectTrust(pi, agentDir);
    await expect(
      handler!(
        { type: "project_trust", cwd: "/work/project" },
        { hasUI: false, ui: { notify: () => undefined } },
      ),
    ).resolves.toEqual({ trusted: "no" });
  });

  async function temporaryAgentDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-trust-test-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
