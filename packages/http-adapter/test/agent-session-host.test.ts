import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionHost } from "../src/agent-session-host.js";
import { createHttpUiBroker, type HttpUiBrokerEvent } from "../src/ui-broker.js";

const ENV_KEYS = [
  "DSCODE_HOME",
  "DSCODE_SESSIONS_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;
const originalEnvironment = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("createAgentSessionHost", () => {
  it("creates and disposes an in-process DSCode session without provider calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    const broker = createHttpUiBroker();
    const events: HttpUiBrokerEvent[] = [];
    const host = await createAgentSessionHost({
      cwd: workspace,
      runtimeArgs: [
        "--provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
        "--effort",
        "high",
        "--permission",
        "auto",
      ],
      uiBroker: broker,
    });
    host.subscribe((event) => events.push(event));

    try {
      expect(host.session.model).toMatchObject({
        provider: "deepseek",
        id: "deepseek-v4-flash",
      });
      expect(host.session.sessionManager.isPersisted()).toBe(false);
      expect(host.session.extensionRunner.hasUI()).toBe(true);
      expect(host.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(["exec_command", "apply_patch"]),
      );
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "status",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "title",
        ),
      ).toBe(true);
      await expect(host.prompt("/clear")).rejects.toThrow(
        "Session command /clear is not supported",
      );

      const firstDispose = host.dispose();
      const secondDispose = host.dispose();
      expect(secondDispose).toBe(firstDispose);
      await firstDispose;
      await expect(host.prompt("Do not run")).rejects.toThrow("disposed");
    } finally {
      await host.dispose();
    }
  });

  it("rejects CLI-only arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    await expect(
      createAgentSessionHost({ cwd: root, runtimeArgs: ["--thinking", "high"] }),
    ).rejects.toThrow("Unsupported direct session argument");
  });
});
