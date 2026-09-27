---
"@intentface/latch-core": patch
---

Provider web tools work on Claude Haiku. Anthropic's 20260209 web search and web fetch tools can be called from code execution, and Anthropic refuses them to a model without programmatic tool calling — every Haiku turn with `providerWebTools` failed with "does not support programmatic tool calling". Those models now get the direct-only versions (`webSearch_20250305`, `webFetch_20250910`); Opus and Sonnet from 4.6 and Claude 5 keep the newer ones.

`runAgent` says why a turn failed: it returns `error` (the stream's error text — a provider refusal, a tool source that would not open) beside the usually empty `answer`, where a failed turn used to look like a silent one.
