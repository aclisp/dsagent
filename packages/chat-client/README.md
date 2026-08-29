# @aclisp/dsagent-chat-client

Provider-neutral Headless Chat Client for routing normalized IM conversations into a shared DSCode
Session through the in-process `SessionPort`.

```ts
import {
  createConversationAliasRegistry,
  createHeadlessChatClient,
} from "@aclisp/dsagent-chat-client";

const registry = await createConversationAliasRegistry({
  filePath: "/workspace/.dscode/conversations.json",
});
const chatClient = createHeadlessChatClient({
  workspaceId: "main",
  providerId: "wecom",
  conversationRegistry: registry,
  sessionPort,
  delivery: provider,
});

await chatClient.handleMessage({
  dedupeKey: "provider-event-1",
  messageId: "message-1",
  conversation: { providerId: "wecom", type: "group", address: "group-1" },
  sender: { providerId: "wecom", address: "user-1" },
  text: "检查当前工作并给出总结",
});
```

Providers own transport, credentials, event parsing, explicit-mention detection, self-message
filtering, raw reply references, and platform delivery calls. The Chat Client registers stable opaque
conversation/sender aliases, prefixes dedupe keys with the Provider identity, formats the agreed
`[IM message: ...]` marker, submits an internal source context, and correlates each accepted Turn
with its originating conversation.

Group and direct conversations use `group` and `direct` markers respectively. The original
conversation address is retained only for delivery; it is never placed in the Prompt. Completed
output is delivered only to the submitted or explicitly registered target. Temporary delivery
failures receive at most five retries with jittered exponential delays; `retryAfterMs` takes
precedence when supplied.
