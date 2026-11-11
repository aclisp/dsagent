import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

it("resolves the packaged skill from the production Server bundle outside the checkout cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-server-skill-"));
  const home = path.join(root, "home"); await mkdir(home);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  let payload: Record<string, unknown> | undefined;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
    payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "offline prompt probe" } }));
  });
  await new Promise<void>(resolve => { model.listen(0, "127.0.0.1", resolve); });
  const reserve = createServer(); await new Promise<void>(resolve => { reserve.listen(0, "127.0.0.1", resolve); });
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => { reserve.close(() => resolve()); });
  const inherited = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
    .flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/server.js", import.meta.url))], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited,
      HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
      DSCODE_HOME: home, DSCODE_SESSIONS_DIR: path.join(root, "sessions"), DSCODE_CREDENTIALS_STORE: "file",
      DEEPSEEK_API_KEY: "offline-fixture", IM_WECHAT_ENABLED: "false", HOST: "127.0.0.1", PORT: String(port),
      WORKSPACES: `server-skill-fixture=${root}`, TZ: "UTC",
      RUNTIME_ARGS: `--provider deepseek --model deepseek-flash --no-mcp --sandbox read-only --base-url http://127.0.0.1:${(model.address() as AddressInfo).port}`,
    },
  });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exited = once(child, "exit");
  try {
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(output);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    }, { timeout: 8000 });
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "server-skill-fixture" }) });
    expect(created.status).toBe(201); const session = await created.json() as { id: string };
    const turn = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ordinary prompt probe" }) });
    expect(turn.status).toBe(202); await vi.waitFor(() => expect(payload).toBeDefined());
    const text = JSON.stringify(payload);
    expect(text).toContain("<name>scheduled-tasks</name>"); expect(text).not.toContain("Manage the current workspace's");
    const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const location = strings(payload).join("\n").match(/<name>scheduled-tasks<\/name>[\s\S]*?<location>([^<]+)<\/location>/)![1]!;
    const entities: Record<string, string> = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" };
    const file = location.replace(/&(amp|apos|quot|lt|gt);/g, (_all, name: string) => entities[name]!);
    expect(await readFile(file, "utf8")).toBe(await readFile(new URL("../../../deploy/default-skills/scheduled-tasks/SKILL.md", import.meta.url), "utf8"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited; model.closeAllConnections(); await new Promise<void>(resolve => { model.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
