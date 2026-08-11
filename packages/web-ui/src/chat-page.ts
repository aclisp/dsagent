const CHAT_AGENT_NAME_TOKEN = "{{CHAT_AGENT_NAME}}";

export const DEFAULT_CHAT_AGENT_NAME = "Steve Code";

export function resolveChatAgentName(value: string | undefined): string {
  return value?.trim() || DEFAULT_CHAT_AGENT_NAME;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
    }
    return character;
  });
}

export function renderChatPage(template: Buffer, agentName: string): string {
  const escapedName = escapeHtml(agentName);
  return template.toString("utf8").replaceAll(CHAT_AGENT_NAME_TOKEN, () => escapedName);
}
