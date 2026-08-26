# @intentface/latch-core

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.1

## 0.3.0

### Minor Changes

- ddfa57b: `runtime.getChat({ principal, id })` — one chat by id, scoped to the caller.
  
  A direct lookup backed by `storage.getChat`, so "does this chat exist, and whose agent is it?"
  stays correct for a tenant with any number of chats. Previously the only read was `listChats`,
  which is a capped scan: anything past the limit is invisible, which silently breaks id-based
  questions for busy tenants.

## 0.2.0

### Patch Changes

- 194c789: Scheduled occurrences are now consumed before firing, and durability failures are no longer silent.
  
  **`runDue` advances `nextRunAt` immediately after the claim, before the fire.** Previously the
  advance sat in a `finally` after the turn, while the claim lease (stamped once, never renewed,
  30s default TTL) was the only thing keeping the row from being claimed again — so any scheduled
  turn longer than the TTL left its own occurrence re-claimable for the rest of the turn. A second
  node, a deploy overlap, the `POST cron/run` backstop, or even the same instance's next tick would
  then fire the same occurrence again, each time as a full paid turn. Worse, interleaved claimers
  fence-rejected each other's advances, so the row could stay due across many fires.
  
  Occurrences are now **at-most-once**: a process that dies mid-fire does not retry the occurrence —
  the run row survives and `sweep()` resumes the turn, so recovery never means a second paid attempt.
  If the advance itself fails, the fire is skipped (previously the failure was swallowed and the
  schedule would re-fire on every tick).
  
  **A thrown run-heartbeat write is no longer swallowed.** It is logged, and once consecutive
  failures span a full lease TTL the turn aborts — previously a run whose beats were all failing
  kept streaming at full token cost while the reaper reclaimed it and a second worker resumed the
  same turn. Step checkpoints (`onStepEnd`) also stop once the turn has aborted, so a zombie can no
  longer interleave messages into a chat its replacement is replaying into.
  
  Docs corrected to match: the claim lease alone was described as making occurrences "exactly-once
  across nodes" — it never did, and the drizzle schedule smoke now pins both halves of the real
  contract.
  
  No storage interface changes; existing adapters work unchanged.
- c782ec9: Non-`Error` throws and empty-message errors are described instead of masked.
  
  `clientErrorMessage` already forwarded real `Error` messages, but a non-`Error` throw (a raw
  HTTP body, a JSON-RPC error object, a plain string) or an `Error` with an empty message
  collapsed to the bare "An error occurred." — which turned an MCP server's
  `404 {"error":"Session not found"}` into an undebuggable generic string in the chat. Such
  values are now serialized (bounded at 300 chars, cycle-safe) into the client-visible error
  text; named error classes with empty messages report their name.

## 0.1.0

### Minor Changes

- 166c7a8: Prompt caching: a provider-generic plan the host resolves per model, applied in `buildTurn`.
  
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

## 0.0.1

### Patch Changes

- 9dd4f7a: First release. Publishes the `@intentface/latch-*` scope to GitHub Packages: the
  runtime and seams (`latch-core`), storage (`latch-drizzle`), the mountable HTTP
  surface (`latch-server`), tool sources (`latch-mcp`, `latch-openapi`), memory,
  channels, the agent-builder store, tracing, and the SSRF helpers.
