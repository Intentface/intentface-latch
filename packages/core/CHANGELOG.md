# @intentface/latch-core

## 0.9.1

### Patch Changes

- 4b5e9eb: Two delegation paths had drifted from the rules the rest of the runtime applies.
  
  A test run (`runAgent` / `test_agent`: autonomous with gated tools stubbed) that
  delegated through `spawn_agent` handed the child only its approval mode, not
  the stub flag — so a "side-effect-free" trial could delegate to an agent whose
  gated tools ran for real. The child now inherits the parent's execution
  restrictions as a set.
  
  Resuming a subagent after a bubbled-up approval decision re-ran its model over
  history whose last message was the paused assistant turn, without trimming the
  trailing narration the other continuation paths (`applyApproval`,
  `applyToolResult`, crash recovery) already strip. Providers that refuse an
  assistant prefill rejected that request. The subagent resume now applies the
  same trim.
- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- 516d8f0: Per-step checkpoints (durability on) now commit in step order, and the finish
  handler's final write is the row's last write.
  
  Each checkpoint replaces the in-progress assistant message wholesale. They were
  fire-and-forget with nothing ordering them, so a slow early write could commit
  after a later one and roll the stored message back to an older step — a crash
  in that window re-ran a step that had already been persisted — and the final
  step's checkpoint raced the finish handler for the same row, where a late
  checkpoint clobbered the usage and cost metadata only the finish handler stamps.
  
  Checkpoints are now chained: each write starts the moment the one before it
  commits, and the finish handler awaits the chain before it settles the run row
  and persists the final message. Recovery never revisits a completed run, so a
  row that says `completed` now always sits next to a message that already holds
  the final step — previously the last checkpoint could still be in flight at
  that moment, and a crash there lost the answer text. The chain orders, it does not batch — a crash at step N still loses at
  most the write in flight and the one queued behind it. A failed checkpoint logs
  and releases the chain, as before.
- 8fd120a: Crash recovery no longer re-runs a turn that had already finished.
  
  Finishing the tool loop and recording that it finished are two separate writes:
  the per-step checkpoint lands at each step's end, while the run row becomes
  `completed` in the finish handler. A process that dies between them leaves a
  finished turn on an `active` row, so the reaper picks up a run whose answer is
  already in history.
  
  `resume()` now reads the tail of that history first. A last step that called no
  tool means the loop had stopped, so the row is reconciled (`completed`, or
  `awaiting_input` when a gate is pending) without a model call — previously the
  answer was generated a second time and, because the message id is reused,
  appended to the message that already held the first one. A turn waiting on a
  client-handled tool (`askUser`) is finished in the same sense: `onFinish`
  records it as completed and the answer arrives through `applyToolResult`, so
  recovery records the same instead of re-running and asking the question twice.
  
  When work genuinely remains, the resumed history now also passes through
  `trimTrailingAssistantPrefill`, which the two human-decision resume paths
  already did and crash recovery never did. Without it a tail ending in the
  turn's own half-written sentence reaches the model as an assistant prefill,
  which models that refuse one reject on the request *shape* — so every identical
  retry fails until `maxAttempts` is spent.
  
  `trimTrailingAssistantPrefill` also gains an `unanchored` option (default off,
  so the decision paths are unchanged) that trims a tail with no `tool-*` part to
  anchor on. Crash recovery passes it as a guard: the one anchorless tail a
  checkpoint can produce is a tool-free turn, which the classifier now settles
  before the trim is reached.
  
  Recovery also checks whether the chat moved on. Reaped runs are resumed one at a
  time, and while one waits its chat is free — so a later message can start, and
  even finish, a whole turn first. That is read off the runs table, never inferred
  from message shapes: a user message is only ever persisted together with its
  run, so a later run in the same chat is the one fact that proves a later turn
  exists. Such a run settles as errored with the same outcome `openTurn` gives a
  stale run, rather than being classified (or re-run) against a conversation that
  moved on. Compaction runs are summaries, not turns, and do not count.
  
  The runtime now also warns at startup when durability is enabled on a storage
  adapter without `openTurn`: turn creation is then two writes, and a crash between
  them is a shape recovery can only partly reason about. Every shipped adapter
  implements it.
  
  Also exports `resumeShapeOf` for hosts that drive recovery themselves.
- Updated dependencies [8311508]
  - @intentface/latch-net@0.9.1

## 0.9.0

### Minor Changes

