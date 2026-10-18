/**
 * Keep Pi's Responses API implementation while shaping the payload to the
 * subset DeepSeek Flash actually supports.
 */
export function optimizeDeepSeekResponsesPayload(
  payload: unknown,
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
  }

  // Let DeepSeek apply sampling controls. Temperature only affects non-thinking
  // mode (reasoning.effort: "none"). Flash uses top_p in thinking mode (minimum
  // 0.95) and fixes it at 1.0 otherwise. Pro ignores top_p in thinking mode
  // (0.95 with tools, 1.0 without) and uses it in non-thinking mode.

  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
