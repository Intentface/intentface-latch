import { promptCachingPlanFor, type PromptCachingPlan } from "@intentface/latch-core";
import type { ModelInfo } from "./models";

/**
 * Build the `RuntimeConfig.resolvePromptCaching` hook over the model catalog —
 * the platform side of prompt caching (core applies the plan, the platform
 * knows which provider a model id belongs to). Anthropic models get explicit
 * cache breakpoints; OpenAI models get a cache routing key (`prompt_cache_key`
 * — OpenAI caches automatically, the key only improves shard routing); other
 * providers get nothing. `principalKey` scopes the OpenAI key per principal
 * for memory-enabled agents, whose system prompt is per-principal.
 */
export function makeResolvePromptCaching<P>(
  models: ModelInfo[],
  principalKey: (principal: P) => string,
) {
  const byId = new Map(models.map((m) => [m.id, m.provider]));
  return (
    modelId: string,
    args: { agent: string; memoryScoped: boolean; principal: P },
  ): PromptCachingPlan | undefined => {
    // Catalog first; id-prefix fallback mirrors `resolveProviderTools` for
    // models not in the catalog (offline fallback list, custom ids).
    const provider =
      byId.get(modelId) ??
      (modelId.startsWith("claude")
        ? "anthropic"
        : modelId.startsWith("gpt") || modelId.startsWith("o")
          ? "openai"
          : modelId.startsWith("gemini") || modelId.startsWith("gemma")
            ? "google"
            : undefined);
    return promptCachingPlanFor(provider, {
      agent: args.agent,
      ...(args.memoryScoped ? { cacheKeySuffix: principalKey(args.principal) } : {}),
    });
  };
}
