# @intentface/latch-core

## 0.7.0

### Minor Changes

- fcef9d2: The mounted HTTP surface catches up with the runtime, and an unattended fire that parks is now reported.
  
  - `POST /schedules` forwards `delivery` and `onParked` (both were silently dropped, which made the whole `runSchedule` delivery seam unreachable through the handler); an unknown `onParked` is a 400 rather than a silent default.
  - New `GET /schedules/:id` (owner-scoped, 404 for anything not in the caller's own list) and `POST /schedules/:id/run-now`, which arms the schedule for the next tick so "run now" goes through the ordinary `runDue` path instead of drifting from it.
  - `GET /runs` no longer returns each run's `identity` — the serialized principal is durable server state and a customer type the docs invite you to extend, so it never enters a browser payload. Read it server-side via `runtime.listRuns`.
  - `runDue` returns a new `parked` count: fires that ran and then stopped waiting on a human (tokens spent, no answer delivered), logged on the tick it happens. Counted in `fired` too — the turn did run. This matters most for a one-shot schedule, which has no later occurrence for `onParked` to skip.
  - Docs: the callback route's "resume a waiting chat" comment was wrong (it redirects; resuming is the client's job) — corrected, and the client continuation protocol is now documented in the server README.
- fcef9d2: Observability events now carry `trigger` — what started the turn, and so whether anyone is watching it: `"chat"` (a user message), `"decision"` (a human answered an approval or a client-handled tool), `"programmatic"` (a direct `runAgent` call — no client stream, so `runAgent` takes a `trigger` for hosts that know a person is waiting), `"schedule"` (a cron/one-shot fire), `"resume"` (the durability sweep recovering a crashed run). A subagent turn inherits its parent's trigger, like `rootChatId`.
  
  This is what makes `observability.onFinish` usable as an operational notification channel rather than only an analytics feed: it already carries `principal`, `chatId`, `runId`, `agent`, `status` and `cost`, but `status: "awaiting_input"` was indistinguishable between a scheduled fire nobody can answer and a gate rendering in front of a live user. Now `status === "awaiting_input" && (trigger === "schedule" || trigger === "resume")` is exactly "go tell this turn's owner". Documented in the Observability and Schedules seams, with a push example — no new seam, and no second overlapping way to learn the same fact.
  
  Relatedly, `runSchedule` may now return `{ handled, chatId?, parked? }` instead of a bare boolean. A host that takes over delivery owns the chat its fire ran in, so only it can report that chat (which the next occurrence's `onParked` check reads) and whether the fire parked (which joins `runDue`'s `parked` count). A bare `true`/`false` behaves exactly as before.

## 0.6.0

### Minor Changes

- 3721c48: `listChats` now projects each chat's latest run status as `ChatRecord.lastRunStatus`, derived at read time by one correlated, index-backed subquery in the drizzle adapters (never stored). Lets a list UI flag chats parked on a human (`awaiting_input` — a pending approval or question) without loading messages or scanning runs per chat. Because only the latest run counts, the flag self-heals: a continuation opens a new run, so a superseded pause stops showing the moment the conversation moves on. Optional field — custom adapters that don't populate it keep working unchanged.
- 8b9e1c8: Schedules get a parked-predecessor policy. When a scheduled fire's previous chat is still waiting on a human (an undecided approval or question), firing again just mints another parked chat and pays for the tokens up to the gate — on every tick, forever. `runDue` now checks the last fire's chat (the message-log fold, same predicates the interactive paths trust) and, under the default `onParked: "skip"`, consumes the occurrence without running; `onParked: "fire"` opts a schedule back into the old always-fire behavior. `runDue` returns a new `skipped` counter so quiet ticks stay legible. Storage: `ScheduleRecord.onParked` + `lastChatId`, and an OPTIONAL `noteScheduleFire` adapter method (drizzle implements it on both dialects with idempotent column migrations; custom adapters that skip it keep the old behavior).

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
