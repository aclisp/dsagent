interface PayloadOptions {
  webSearch: boolean;
}

/**
 * Keep Pi's Responses API implementation while shaping the payload to the
 * subset DeepSeek V4 Flash actually supports.
 */
export function optimizeDeepSeekResponsesPayload(
  payload: unknown,
  options: PayloadOptions,
): unknown {
  if (!isRecord(payload)) return payload;

  const next: Record<string, unknown> = { ...payload };

  // DeepSeek manages prefix caching automatically and is stateless at the
  // Responses API layer. These OpenAI-specific hints are silently ignored, so
  // omit them to keep request traces honest and easier to debug.
  delete next.prompt_cache_key;
  delete next.prompt_cache_retention;
  delete next.prompt_cache_options;
  delete next.include;

  if (isRecord(next.reasoning)) {
    next.reasoning = { effort: next.reasoning.effort };
    // Sampling controls do not take effect while thinking is enabled.
    delete next.temperature;
    delete next.top_p;
  }

  const tools = Array.isArray(next.tools) ? [...next.tools] : [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (isRecord(tool) && tool.name === "apply_patch") {
      tools[index] = {
        type: "custom",
        name: "apply_patch",
        description: tool.description,
      };
    }
  }

  if (
    options.webSearch &&
    !tools.some((tool) => isRecord(tool) && tool.type === "web_search")
  ) {
    tools.push({ type: "web_search" });
  }

  if (tools.length > 0) next.tools = tools;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

