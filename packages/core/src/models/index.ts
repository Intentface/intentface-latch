/**
 * @intentface/latch-core/models
 *
 * The model side of a Latch host, so no host hand-writes it: a models.dev-backed
 * catalog (ids, labels, pricing, reasoning capability, max output), provider
 * inference from a model id, and the `RuntimeConfig` hooks that depend on the
 * provider — reasoning effort, native web tools, prompt caching.
 *
 * A separate subpath because it is the one part of core that touches provider
 * SDKs — `@ai-sdk/anthropic|openai|google` are OPTIONAL peers, imported lazily
 * per provider only when that provider is usable (SDK installed + key set).
 * Importing the core root pulls in none of them.
 */
export { loadModelCatalog } from "./catalog.js";
export type { ModelCatalog, ModelCatalogOptions, ModelInfo } from "./catalog.js";
export { providerOf, providerFromId, PROVIDER_IDS } from "./provider.js";
export type { ProviderId } from "./provider.js";
export { makeResolveReasoningOptions } from "./reasoning.js";
export type { ReasoningEffort, ReasoningResolution } from "./reasoning.js";
export { makeResolvePromptCaching } from "./prompt-caching.js";
export { providerDefaults } from "./defaults.js";
export type { ProviderDefaultsOptions } from "./defaults.js";
