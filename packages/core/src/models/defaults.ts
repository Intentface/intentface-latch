import type { RuntimeConfig } from "../runtime.js";
import type { ModelCatalog } from "./catalog.js";
import { makeResolveReasoningOptions } from "./reasoning.js";
import { makeResolvePromptCaching } from "./prompt-caching.js";

export interface ProviderDefaultsOptions<P> {
  /**
   * Per-principal cache-key suffix for memory-enabled agents (their system
   * prompt is per-principal, so an OpenAI cache key shared across principals
   * would route badly). Typically the storage owner key.
   */
  principalKey?: (principal: P) => string;
  /**
   * Prompt caching on (default true). `false` turns caching off
   * (`resolvePromptCaching: () => undefined`) — the control arm of an A/B.
   */
  promptCaching?: boolean;
}

/**
 * The provider-specific `RuntimeConfig` hooks, derived from one catalog:
 * `pricing`, `resolveProviderTools`, `resolveReasoningOptions`,
 * `resolvePromptCaching`. Spread into `createRuntime({...})`; override any one
 * by listing it after the spread. This is what every host used to hand-write.
 */
export function providerDefaults<P, RC = unknown>(
  catalog: ModelCatalog,
  options: ProviderDefaultsOptions<P> = {},
): Pick<
  RuntimeConfig<P, RC>,
  "pricing" | "resolveProviderTools" | "resolveReasoningOptions" | "resolvePromptCaching"
> {
  return {
    pricing: catalog.pricing,
    resolveProviderTools: catalog.providerTools,
    resolveReasoningOptions: makeResolveReasoningOptions(catalog.models),
    resolvePromptCaching:
      options.promptCaching === false
        ? () => undefined
        : makeResolvePromptCaching<P>(catalog.models, options.principalKey),
  };
}
