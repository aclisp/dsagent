import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasStoredDeepSeekKey,
  removeStoredDeepSeekKey,
  saveDeepSeekKey,
  validateDeepSeekKey,
} from "../src/auth.js";

describe("DSCode authentication", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("merges credentials and stores auth.json with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dscode-auth-test-"));
    temporaryDirectories.push(directory);
    const authPath = path.join(directory, "agent", "auth.json");
    await writeFile(path.join(directory, "seed.json"), "{}", "utf8");
    await saveDeepSeekKey("  sk-test-secret  ", authPath);

    expect(await hasStoredDeepSeekKey(authPath)).toBe(true);
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(parsed.deepseek).toEqual({ type: "api_key", key: "sk-test-secret" });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);

    expect(await removeStoredDeepSeekKey(authPath)).toBe(true);
    expect(await hasStoredDeepSeekKey(authPath)).toBe(false);
  });

  it("distinguishes valid, rejected, and temporarily unverifiable keys", async () => {
    const validFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash", object: "model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const rejectedFetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const unavailableFetch = vi.fn(async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;

    await expect(
      validateDeepSeekKey("secret", "https://api.deepseek.com", "deepseek-v4-flash", validFetch),
    ).resolves.toEqual({ status: "valid", modelAvailable: true });
    await expect(
      validateDeepSeekKey("secret", "https://api.deepseek.com", "deepseek-v4-flash", rejectedFetch),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      validateDeepSeekKey("secret", "https://api.deepseek.com", "deepseek-v4-flash", unavailableFetch),
    ).resolves.toMatchObject({ status: "unverified" });

    expect(validFetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });
});
