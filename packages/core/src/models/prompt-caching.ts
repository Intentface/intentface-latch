import { promptCachingPlanFor, type PromptCachingPlan } from "../prompt-caching.js";
import { providerOf } from "./provider.js";

/**
 * Build the `RuntimeConfig.resolvePromptCaching` hook over the model catalog —
 * core applies the plan; this side knows which provider a model id belongs to.
 * Anthropic models get explicit cache breakpoints; OpenAI models get a cache
 * routing key (`prompt_cache_key` — OpenAI caches automatically, the key only
 * improves shard routing); other providers get nothing. `principalKey` scopes
 * the OpenAI key per principal for memory-enabled agents, whose system prompt
 * is per-principal (omit it and memory-scoped turns share the agent key).
 */
export function makeResolvePromptCaching<P>(
  models: ReadonlyArray<{ id: string; provider: string }>,
  principalKey?: (principal: P) => string,
) {
  return (
    modelId: string,
    args: { agent: string; memoryScoped: boolean; principal: P },
  ): PromptCachingPlan | undefined =>
    promptCachingPlanFor(providerOf(modelId, models), {
      agent: args.agent,
      ...(args.memoryScoped && principalKey ? { cacheKeySuffix: principalKey(args.principal) } : {}),
    });
}
