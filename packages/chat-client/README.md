# @thinkany/dscode-chat-client

Provider-neutral Headless Chat Client for joining a fixed group chat to a DSCode Session through the
in-process `SessionPort`.

```ts
import { createHeadlessChatClient } from "@thinkany/dscode-chat-client";

const chatClient = createHeadlessChatClient({
  workspaceId: "main",
  groupChatId: "group-1",
  sessionPort,
  delivery: {
    async reply(messageId, text) {
      await provider.reply(messageId, text);
      return { status: "delivered" };
    },
    async send(groupChatId, text) {
      await provider.send(groupChatId, text);
      return { status: "delivered" };
    },
  },
});

await chatClient.handleMessage({
  dedupeKey: "provider-event-1",
  groupChatId: "group-1",
  messageId: "message-1",
  senderName: "张三",
  text: "检查当前工作并给出总结",
});
```

The Provider owns transport, credentials, event parsing, explicit-mention detection, self-message
filtering, and platform delivery calls. The Chat Client only accepts normalized text messages. It
validates the fixed group, keeps a 10,000-entry/24-hour in-memory dedupe cache, submits Turns through
`SessionPort`, and correlates accepted `turnId` values with delivery targets.

Only completed output for submitted or explicitly registered Turns is delivered. Use
`registerTurnForGroupDelivery(turnId)` to deliver a proactive Turn as a new message in the bound
group. Failed, aborted, and unrelated Turns stay visible only in the shared Web UI Session.

Delivery methods classify attempts as `delivered`, `retryable`, or `permanent_failure`. Temporary
failures receive at most five retries with jittered exponential delays; `retryAfterMs` takes
precedence when supplied.
