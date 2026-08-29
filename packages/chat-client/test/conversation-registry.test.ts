import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConversationAliasRegistry } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryRegistryPath(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "dscode-conversation-registry-")),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, ".dscode", "conversations.json");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ConversationAliasRegistry", () => {
  it("reuses aliases for the same Provider address and isolates Provider/type keys", async () => {
    const registry = await createConversationAliasRegistry({
      random: (() => {
        let next = 1;
        return () => `token-${next++}`;
      })(),
    });

    const group = await registry.registerConversation({
      providerId: "wecom",
      type: "group",
      address: "group-1",
    });
    const sameGroup = await registry.registerConversation({
      providerId: "wecom",
      type: "group",
      address: "group-1",
    });
    const direct = await registry.registerConversation({
      providerId: "wecom",
      type: "direct",
      address: "group-1",
    });
    const otherProvider = await registry.registerConversation({
      providerId: "feishu",
      type: "group",
      address: "group-1",
    });

    expect(sameGroup.alias).toBe(group.alias);
    expect(direct.alias).not.toBe(group.alias);
    expect(otherProvider.alias).not.toBe(group.alias);
    expect(registry.conversationCount).toBe(3);
    expect(registry.resolveConversation(group.alias)).toEqual({
      status: "resolved",
      reference: group,
    });
    expect(registry.resolveConversation("conv-unknown")).toEqual({
      status: "unavailable",
      reason: "unknown_alias",
    });
  });

  it("reuses sender aliases only within the same Provider", async () => {
    const registry = await createConversationAliasRegistry({
      random: (() => {
        let next = 1;
        return () => `sender-${next++}`;
      })(),
    });

    const sender = await registry.registerSender({
      providerId: "wecom",
      address: "user-1",
    });
    const sameSender = await registry.registerSender({
      providerId: "wecom",
      address: "user-1",
    });
    const otherProvider = await registry.registerSender({
      providerId: "feishu",
      address: "user-1",
    });

    expect(sameSender.alias).toBe(sender.alias);
    expect(otherProvider.alias).not.toBe(sender.alias);
    expect(otherProvider.alias).not.toBe(
      (await registry.registerConversation({
        providerId: "wecom",
        type: "direct",
        address: "user-1",
      })).alias,
    );
    expect(registry.resolveSender(sender.alias)).toEqual({
      status: "resolved",
      reference: sender,
    });
  });

  it("persists aliases with raw addresses and restores them after reopening", async () => {
    const filePath = await temporaryRegistryPath();
    const registry = await createConversationAliasRegistry({
      filePath,
      random: () => "stable-token",
    });
    const conversation = await registry.registerConversation({
      providerId: "wecom",
      type: "direct",
      address: "user-1",
    });
    const sender = await registry.registerSender({
      providerId: "wecom",
      address: "user-1",
    });

    const reopened = await createConversationAliasRegistry({
      filePath,
      random: () => "different-token",
    });
    expect(reopened.resolveConversation(conversation.alias)).toEqual({
      status: "resolved",
      reference: conversation,
    });
    expect(reopened.resolveSender(sender.alias)).toEqual({
      status: "resolved",
      reference: sender,
    });
    expect(
      (await reopened.registerConversation({
        providerId: "wecom",
        type: "direct",
        address: "user-1",
      })).alias,
    ).toBe(conversation.alias);

    const serialized = await readFile(filePath, "utf8");
    expect(serialized).toContain("user-1");
    expect(serialized).toContain(conversation.alias);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("serializes concurrent registrations without assigning duplicate aliases", async () => {
    const registry = await createConversationAliasRegistry({
      random: (() => {
        let next = 1;
        return () => `token-${next++}`;
      })(),
    });

    const references = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        registry.registerConversation({
          providerId: "wecom",
          type: "group",
          address: `group-${index}`,
        }),
      ),
    );
    expect(new Set(references.map((reference) => reference.alias)).size).toBe(12);
    expect(registry.conversationCount).toBe(12);
  });

  it("does not silently recover from malformed or duplicate state", async () => {
    const filePath = await temporaryRegistryPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");

    await expect(createConversationAliasRegistry({ filePath })).rejects.toMatchObject({
      reason: "corrupt",
    });

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        conversations: [
          {
            alias: "conv-same",
            providerId: "wecom",
            type: "group",
            address: "group-1",
          },
          {
            alias: "conv-same",
            providerId: "wecom",
            type: "group",
            address: "group-2",
          },
        ],
        senders: [],
      }),
      "utf8",
    );
    await expect(createConversationAliasRegistry({ filePath })).rejects.toMatchObject({
      reason: "corrupt",
    });
  });

  it("starts safely without a missing registry and rejects invalid input", async () => {
    const filePath = await temporaryRegistryPath();
    const registry = await createConversationAliasRegistry({ filePath });

    expect(registry.resolveConversation("conv-old")).toEqual({
      status: "unavailable",
      reason: "unknown_alias",
    });
    await expect(
      registry.registerConversation({
        providerId: " ",
        type: "group",
        address: "group-1",
      }),
    ).rejects.toThrow("Provider ID must not be blank");
    await expect(
      registry.registerSender({ providerId: "wecom", address: " " }),
    ).rejects.toThrow("Sender address must not be blank");
  });

  it("skips an alias collision without rebinding an existing address", async () => {
    let calls = 0;
    const registry = await createConversationAliasRegistry({
      random: () => {
        calls += 1;
        return calls <= 2 ? "same-token" : "next-token";
      },
    });
    const first = await registry.registerConversation({
      providerId: "wecom",
      type: "group",
      address: "group-1",
    });
    const second = await registry.registerConversation({
      providerId: "wecom",
      type: "group",
      address: "group-2",
    });
    expect(first.alias).toBe("conv-same-token");
    expect(second.alias).toBe("conv-next-token");
    expect(registry.resolveConversation(first.alias)).toEqual({
      status: "resolved",
      reference: first,
    });
  });
});
