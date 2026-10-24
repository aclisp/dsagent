import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHooks } from "../packages/core/src/hooks.ts";
import * as processes from "../packages/core/src/process.ts";

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
    vi.stubEnv("DSCODE_HOME", agentDir);
    await fs.writeFile(path.join(agentDir, "hooks.json"), JSON.stringify({ hooks: {
      completed: [{ command: "notify-completed", args: ["{payload}"] }],
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
    const notify = vi.spyOn(processes, "runProcess").mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false,
    });
    return { session, faux, notify, errors };
  }

  const transientError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

  it.each<{ name: string; responses: FauxResponseStep[] }>([
    { name: "normal completion", responses: [fauxAssistantMessage("done")] },
    { name: "successful automatic retry", responses: [transientError(), fauxAssistantMessage("recovered")] },
    { name: "exhausted retries", responses: [transientError(), transientError()] },
  ])("notifies only after $name settles", async ({ responses }) => {
    const { session, faux, notify, errors } = await setup((pi) => {
      pi.on("agent_end", () => { expect(notify).not.toHaveBeenCalled(); });
    });
    faux.setResponses(responses);
    await session.prompt("Do the work");
    expect(faux.state.callCount).toBe(responses.length);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1].join(" ")).toContain('{"event":"completed"}');
    expect(errors).toEqual([]);
  });

  it("waits for a queued continuation before notifying", async () => {
    let queued = false;
    const { session, faux, notify, errors } = await setup((pi) => {
      pi.on("agent_end", () => {
        expect(notify).not.toHaveBeenCalled();
        if (queued) return;
        queued = true;
        pi.sendUserMessage("Also finish the follow-up", { deliverAs: "followUp" });
      });
    });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("follow-up done")]);
    await session.prompt("Start the work");
    expect(faux.state.callCount).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("does not notify when Esc aborts after a successful response", async () => {
    const { session, faux, notify, errors } = await setup((pi) => {
      pi.on("agent_before_settle", (_event, ctx) => { ctx.abort(); });
    });
    const settled: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "agent_settled") settled.push(event.aborted);
    });
    faux.setResponses([fauxAssistantMessage("done")]);
    await session.prompt("Start the work");
    expect(settled).toEqual([true]);
    expect(notify).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

});
