import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeHandoffFixture, verifyWebHandoff } from "../scripts/web-handoff-smoke.mjs";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), rm: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal(), spawn: mocks.spawn }));
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal(), rm: mocks.rm }));

beforeEach(async () => {
  const fs = await vi.importActual("node:fs/promises");
  mocks.rm.mockImplementation(fs.rm);
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    // Exercise a real verification failure before the TUI becomes ready.
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("fixture startup failure"));
      child.emit("close", 73);
    });
    return child;
  });
});

afterEach(async () => {
  const fs = await vi.importActual("node:fs/promises");
  for (const [root] of mocks.rm.mock.calls) await fs.rm(root, { recursive: true, force: true });
  vi.resetAllMocks();
});

it("reports the TUI failure when fixture cleanup succeeds", async () => {
  await expect(verifyWebHandoff()).rejects.toThrow(/TUI exited \(73\).*fixture startup failure/);
});

it("keeps the original TUI failure visible when directory cleanup also fails", async () => {
  const busy = Object.assign(new Error("fixture directory is still busy"), { code: "EBUSY" });
  mocks.rm.mockRejectedValue(busy);
  const error = await verifyWebHandoff().catch(error => error);
  expect(error.message).toMatch(/TUI exited \(73\).*fixture startup failure/);
  expect(error.message).toContain(busy.message);
  expect(error.errors[0].message).toMatch(/TUI exited \(73\)/);
  expect(error.errors[1]).toBe(busy);
});

it.runIf(process.platform === "win32")("waits for a child to release its Windows working-directory lock", async () => {
  const fs = await vi.importActual("node:fs/promises");
  const { spawn } = await vi.importActual("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-handoff-lock-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const child = spawn(process.execPath, ["-e",
    "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready');"],
    { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill(), 5_000);
  let release;
  try {
    await once(child.stdout, "data");
    release = setTimeout(() => child.stdin.end(), 200);
    // A single rm attempt fails with EBUSY while this child owns its cwd.
    await removeHandoffFixture(root);
    expect(await closed).toEqual([0, null]);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(release);
    clearTimeout(deadline);
    child.kill();
    await closed;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10_000);
