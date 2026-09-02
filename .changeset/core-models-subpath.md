---
"@intentface/latch-core": minor
---

`@intentface/latch-core/models`: the model side of a host, so no host
hand-writes it. `loadModelCatalog()` (models.dev-backed: ids, labels, pricing
incl. the long-context tier, reasoning capability, max output; filtered to
providers whose SDK is installed and API key is set; static fallback offline),
`providerOf(modelId)` (one id → provider heuristic, catalog first), and
`providerDefaults(catalog)` — the `pricing` / `resolveProviderTools` /
`resolveReasoningOptions` / `resolvePromptCaching` hooks to spread into
`createRuntime`. The provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`,
`@ai-sdk/google`) become OPTIONAL peer dependencies of core, imported lazily per
provider only when usable — the core root still imports none of them. Lifted
from latch-platform's `models.ts` / `reasoning.ts` / `provider-tools.ts` /
`prompt-caching.ts`, which duplicated the provider-prefix inference three times.