- ebc0afd: One active run per chat, enforced in storage. `createRun` / `claimRun` throw
  `ChatBusyError` (code `chat_busy`, `retryAfterMs`) when the chat already has a
  live active run; the drizzle adapters back it with a partial unique index on
  `latch_runs (chat_id) WHERE status = 'active'` (both dialects; existing
  duplicates are marked `superseded` on migrate), and supersede an active run
  whose lease — or, for non-durable runs, a 10-minute stale window — has expired
  before opening the next, bumping its fencing token so the old worker's late
  writes are refused. `reclaimRun` returns null for a crashed run whose chat has
  since moved on. New optional `StorageAdapter.openTurn` opens the run and
  appends the user message in one transaction (the shipped adapters implement it;
  the SQLite adapter now uses real transactions on async drivers such as libsql),
  so a refused message leaves no trace and a crash can't leave a run without its
  message; the HTTP handler maps the refusal to 409 with
  `Retry-After`; the channel kernel renders it as "still working". Two tabs, a
  webhook retry racing a reply, or a schedule firing mid-conversation can no
  longer interleave one history — on every surface, not only in channels.
- d062dd2: One cron entry point and one non-streaming turn path.
  
  - `runtime.cron({ now?, maxAttempts? })` fires due schedules (`runDue`), then —
    with durability on — reaps lease-expired runs and resumes them (`sweep`).
    The phases are isolated: a failure in one lands in `errors` and the other
    still runs. Point every cron at this and nothing else. `tick()` is removed
    (it was `storage.reapExpiredRuns` behind a method); `runDue`, `sweep` and
    `resume` stay for callers that want the halves. `POST cron/run` on the
    handler now returns `cron()`'s result (`{ due, reaped, resumed, errors }`)
    instead of `runDue()`'s.
  - `runAgent`, `spawn_agent` and scheduled fires now share one internal
    `runToCompletion` path (previously three near-copies), so approval
    semantics, telemetry linkage and the "did it park?" verdict can't drift.
    Behaviour is unchanged; `runAgent`'s result shape is unchanged.
  - `runTurnStream` (the ephemeral, persist-nothing turn) is removed along with
    the `ephemeral` / `responseFormat: "text"` / `onComplete` branches inside the
    turn builder. Its only consumer was a smoke test. If you need a non-persisted
    turn, that belongs as an option on `handleChat`, not a second entry point.
  - Every tool's `options.context` now also carries `runtime` (the `Runtime`
    itself), so harness tools can schedule, list chats or spawn runs without a
    host-global.
- 8745142: Remove configuration the runtime never read. `RuntimeConfig.secrets` (the
  vault resolver belongs on `createMcpConnections`, and tools resolve secrets
  from `options.context.principal`), `RuntimeConfig.codeModeWrap` and
  `AgentConfig.codeMode` (never executed), `ContextDefinition.toolsContext`
  (the runtime already hands every tool `{ ...runtimeContext, principal, run,
  writer }` as `options.context`), and the deprecated `runtime` alias on the
  agent factory argument (use `context`). Agent-builder's `model` factory
  receives `{ context, principal }` instead of `{ runtime, principal }`.
  
  Drizzle: the unused message-persistence override is gone — the `messages`
  option on both `createSqliteAdapter` and `createPostgresAdapter`, and the
  `MessageStore` type export from the package barrel.
- cbbd775: `@intentface/latch-core/models`: the model side of a host, so no host
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
- 78a40e3: One observation seam, and a callback that always identifies itself.
  
  - `RuntimeConfig.observability` (`onStep` / `onFinish` / `onError`) is folded
    into `LatchTelemetry`: `TelemetryRunMeta` gains `trigger` (what started the
    turn — `chat` / `decision` / `programmatic` / `schedule` / `resume`), and
    `LatchTelemetry` gains an optional `onStep(run, step)`. `onRunFinished`
    already covered `onFinish` and `onError` (status `"errored"` + the message).
    The two seams fired near-identical payloads at the same points; hosts now
    wire one object, and a tracer and plain callbacks compose instead of living
    in parallel. `TurnTrigger` moved to `telemetry.ts` (still exported from the
    package root).
  - Handler: `stateParams` and the legacy no-pin callback fallback are removed,
    and `resolveContext` loses its `extra` argument. Every flow the handler
    starts pins the resolved principal into the state; a callback without a pin
    is now rejected as `flow_expired` instead of asking the live session to
    stand in — the exact failure that once stored an org's tokens under a
    personal owner.
  - Fix: a turn whose model stream errored used to be settled as `completed`
    (the SDK still runs `onFinish` after `onError`) and reported to telemetry
    three times (`errored`, `errored`, `completed`). The first error now wins:
    one `errored` report, and the run row says `errored` with the message.
