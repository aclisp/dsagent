import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSessionHost, type AgentSessionHost } from "../../http-adapter/src/agent-session-host.ts";
import { createWebUiServer } from "../src/web-ui-server.ts";
import { parseRuntimeArgs } from "../../core/src/runtime-options.ts";

const roots: string[] = [];
const hosts: AgentSessionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-task-skill-")); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home);
  vi.stubEnv("DSCODE_HOME", home); vi.stubEnv("DSCODE_SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("DEEPSEEK_API_KEY", "offline-fixture"); vi.stubEnv("DSCODE_CREDENTIALS_STORE", "file");
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  const host = async (scheduledTasks = true, extra: string[] = []) => {
    const value = await createAgentSessionHost({ cwd: root, scheduledTasks, session: { type: "persistent" },
      runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-flash", "--no-mcp", ...extra] });
    hosts.push(value); return value;
  };
  return { root, home, host };
}
const skills = (host: AgentSessionHost) => host.session.resourceLoader.getSkills().skills.filter(skill => skill.name === "scheduled-tasks");
function capture(host: AgentSessionHost): string[] {
  const requests: string[] = [];
  host.session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "OK" }],
      api: "openai-responses", provider: "deepseek", model: "deepseek-flash", timestamp: Date.now(), stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); }); return stream;
  };
  return requests;
}

it("exposes metadata initially and loads the body through the native skill command", async () => {
  const h = await fixture(); const host = await h.host(); const requests = capture(host);
  const skill = skills(host)[0]!;
  expect(await readFile(skill.filePath, "utf8")).toContain("Manage the current workspace's");
  await host.prompt("ordinary request");
  expect(requests[0]).toContain("<name>scheduled-tasks</name>");
  expect(requests[0]).not.toContain("Manage the current workspace's");
  await host.prompt("/skill:scheduled-tasks inspect my tasks");
  expect(requests[1]).toContain("Manage the current workspace's");
  expect(requests[1]).toContain('skill name=\\"scheduled-tasks\\"');
});

it("keeps an existing same-name skill authoritative and restores the fallback after reload", async () => {
  const h = await fixture(); const directory = path.join(h.home, "skills/scheduled-tasks"); await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, "---\nname: scheduled-tasks\ndescription: User task policy\n---\nCUSTOM_TASK_POLICY\n");
  const host = await h.host(); expect(skills(host)).toHaveLength(1); expect(skills(host)[0]!.filePath).toBe(file);
  await host.session.reload(); expect(skills(host)[0]!.filePath).toBe(file);
  await rm(directory, { recursive: true }); await host.session.reload();
  expect(skills(host)).toHaveLength(1); expect(skills(host)[0]!.filePath).not.toBe(file);
  await host.session.reload(); expect(skills(host)).toHaveLength(1);
});

it("honors --no-skills in direct arguments and in the TUI handoff snapshot", async () => {
  const h = await fixture(); const direct = await h.host(true, ["--no-skills"]); expect(skills(direct)).toEqual([]);
  expect(direct.handoff.getOptions().noSkills).toBe(true);
  const options = parseRuntimeArgs(["--no-mcp", "--no-skills"]).options;
  const resumed = await createAgentSessionHost({ cwd: h.root, scheduledTasks: true, runtimeOptions: options, session: { type: "persistent" } });
  hosts.push(resumed); expect(skills(resumed)).toEqual([]);
  await resumed.session.reload(); expect(skills(resumed)).toEqual([]);
});

it("leaves a bare HTTP host without the built-in skill", async () => {
  const h = await fixture(); const host = await h.host(false); const requests = capture(host);
  expect(skills(host)).toEqual([]); await host.prompt("ordinary request");
  expect(requests[0]).not.toContain("<name>scheduled-tasks</name>");
});

it("preserves explicitly supplied skills with --no-skills across handoff", async () => {
  const h = await fixture(); const directory = path.join(h.root, "explicit/scheduled-tasks"); await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, "---\nname: scheduled-tasks\ndescription: Explicit task policy\n---\nEXPLICIT_TASK_POLICY\n");
  const first = await h.host(true, ["--no-skills", "--skill", file]);
  expect(skills(first)[0]!.filePath).toBe(file);
  const second = await createAgentSessionHost({ cwd: h.root, scheduledTasks: true,
    runtimeOptions: first.handoff.getOptions(), session: { type: "persistent" } });
  hosts.push(second); expect(skills(second)).toHaveLength(1); expect(skills(second)[0]!.filePath).toBe(file);
});

it("registers the capability only for the workspace with a Scheduler", async () => {
  const h = await fixture(); const other = path.join(h.root, "other"); await mkdir(other);
  const created: AgentSessionHost[] = [];
  const server = await createWebUiServer({ workspaces: { first: h.root, second: other },
    chatAgentName: "Fixture", maxUploadBytes: 1024, runtimeArgs: ["--no-mcp"],
    createHost: async options => { const host = await createAgentSessionHost(options); created.push(host); return host; },
  });
  try {
    for (const workspaceId of ["first", "second"]) {
      expect((await server.inject({ method: "POST", url: "/v1/sessions", payload: { workspaceId } })).statusCode).toBe(201);
    }
    expect(skills(created[0]!)).toHaveLength(1); expect(skills(created[1]!)).toEqual([]);
  } finally { await server.close(); }
});
