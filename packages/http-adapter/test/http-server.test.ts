import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpAdapterServer,
  type HttpAdapterServerHost,
} from "../src/http-server.js";

interface FakeHost extends HttpAdapterServerHost {
  calls: string[];
  abortCount: number;
  disposeCount: number;
}

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createFakeHost(options?: {
  output?: string;
  prompt?: (message: string) => Promise<void>;
}): FakeHost {
  const host: FakeHost = {
    calls: [],
    abortCount: 0,
    disposeCount: 0,
    session: {
      getLastAssistantText() {
        host.calls.push("output");
        return options?.output;
      },
    },
    async prompt(message) {
      host.calls.push(`prompt:${message}`);
      await options?.prompt?.(message);
    },
    async waitForIdle() {
      host.calls.push("wait");
    },
    async abort() {
      host.abortCount += 1;
    },
    async dispose() {
      host.disposeCount += 1;
    },
  };
  return host;
}

function createServer(host = createFakeHost()): FastifyInstance {
  const server = createHttpAdapterServer(host);
  servers.push(server);
  return server;
}

describe("createHttpAdapterServer", () => {
  it("reports health", async () => {
    const response = await createServer().inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("runs a turn and returns the final assistant text", async () => {
    const host = createFakeHost({ output: "Completed" });
    const response = await createServer(host).inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Review the repository" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ output: "Completed" });
    expect(host.calls).toEqual(["prompt:Review the repository", "wait", "output"]);
  });

  it("returns null when the turn has no assistant text", async () => {
    const response = await createServer().inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Run a command" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ output: null });
  });

  it.each([
    ["missing body", undefined],
    ["missing message", {}],
    ["wrong message type", { message: 1 }],
    ["empty message", { message: "" }],
    ["blank message", { message: "   " }],
    ["extra property", { message: "Hello", extra: true }],
  ])("rejects an invalid request: %s", async (_label, payload) => {
    const response = await createServer().inject({
      method: "POST",
      url: "/v1/turns",
      ...(payload !== undefined ? { payload } : {}),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects overlapping turns", async () => {
    let releasePrompt!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const host = createFakeHost({
      output: "Done",
      prompt: async () => {
        markStarted();
        await blocked;
      },
    });
    const server = createServer(host);

    const first = server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "First" },
    });
    await started;
    const second = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Second" },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "turn_in_progress" });
    expect(host.calls).toEqual(["prompt:First"]);

    releasePrompt();
    expect((await first).statusCode).toBe(200);
  });

  it("releases the turn guard after a failure", async () => {
    let attempts = 0;
    const host = createFakeHost({
      output: "Recovered",
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider failed");
      },
    });
    const server = createServer(host);

    const failed = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "First" },
    });
    const recovered = await server.inject({
      method: "POST",
      url: "/v1/turns",
      payload: { message: "Second" },
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "turn_failed" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ output: "Recovered" });
  });

  it("aborts and disposes the host when closed", async () => {
    const host = createFakeHost();
    const server = createServer(host);

    await server.close();
    await server.close();

    expect(host.abortCount).toBe(1);
    expect(host.disposeCount).toBe(1);
  });
});