- 7d3c553: The last two pieces every host used to hand-write.
  
  - `@intentface/latch-core/harness`: the default harness tools — sandbox
    `bash`/`read_file`/`write_file`/`glob`/`grep` over the `sandbox` seam,
    `web_fetch` (clean markdown/text, images and PDFs as viewable media,
    SSRF-gated and DNS-pinned), `askUser` (client-handled pause), and
    `list_schedules`/`cancel_schedule` over `options.context.runtime`. Pass
    `harnessTools: defaultHarnessTools()`. `web_fetch`'s `turndown` and
    `@intentface/latch-net` are OPTIONAL peers of core, imported on first call.
    Lifted from latch-platform's sandbox/tools.ts + web-fetch.ts; the platform
    keeps only its policy (render_fetch, delivery-aware create_schedule, Slack
    tools).
  - `createLatchApp({ storage, agents, resolveContext })` in latch-server (and
    `createLatchHonoApp` on the hono subpath): the composition root with the
    defaults wired — durability on, croner cron evaluator, the models.dev
    catalog with pricing / reasoning / web-tool / prompt-caching hooks, the
    harness tools, the handler mounted, and an in-process `runtime.cron()`
    driver on long-running hosts (off on serverless). `agents` may be a
    function of the loaded catalog. Every default is overridable via
    `runtime` / `handler`. The example server is now ~30 lines of wiring.
- b22b3cf: Limits — per org / user / agent budgets on turns, tokens and cost.
  `createRuntime({ limits })` takes a `LatchLimits` seam: `limitsFor({ principal,
  agent, trigger })` names the counters a turn counts against and their caps
  (fixed, epoch-aligned windows), and a `LimitStore` holds the counters. The
  runtime refuses at admission with `LimitExceededError` (stable code
  `limit_exceeded`, `retryAfterMs`; the HTTP handler maps it to 429 with
  `Retry-After`), stops the tool loop once this turn's tokens reach the tightest
  remaining token budget, and settles tokens + cost on finish — resumes and
  subagent turns included. `runtime.cron()` prunes dead windows.
  `@intentface/latch-drizzle` adds `latch_limit_counters` (both dialects) and
  `createSqliteLimitStore` / `createPostgresLimitStore`.

### Patch Changes

- @intentface/latch-net@0.9.0

## 0.8.1

### Patch Changes

- e0e2000: Resuming an approved turn no longer dies on providers that reject assistant prefill. `trimTrailingAssistantPrefill` anchored on the last tool-ish part of the paused assistant message — but it accepted a bubbled `data-subagent-approval` marker as that anchor, and `data-*` parts are stripped before the model sees anything, so the narration the model streamed around the pause ("Once approved, it'll be…") stayed as the projection's last visible content. Providers without prefill support refuse that conversation, so clicking Approve in the agent builder produced an error instead of a continuation — intermittently, since it needed the model to have narrated before pausing.
  
  The trim now anchors only on parts the model projection keeps (`tool-*` / `dynamic-tool`), drops trailing `text`/`reasoning`/`step-start` (`step-start` included: it opens a new assistant message in conversion, which — with the text gone — would be empty, trading the prefill rejection for an empty-content one), and keeps the `data-*` approval markers, which the resumed turn re-persists and the UI and `hasPendingApproval` depend on.

## 0.8.0

### Minor Changes

- c5a64fd: Prompt caching is now ON by default for first-party Anthropic and OpenAI models. With no `resolvePromptCaching` hook, the plan is derived from the model object's own `provider` string (`defaultPromptCachingPlan`) — measured at ~6× unit cost on MCP-heavy agents, which is not a default a host should have to discover by reading source. Conservative on purpose: only first-party provider ids match (Bedrock/Vertex untouched, since the Anthropic plan's request-level `cache_control` is first-party only). Opt out with `resolvePromptCaching: () => undefined`, or per turn with `promptCaching: false`. Hosts that already supply the hook are unchanged.
  
  Agent factories now receive the runtime context as `context` (preferred) alongside the deprecated `runtime` alias — two different things named "runtime" made every example ambiguous, including the docs example that didn't compile. Existing factories destructuring `runtime` keep working.
  
  Note for the rare code that INVOKES a factory directly (tests, custom hosts): the ctx argument now requires both `context` and `runtime` (same value). Keeping both required protects the many factory *authors* — making `runtime` optional would type their destructured `runtime` as possibly-undefined — at the cost of the few direct callers, who pass the value twice.

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
