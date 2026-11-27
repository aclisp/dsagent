import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSessionHost } from "../../http-adapter/src/agent-session-host.ts";
import type { ArtifactCommandDetails } from "../../http-adapter/src/artifact-command.ts";
import { parseRuntimeArgs } from "../../core/src/runtime-options.ts";
import { createWebUiServer } from "../src/web-ui-server.ts";

const WORKSPACE = "owner-workspace-id";
const OTHER = "another-workspace";

const fixtures: string[] = [];
const servers = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...servers].map(server => server.close()));
  servers.clear();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dscode-artifacts-")));
  fixtures.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const other = path.join(root, "other");
  await Promise.all([mkdir(home), mkdir(other), mkdir(path.join(workspace, "dist/nested"), { recursive: true })]);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  const entry = path.join(workspace, "dist/nested/start here.html");
  await Promise.all([
    writeFile(entry, '<script src="../module.js"></script>'),
    writeFile(path.join(workspace, "dist/module.js"), "window.fromSnapshot = true"),
    writeFile(path.join(workspace, "dist/.private"), "hidden"),
    writeFile(path.join(workspace, "outside.txt"), "outside"),
  ]);
  vi.stubEnv("DSCODE_HOME", home);
  vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("DSCODE_CONFIG_PATH", path.join(home, "config.json"));
  vi.stubEnv("DSCODE_CREDENTIALS_STORE", "file");
  vi.stubEnv("DEEPSEEK_API_KEY", "offline-fixture");
  const commands = new Map<string, string[]>();
  const modelCalls = vi.fn();
  const runtimeArgs = ["--no-mcp", "--permission", "full"];
  const start = async (workspaces = { [WORKSPACE]: workspace, [OTHER]: other }, handoff = false) => {
    const server = await createWebUiServer({
      workspaces,
      chatAgentName: "Fixture",
      maxUploadBytes: 1024,
      ...(handoff ? { runtimeOptions: parseRuntimeArgs(runtimeArgs).options, initialPosition: null } : { runtimeArgs }),
      requireWorkspaceIdForSessionList: true,
      createHost: async options => {
        const host = await createAgentSessionHost(options);
        const skill = host.session.resourceLoader.getSkills().skills.find(value => value.name === "publish-artifact");
        expect(skill).toBeDefined();
        expect(await readFile(skill!.filePath, "utf8")).toContain("dscode-artifact");
        host.session.agent.streamFunction = (_model, context) => {
          modelCalls();
          const last = context.messages.at(-1);
          const requested = last?.role === "user" && Array.isArray(last.content)
            ? last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
            : last?.role === "user" ? last.content : undefined;
          const calls = typeof requested === "string" ? commands.get(requested) : undefined;
          const message: AssistantMessage = {
            role: "assistant",
            content: calls
              ? calls.map(cmd => ({ type: "toolCall", id: `call_${randomUUID()}`, name: "exec_command", arguments: { cmd } }))
              : [{ type: "text", text: "OK" }],
            api: "openai-responses", provider: "deepseek", model: "deepseek-flash", timestamp: Date.now(),
            stopReason: calls ? "toolUse" : "stop",
            usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
            stream.end();
          });
          return stream;
        };
        return host;
      },
    });
    servers.add(server);
    return server;
  };
  return { workspace, other, start, commands, entry, modelCalls };
}

