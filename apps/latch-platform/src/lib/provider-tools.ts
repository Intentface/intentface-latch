import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

/**
 * The model provider's NATIVE web tools (server-side, run by the provider), for
 * agents that opt into `providerWebTools`. Kept in the app (not core) since it
 * needs the provider SDKs. Anthropic exposes web search + fetch; OpenAI search
 * only; anything else → none. Tool keys match our own (`web_search`/`web_fetch`)
 * so prompts/rendering are consistent.
 */
export function resolveProviderTools(modelId: string): Record<string, unknown> {
  // Same provider split as models.ts's `modelFor` fallback.
  const isOpenAI = modelId.startsWith("gpt") || modelId.startsWith("o");
  if (isOpenAI) {
    return { web_search: openai.tools.webSearch() };
  }
  // Anthropic (Claude ids): native web search + fetch.
  return {
    web_search: anthropic.tools.webSearch_20260209(),
    web_fetch: anthropic.tools.webFetch_20260209(),
  };
}
