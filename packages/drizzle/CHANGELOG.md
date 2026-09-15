# @intentface/latch-drizzle

## 0.9.1

### Patch Changes

- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- Updated dependencies [4b5e9eb]
- Updated dependencies [8311508]
- Updated dependencies [516d8f0]
- Updated dependencies [8fd120a]
  - @intentface/latch-core@0.9.1
  - @intentface/latch-agent-builder@0.9.1
  - @intentface/latch-memory@0.9.1

## 0.9.0

### Minor Changes

- 42768f6: One agent-record schema. `@intentface/latch-agent-builder` now exports
  `AgentRecordSchema` (zod, also on the browser-safe `./record` subpath) plus
  `normalizeAgentRecord` / `parseAgentRecord` / `parseAgentRef`; the `AgentRecord`
  type is inferred from it. The record gains `exec.memory` (core `MemoryConfig`)
  and `attachedEvals`; the never-executed `exec.codeMode` is gone. The builder's
  `save_agent` takes the record itself (the `capabilities` → `exec` remap and the
  top-level `authoredTools`/`effort` fields are gone — write `exec.*`), so the
  model, an editor, and a host validator all speak one shape. `CapabilitySupport`
  adds `renderTools` and opt-in `memory`. `AgentBuilderExtension.validateSave`
  now receives `(principal, record)`; `SaveAgentInput` is removed.
  `AgentBuilderStore` adds `getRecord(p, name)` (pin-aware) and
  `listMemoryEnabledNames()`.
  
  Drizzle: `latch_agents` gains an `attached_evals` column (idempotent ALTER; DBs
  written by latch-platform already have it) and the agent store round-trips
  `attachedEvals`, resolves `exec.memory`, and implements the two new store
  methods. `byOwners` filters by name at the query.
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

- 240a4ce: One adapter body, two dialect wrappers. `createSqliteAdapter` and
  `createPostgresAdapter` shared ~460 duplicated lines that differed only in the
  database type, the schema import, and whether a message batch runs in a
  transaction; the same for the two secret stores. Both now delegate to
  `adapter.shared.ts` / `secret-store.shared.ts` (the `memory-job-store` pattern),
  with the transaction choice as a `withTx` seam: Postgres wraps the batch,
  SQLite stays sequential for synchronous drivers. Public names and behaviour are
  unchanged.
  
  Also: `createRun`, `claimRun` and `createSchedule` read the inserted row back
  with `.returning()` instead of a second SELECT; and `migrateWith` recognises
  "column already exists" when a driver wraps it (drizzle's better-sqlite3
  binding throws a `DrizzleError` with the SqliteError as `cause`), so its
  idempotent ALTERs no longer fail on a re-run against that driver.
- Updated dependencies [d96d6d8]
- Updated dependencies [42768f6]
- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-agent-builder@0.9.0
  - @intentface/latch-core@0.9.0
  - @intentface/latch-memory@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1
  - @intentface/latch-agent-builder@0.8.1
  - @intentface/latch-memory@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0
  - @intentface/latch-agent-builder@0.8.0
  - @intentface/latch-memory@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0
  - @intentface/latch-agent-builder@0.7.0
  - @intentface/latch-memory@0.7.0

## 0.6.0

### Minor Changes

- 3721c48: `listChats` now projects each chat's latest run status as `ChatRecord.lastRunStatus`, derived at read time by one correlated, index-backed subquery in the drizzle adapters (never stored). Lets a list UI flag chats parked on a human (`awaiting_input` — a pending approval or question) without loading messages or scanning runs per chat. Because only the latest run counts, the flag self-heals: a continuation opens a new run, so a superseded pause stops showing the moment the conversation moves on. Optional field — custom adapters that don't populate it keep working unchanged.
- 8b9e1c8: Schedules get a parked-predecessor policy. When a scheduled fire's previous chat is still waiting on a human (an undecided approval or question), firing again just mints another parked chat and pays for the tokens up to the gate — on every tick, forever. `runDue` now checks the last fire's chat (the message-log fold, same predicates the interactive paths trust) and, under the default `onParked: "skip"`, consumes the occurrence without running; `onParked: "fire"` opts a schedule back into the old always-fire behavior. `runDue` returns a new `skipped` counter so quiet ticks stay legible. Storage: `ScheduleRecord.onParked` + `lastChatId`, and an OPTIONAL `noteScheduleFire` adapter method (drizzle implements it on both dialects with idempotent column migrations; custom adapters that skip it keep the old behavior).

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0
  - @intentface/latch-memory@0.6.0
  - @intentface/latch-agent-builder@0.6.0

## 0.5.0

### Patch Changes

- @intentface/latch-memory@0.5.0
  - @intentface/latch-agent-builder@0.5.0
  - @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-agent-builder@0.4.1
  - @intentface/latch-core@0.4.1
  - @intentface/latch-memory@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-agent-builder@0.4.0
  - @intentface/latch-core@0.4.0
  - @intentface/latch-memory@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-agent-builder@0.3.1
  - @intentface/latch-core@0.3.1
  - @intentface/latch-memory@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0
  - @intentface/latch-agent-builder@0.3.0
  - @intentface/latch-memory@0.3.0

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
- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0
  - @intentface/latch-agent-builder@0.2.0
  - @intentface/latch-memory@0.2.0

## 0.1.0

### Minor Changes

- 166c7a8: Store the prompt-cache and toolset columns the caching stats read.
  
  `latch_runs` gains `kind` and `tools_hash`; `latch_usage` gains `cache_read_tokens` and
  `cache_write_tokens`. All four are nullable and added by `migrate`, so an existing database
  needs no manual step and rows written before the upgrade simply read as absent.

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [b00e813]
- Updated dependencies [166c7a8]
  - @intentface/latch-agent-builder@0.1.0
  - @intentface/latch-memory@0.1.0
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
  - @intentface/latch-agent-builder@0.0.1
  - @intentface/latch-memory@0.0.1
