import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { compactAgentContext } from "../packages/core/src/compaction.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
  compat: {},
};

const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Preserved session summary" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

function createAgent(): Agent {
  const agent = new Agent({
    streamFn: () => {
      throw new Error("Unexpected agent request");
    },
  });
  agent.state.messages = ["First request", "Second request", "Third request"].map((content) => ({
    role: "user",
    content,
    timestamp: 0,
  }));
  return agent;
}

describe("context compaction with pi", () => {
  it.each([false, true])("preserves summary options with cancellation enabled: %s", async (cancellable) => {
    const agent = createAgent();
    const signal = cancellable ? new AbortController().signal : undefined;
    const completeSimple = vi.fn<Models["completeSimple"]>().mockResolvedValue(response);
    const models = { completeSimple } as unknown as Models;

    const result = await compactAgentContext(agent, models, model, {
      force: true,
      ...(signal ? { signal } : {}),
    });

    expect(completeSimple).toHaveBeenCalledOnce();
    const [, context, options] = completeSimple.mock.calls[0]!;
    expect(JSON.stringify(context.messages)).toContain("Preserve exact goals, decisions, file paths");
    expect(options).toMatchObject({ reasoning: "low", maxTokens: 25_600, cacheRetention: "none" });
    expect(options?.signal).toBe(signal);
    expect(result).toMatchObject({ compacted: true, usage: response.usage });
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Preserved session summary"),
    });
  });

  it("preserves history when the summary request is cancelled", async () => {
    const agent = createAgent();
    const originalMessages = agent.state.messages;
    const controller = new AbortController();
    const completeSimple = vi.fn<Models["completeSimple"]>().mockImplementation(
      async (_model, _context, options) => {
        controller.abort();
        expect(options?.signal?.aborted).toBe(true);
        return { ...response, stopReason: "aborted", errorMessage: "Summary cancelled" };
      },
    );

    await expect(
      compactAgentContext(agent, { completeSimple } as unknown as Models, model, {
        force: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Summary cancelled");
    expect(agent.state.messages).toBe(originalMessages);
  });
});