async function session(server: FastifyInstance, workspaceId = WORKSPACE): Promise<string> {
  const listed = await server.inject(`/v1/sessions?workspaceId=${workspaceId}`);
  const active = listed.json<{ sessions: { active: boolean; session: { id: string } | null }[] }>()
    .sessions.find(entry => entry.active);
  if (active?.session) return active.session.id;
  const response = await server.inject({ method: "POST", url: "/v1/sessions", payload: { workspaceId } });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

type ToolResult = { artifact?: ArtifactCommandDetails; isError: boolean; content: { text: string }[] };

async function turn(
  server: FastifyInstance,
  sessionId: string,
  message: string,
  clientId: string | null = "browser",
): Promise<ToolResult> {
  const base = `/v1/sessions/${sessionId}`;
  const response = await server.inject({
    method: "POST", url: base + "/turns",
    payload: { message, ...(clientId === null ? {} : { clientId }) },
  });
  expect(response.statusCode).toBe(202);
  await vi.waitFor(async () => expect((await server.inject(base)).json().status).toBe("idle"));
  const history = (await server.inject(base + "/messages")).json<{ messages: Array<ToolResult & { role: string }> }>();
  return history.messages.findLast(value => value.role === "toolResult")!;
}

it("publishes a session's prepared files across clients and restores links after restart", async () => {
  const h = await fixture();
  h.commands.set("prepare", ['dscode-artifact preview "dist/" "nested/start here.html"']);
  h.commands.set("可以把这个版本发给客户了", ["dscode-artifact publish"]);
  h.commands.set("list", ["dscode-artifact list"]);
  const server = await h.start();
  const id = await session(server);
  const premature = await turn(server, id, "可以把这个版本发给客户了");
  expect(premature.content[0]?.text).toContain("Prepare an artifact snapshot");
  const preview = await turn(server, id, "prepare", "another-browser");
  expect(preview.artifact).toEqual({
    kind: "preview", directory: "dist", entry: "nested/start here.html", files: ["module.js", "nested/start here.html"],
  });
  expect(preview.content[0]?.text).toContain('"nested/start here.html"');
  await writeFile(h.entry, "<h1>later workspace edit</h1>");
  const published = (await turn(server, id, "可以把这个版本发给客户了", null)).artifact;
  expect(published?.kind).toBe("published");
  if (published?.kind !== "published") throw new Error("Artifact was not published");
  const { sharePath } = published.publication;
  expect(sharePath).toMatch(/^\/s\/[A-Za-z0-9_-]{12}\/$/);
  const modelCalls = h.modelCalls.mock.calls.length;
  const sharePathWithoutSlash = sharePath.slice(0, -1);
  const entry = sharePath + "nested/start%20here.html";
  for (const url of [sharePath, sharePathWithoutSlash]) {
    for (const method of ["GET", "HEAD"] as const) {
      const redirect = await server.inject({ method, url });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe(entry);
      expect(redirect.headers["cache-control"]).toBe("no-store");
    }
  }
  const page = await server.inject(entry);
  expect(page.body).toBe('<script src="../module.js"></script>');
  expect(page.headers["referrer-policy"]).toBe("no-referrer");
  expect(page.headers["content-type"]).toMatch(/^text\/html/);
  const head = await server.inject({ method: "HEAD", url: sharePath + "module.js" });
  expect(head.statusCode).toBe(200);
  expect(head.headers["content-type"]).toMatch(/^text\/javascript/);
  expect(head.body).toBe("");
  expect(head.headers["content-length"]).toBe(String("window.fromSnapshot = true".length));
  for (const asset of [".private", "nested/", "outside.txt", "%2E%2E%2Foutside.txt", "publication.json"]) {
    expect((await server.inject(sharePath + asset)).statusCode).toBe(404);
  }
  const token = sharePath.split("/")[2]!;
  expect((await server.inject({ method: "POST", url: sharePath })).statusCode).toBe(404);
  expect((await server.inject({ method: "POST", url: `/v1/sessions/${token}/turns`, payload: { message: "hello" } })).statusCode).toBe(404);
  expect(h.modelCalls).toHaveBeenCalledTimes(modelCalls);
  expect((await server.inject(`/chat/${WORKSPACE}`)).headers["referrer-policy"]).toBe("no-referrer");
  expect((await server.inject(`/share/${WORKSPACE}/dist/nested/start%20here.html`)).body).toContain("later workspace edit");

  await server.close();
  servers.delete(server);
  const unrelated = await h.start({ [WORKSPACE]: h.other, [OTHER]: h.other });
  expect((await unrelated.inject(entry)).statusCode).toBe(404);
  await unrelated.close();
  servers.delete(unrelated);
  const resumed = await h.start({ [WORKSPACE]: h.workspace, [OTHER]: h.other }, true);
  expect((await resumed.inject(entry)).body).toBe(page.body);
  const resumedId = await session(resumed);
  expect((await turn(resumed, resumedId, "list")).artifact).toEqual({
    kind: "list", publications: [published.publication],
  });
  h.commands.set("publish the new version now", [
    'dscode-artifact preview "dist" "nested/start here.html"',
    "dscode-artifact publish",
  ]);
  const updated = (await turn(resumed, resumedId, "publish the new version now")).artifact;
  if (updated?.kind !== "published") throw new Error("The new version was not published");
  expect(updated.publication.sharePath).not.toBe(sharePath);
  const newEntry = updated.publication.sharePath + "nested/start%20here.html";
  expect((await resumed.inject(newEntry)).body).toContain("later workspace edit");
  expect((await resumed.inject(entry)).body).toBe(page.body);
  const otherId = await session(resumed, OTHER);
  h.commands.set("revoke", [`dscode-artifact revoke ${token}`]);
  expect((await turn(resumed, otherId, "list")).artifact).toEqual({ kind: "list", publications: [] });
  expect((await turn(resumed, otherId, "revoke")).isError).toBe(true);
  expect((await turn(resumed, resumedId, "revoke")).isError).toBe(false);
  for (const url of [sharePath, sharePathWithoutSlash, entry, sharePath + "module.js"]) {
    expect((await resumed.inject(url)).statusCode).toBe(404);
  }
  expect((await resumed.inject(newEntry)).statusCode).toBe(200);
  await resumed.close();
  servers.delete(resumed);
  expect((await (await h.start()).inject(entry)).statusCode).toBe(404);
}, 15_000);

it("rejects escaping paths and symlinks without exposing an unconfirmed snapshot", async () => {
  const h = await fixture();
  const server = await h.start();
  const id = await session(server);
  h.commands.set("outside", ['dscode-artifact preview "../other" "index.html"']);
  expect((await turn(server, id, "outside")).isError).toBe(true);
  await symlink(h.other, path.join(h.workspace, "dist/link"), "junction");
  h.commands.set("prepare", ['dscode-artifact preview "dist" "nested/start here.html"']);
  expect((await turn(server, id, "prepare")).content[0]?.text).toContain("not a regular file or directory");
  h.commands.set("list", ["dscode-artifact list"]);
  expect((await turn(server, id, "list")).artifact).toEqual({ kind: "list", publications: [] });
}, 10_000);
