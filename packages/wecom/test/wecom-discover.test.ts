import { describe, expect, it } from "vitest";
import type {
  WeComMessageBody,
  WeComMessageFrame,
} from "../src/wecom-chat-provider.js";
import {
  extractWeComGroupChatId,
  runWeComDiscover,
  type WeComDiscoveryClient,
} from "../src/wecom-discover.js";

type Listener = (...args: unknown[]) => void;

class FakeDiscoveryClient implements WeComDiscoveryClient {
  private readonly listeners = new Map<string, Set<Listener>>();
  connectCount = 0;
  disconnectCount = 0;

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  connect(): this {
    this.connectCount += 1;
    return this;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function frame(
  content = "@Steve 绑定这个群",
  overrides: Partial<WeComMessageBody> = {},
): WeComMessageFrame {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "request-1" },
    body: {
      msgid: "message-1",
      aibotid: "bot-1",
      chatid: "group-1",
      chattype: "group",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content },
      ...overrides,
    },
  };
}

function ioHarness(): {
  stdout: string[];
  stderr: string[];
} {
  return { stdout: [], stderr: [] };
}

describe("WeCom Discovery", () => {
  it("extracts the group ID only from an explicitly addressed group message", () => {
    expect(
      extractWeComGroupChatId(frame("请 @Steve 绑定这个群"), {
        botId: "bot-1",
        botName: "Steve",
      }),
    ).toBe("group-1");
    expect(
      extractWeComGroupChatId(frame("请绑定这个群"), {
        botId: "bot-1",
        botName: "Steve",
      }),
    ).toBeUndefined();
  });

  it("ignores single chats, quotes, other bots, and the bot's own messages", () => {
    for (const overrides of [
      { chattype: "single" },
      { quote: { msgtype: "text" } },
      { aibotid: "other-bot" },
      { from: { userid: "bot-1" } },
    ]) {
      expect(
        extractWeComGroupChatId(frame("@bot 绑定", overrides), {
          botId: "bot-1",
          botName: "Steve",
        }),
      ).toBeUndefined();
    }
  });

  it("prints the first discovered group ID and disconnects without a reply", async () => {
    const client = new FakeDiscoveryClient();
    const io = ioHarness();
    const run = runWeComDiscover([], {
      env: {
        IM_WECOM_BOT_ID: "bot-1",
        IM_WECOM_SECRET: "secret-1",
        IM_WECOM_BOT_NAME: "Steve",
      },
      io: {
        stdout: (message) => io.stdout.push(message),
        stderr: (message) => io.stderr.push(message),
      },
      clientFactory: () => client,
    });

    await Promise.resolve();
    client.emit("message.text", frame());

    await expect(run).resolves.toBe(0);
    expect(io.stdout).toEqual(["IM_WECOM_GROUP_CHAT_ID=group-1"]);
    expect(io.stderr).toHaveLength(1);
    expect(client.connectCount).toBe(1);
    expect(client.disconnectCount).toBe(1);
  });

  it("rejects incomplete configuration before opening a connection", async () => {
    const io = ioHarness();
    const exitCode = await runWeComDiscover([], {
      env: {
        IM_WECOM_BOT_ID: "bot-1",
        IM_WECOM_SECRET: "secret-1",
      },
      io: {
        stdout: (message) => io.stdout.push(message),
        stderr: (message) => io.stderr.push(message),
      },
    });

    expect(exitCode).toBe(2);
    expect(io.stderr).toEqual([
      "IM_WECOM_BOT_ID, IM_WECOM_SECRET and IM_WECOM_BOT_NAME are required",
    ]);
  });

  it("does not echo credentials when the WebSocket client fails", async () => {
    const io = ioHarness();
    const exitCode = await runWeComDiscover([], {
      env: {
        IM_WECOM_BOT_ID: "bot-1",
        IM_WECOM_SECRET: "secret-1",
        IM_WECOM_BOT_NAME: "Steve",
      },
      io: {
        stdout: (message) => io.stdout.push(message),
        stderr: (message) => io.stderr.push(message),
      },
      clientFactory: () => {
        throw new Error("invalid bot-1 credential secret-1");
      },
    });

    expect(exitCode).toBe(1);
    expect(io.stderr.at(-1)).toBe(
      "WeCom discovery failed: invalid [REDACTED_SECRET] credential [REDACTED_SECRET]",
    );
    expect(io.stderr.join("\n")).not.toContain("secret-1");
  });
});
