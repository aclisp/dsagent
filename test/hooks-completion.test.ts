import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHooks } from "../packages/core/src/hooks.ts";

describe("completed hooks with Pi sessions", () => {
  let root: string | undefined;
  let session: AgentSession | undefined;

  afterEach(async () => {
    session?.dispose();
    session = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup(extra?: (pi: ExtensionAPI) => void) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-completion-hooks-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(root, "completed.jsonl"), "");
    vi.stubEnv("DSCODE_HOME", agentDir);
    await fs.writeFile(path.join(agentDir, "hooks.json"), JSON.stringify({ hooks: {
      completed: [{
        command: process.execPath,
        args: ["-e", "require('fs').appendFileSync('completed.jsonl', process.argv[1] + '\\n')", "{payload}"],
      }],
    } }));
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      extensionFactories: [(pi) => {
        registerHooks(pi, () => ({ sandbox: "danger-full-access", network: false }));
        extra?.(pi);
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
    });
    const faux = fauxProvider();
    modelRuntime.registerNativeProvider(faux.provider);
    ({ session } = await createAgentSession({
      cwd: root, agentDir, modelRuntime, model: faux.getModel(),
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: [],
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
    return { session, faux, errors };
  }

  async function notifications() {
    const log = await fs.readFile(path.join(root!, "completed.jsonl"), "utf8");
    return log.split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  const transientError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

  it.each<{ name: string; responses: FauxResponseStep[] }>([
    { name: "normal completion", responses: [fauxAssistantMessage("done")] },
    { name: "successful automatic retry", responses: [transientError(), fauxAssistantMessage("recovered")] },
    { name: "exhausted retries", responses: [transientError(), transientError()] },
  ])("notifies only after $name settles", async ({ responses }) => {
    const { session, faux, errors } = await setup((pi) => {
      pi.on("agent_end", async () => { expect(await notifications()).toEqual([]); });
    });
    faux.setResponses(responses);
    await session.prompt("Do the work");
    expect(faux.state.callCount).toBe(responses.length);
    expect(await notifications()).toEqual([{ event: "completed" }]);
    expect(errors).toEqual([]);
  });

  it("waits for a queued continuation before notifying", async () => {
    let queued = false;
    const { session, faux, errors } = await setup((pi) => {
      pi.on("agent_end", async () => {
        expect(await notifications()).toEqual([]);
        if (queued) return;
        queued = true;
        pi.sendUserMessage("Also finish the follow-up", { deliverAs: "followUp" });
      });
    });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("follow-up done")]);
    await session.prompt("Start the work");
    expect(faux.state.callCount).toBe(2);
    expect(await notifications()).toEqual([{ event: "completed" }]);
    expect(errors).toEqual([]);
  });

  it("does not notify when Esc aborts after a successful response", async () => {
    const { session, faux, errors } = await setup((pi) => {
      pi.on("agent_before_settle", (_event, ctx) => { ctx.abort(); });
    });
    const settled: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "agent_settled") settled.push(event.aborted);
    });
    faux.setResponses([fauxAssistantMessage("done")]);
    await session.prompt("Start the work");
    expect(settled).toEqual([true]);
    expect(await notifications()).toEqual([]);
    expect(errors).toEqual([]);
  });

});
