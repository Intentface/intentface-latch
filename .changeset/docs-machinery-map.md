---
"@intentface/latch-core": minor
---

Prompt caching is now ON by default for first-party Anthropic and OpenAI models. With no `resolvePromptCaching` hook, the plan is derived from the model object's own `provider` string (`defaultPromptCachingPlan`) — measured at ~6× unit cost on MCP-heavy agents, which is not a default a host should have to discover by reading source. Conservative on purpose: only first-party provider ids match (Bedrock/Vertex untouched, since the Anthropic plan's request-level `cache_control` is first-party only). Opt out with `resolvePromptCaching: () => undefined`, or per turn with `promptCaching: false`. Hosts that already supply the hook are unchanged.

Agent factories now receive the runtime context as `context` (preferred) alongside the deprecated `runtime` alias — two different things named "runtime" made every example ambiguous, including the docs example that didn't compile. Existing factories destructuring `runtime` keep working.
