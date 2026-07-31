import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDSCodeHome,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  migrateLegacyDSCodeHome,
} from "../src/home.js";

describe("DSCode home", () => {
  const temporaryDirectories: string[] = [];
  const originalEnvironment = {
    home: process.env.DSCODE_HOME,
    sessions: process.env.DSCODE_SESSIONS_DIR,
    piHome: process.env.PI_CODING_AGENT_DIR,
    piSessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  };

  afterEach(async () => {
    restore("DSCODE_HOME", originalEnvironment.home);
    restore("DSCODE_SESSIONS_DIR", originalEnvironment.sessions);
    restore("PI_CODING_AGENT_DIR", originalEnvironment.piHome);
    restore("PI_CODING_AGENT_SESSION_DIR", originalEnvironment.piSessions);
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
    );
  });

  it("isolates the runtime from inherited Pi paths", async () => {
    const root = await temporaryDirectory();
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "history");
    process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, ".pi", "sessions");

    await initializeDSCodeHome();

    expect(getDSCodeHome()).toBe(path.join(root, "home"));
    expect(getDSCodeSessionsDir()).toBe(path.join(root, "history"));
    expect(process.env.PI_CODING_AGENT_DIR).toBe(path.join(root, "home"));
    expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(path.join(root, "history"));
    await expect(fs.stat(path.join(root, "home"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "history"))).resolves.toBeDefined();
  });

  it("copies legacy agent resources upward without overwriting new files", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, ".dscode");
    await fs.mkdir(path.join(home, "agent", "skills", "legacy"), { recursive: true });
    await fs.writeFile(path.join(home, "agent", "auth.json"), '{"deepseek":{"key":"old"}}\n');
    await fs.writeFile(path.join(home, "agent", "settings.json"), '{"theme":"old"}\n');
    await fs.writeFile(path.join(home, "agent", "skills", "legacy", "SKILL.md"), "legacy\n");
    await fs.writeFile(path.join(home, "settings.json"), '{"theme":"new"}\n');

    const migrated = await migrateLegacyDSCodeHome(home);

    expect(migrated).toEqual(expect.arrayContaining(["auth.json", "skills"]));
    expect(migrated).not.toContain("settings.json");
    expect(await fs.readFile(path.join(home, "settings.json"), "utf8")).toContain("new");
    expect(await fs.readFile(path.join(home, "skills", "legacy", "SKILL.md"), "utf8"))
      .toBe("legacy\n");
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-home-test-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
