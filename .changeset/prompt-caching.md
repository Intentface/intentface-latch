---
"@intentface/latch-core": minor
---

Prompt caching: a provider-generic plan the host resolves per model, applied in `buildTurn`.

`createRuntime` gains an optional `resolvePromptCaching(modelId, { agent })` hook. Return a
`PromptCachingPlan` — build one with `promptCachingPlanFor(provider, …)` — and the turn sets
the provider options that keep the stable prompt prefix cached instead of re-billed on every
step of the tool loop. Hosts that don't pass the hook are unaffected.

For Anthropic that means three of the four available `cache_control` breakpoints: the last
function tool definition (so the tool prefix survives a system-block change), the system
message holding the agent instructions, and a rolling request-level marker. The date line
moves into a separate unmarked system message, so the daily flip no longer invalidates the
system breakpoint at midnight UTC. For OpenAI it sets `promptCacheKey` for shard routing.

New exports from `@intentface/latch-core`: `promptCachingPlanFor`, `mergeProviderOptions`,
`toolsetHash`, `markLastFunctionTool`, and the `PromptCachingPlan` type.

`RunRecord` gains optional `kind` and `toolsHash`; `UsageRecord` gains optional
`cacheReadTokens` and `cacheWriteTokens`; `createRun` accepts an optional `kind`. All
additive — existing `StorageAdapter` implementations keep compiling, but they will not
record the new fields until they store them.
