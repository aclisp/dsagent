import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("exits the ConPTY bridge cleanly while its caller still holds stdin open", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-pty-shutdown-"));
  roots.push(root);
  // Replace only the platform-specific PTY dependency. Exercise the actual
  // bridge and Python interpreter shutdown on every CI host.
  await fs.writeFile(path.join(root, "winpty.py"), `
import socket
class Backend:
    ConPTY = 0
class PtyProcess:
    @classmethod
    def spawn(cls, *args, **kwargs):
        return cls()
    def __init__(self):
        self.fileobj, self.writer = socket.socketpair()
        self.alive = True
        self.writer.sendall(b"BRIDGE_READY\\n")
    def read(self, size):
        data = self.fileobj.recv(size)
        if not data:
            raise EOFError()
        return data.decode("utf-8")
    def write(self, text):
        if text == "finish":
            self.alive = False
            self.writer.close()
    def isalive(self):
        return self.alive
    @property
    def exitstatus(self):
        return 0
    def terminate(self, **kwargs):
        self.alive = False
    def close(self, **kwargs):
        self.fileobj.close()
        self.writer.close()
`);
  const python = process.env.DSCODE_TEST_PYTHON || (process.platform === "win32" ? "python" : "/usr/bin/python3");
  const bridge = fileURLToPath(new URL("./fixtures/windows-pty.py", import.meta.url));
  const child = spawn(python, ["-B", bridge, "fixture"], {
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONPATH: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", sent = false;
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (!sent && stdout.includes("BRIDGE_READY")) {
      sent = true;
      child.stdin.write(JSON.stringify({ text: "finish" }) + "\n");
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, signal] = await once(child, "close");
    expect(sent).toBe(true);
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
  }
}, 15_000);
