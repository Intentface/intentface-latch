---
"@intentface/latch-drizzle": minor
---

Store the prompt-cache and toolset columns the caching stats read.

`latch_runs` gains `kind` and `tools_hash`; `latch_usage` gains `cache_read_tokens` and
`cache_write_tokens`. All four are nullable and added by `migrate`, so an existing database
needs no manual step and rows written before the upgrade simply read as absent.
