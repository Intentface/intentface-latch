# @intentface/latch-drizzle

## 0.13.0

### Minor Changes

- 41647d1: Candidates: named, unpublished configurations of an agent that everyone who can edit it shares — "haiku with shorter instructions", "new tools". Unlike a draft, which belongs to one person, a candidate belongs to the agent: `saveCandidate` / `getCandidate` / `listCandidates` / `closeCandidate` on the store, and `name@c_<id>` resolves one read-only, the way `name@7` pins a version, so it can be run (and measured) without going live. Closing one — discarded, or published with `publishedAs` — keeps it, so anything filed under it keeps its name and still resolves. New table `latch_agent_candidates` (SQLite and Postgres, created by `migrate`). `parseAgentRef` returns `at: "c_…"` for a candidate ref, and `isCandidateId` tells one apart.
  
  A pinned resolve (`name@7`, a draft, a candidate) now reports the version that actually runs as `configVersion` — `7`, or none for a draft or candidate — instead of the live one, so run records and traces attribute pinned answers correctly.
  
  **Upgrading:**
  
  - **A store of your own no longer type-checks.** `AgentBuilderStore` has four new required methods: `listCandidates`, `getCandidate`, `saveCandidate`, `closeCandidate`. Nothing calls them unless you use candidates, so a store that doesn't support them can throw from all four; `@intentface/latch-drizzle` implements them.
  - **Run `migrate`, or add the table yourself.** `migrate` creates `latch_agent_candidates`. If you build migrations from the exported schema (e.g. drizzle-kit) instead, generate one for `agentCandidates`. It is only read when candidates are used.
- 71630e1: Parent-aware subagent resolution and connection tool listing.
  
  - core: `ChatRecord.parentAgent` records which agent spawned a sub-thread. `spawn_agent` sets it, and every resolve of that thread passes `{ parentAgent, autoApprove }` to `DynamicAgentStore.resolve(name, principal, ctx?)` — the first sub-turn, a continuation (`runAgent({ threadId })`, the chat surface), approval resumes (on the sub-thread or bubbled through the parent), client tool results, compaction, and crash recovery (`resume` / `sweep`). A host can shape a subagent per parent (e.g. which of a connector's tools a given agent may use) without the shaping lapsing on a later turn. Optional third argument; stores that ignore it behave as before.
  - drizzle: `latch_chats.parent_agent` column (SQLite + Postgres; idempotent ALTER in `migrate`).
  - mcp: `McpConnections.listTools(name, principal)` returns the caller's tool set for one connection with descriptions and annotations (`OpenMcp.toolInfos`, `McpToolInfo.description`) — optional on the interface, like `close`, so a hand-built registry need not offer it; `bearer({ header?, prefix? })` sends the token in a custom header (e.g. `X-API-Key`).
  
  **Upgrading:** a host with its own `StorageAdapter` should accept `parentAgent` in `createChat` and return it from `getChat`. Without that, the parent is known only on the turn that spawns the thread, and any later resolve of it sees none.
- 015e0a1: Safe-mode runs stop stubbing tools the agent explicitly waived, and gain three
  per-turn levers for measurement. Agent references can pin a version.
  
  **Fix — a waived tool is not a gated one.** `blockGated` decided what to stub
  with a truthiness check. The SDK spells a waiver as the string
  `"not-applicable"` — and the drizzle store writes exactly that for every tool
  an agent sets to `false` — so every tool an agent had explicitly waived was
  stubbed in every safe-mode run. On an agent whose reads are waived to override
  a connection default, that is every read tool: the agent could not reach its
  own corpus, and an evaluation graded a model with no access to its tools.
  `gatedBy` now treats only `true`, `"user-approval"`, an object or a function
  as a gate.
  
  **Upgrading — waived tools now run in safe-mode runs.** A tool whose approval
  the agent turned off (`false`, `"not-applicable"`) was stubbed in every
  `runAgent` test run; it now executes, exactly as it does in a normal turn.
  Gated tools are still stubbed. If a test run relied on a waived tool that
  writes never being called, gate that tool or keep the run out of production
  data.
  
  **`blockGated: "simulate-success"`** stubs gated tools with a success-shaped
  result instead of a "blocked" one. A blocked result makes the agent narrate
  the failure into its answer ("I couldn't record this internally"), which then
  lands in the text being graded.
  
  **`memory: false`** on `runAgent` disables recall and memory tools for one
  turn. A sweep over many inputs under one principal otherwise has row 1's
  memory in context by row 20 — the rows stop being independent observations.
  
  **`model`** on `runAgent` overrides the agent's model for one turn; the
  telemetry model id follows it.
  
  **`parseAgentRef` reads `name@7` and `name@draft`**, and `resolve()` honours
  the pin read-only. Measuring an old version must never make it live; without
  this the only way to run v3 was to publish it.
  
  Platform (unpublished): a local SQLite file now runs WAL with a 10s busy
  timeout. `busy_timeout = 0` made a second writer fail instantly rather than
  wait, and a durable runtime writes a checkpoint per step — four agents in
  parallel lost checkpoints, which is not a crash but a silently truncated
  transcript.

### Patch Changes

- Updated dependencies [41647d1]
- Updated dependencies [3b0dbfb]
- Updated dependencies [71630e1]
- Updated dependencies [80f1630]
- Updated dependencies [015e0a1]
- Updated dependencies [96013b6]
  - @intentface/latch-agent-builder@0.13.0
  - @intentface/latch-core@0.13.0
  - @intentface/latch-memory@0.13.0

## 0.12.0

### Minor Changes

- e602c55: `reconstructPrincipal` can now refuse a stored identity by returning `null`, and
  the runtime makes that refusal terminal instead of replaying the identity.
  
  Until now the hook could only return a principal, so a user removed from their
  tenant after creating a schedule kept firing it — as themselves, indefinitely.
  Throwing did not stop it: a cron fire consumes its occurrence before rebuilding
  the principal, so the schedule stayed live and refused again on every tick, and
  a throw on resume aborted the rest of `sweep`'s loop.
  
  - **Cron:** a refused fire is not run, and the schedule is disabled in the same
    write that consumes the occurrence. `runDue` (and `cron().due`) report it in a
    new `rejected` counter, separate from `errors`. The result type is exported as
    `RunDueResult`.
  - **Resume:** a refused run ends `errored` (fenced write) without loading its
    history or resolving its agent as that identity, and `sweep` continues with
    the next run.
  - A **throw** keeps its current meaning — a transient failure: counted in
    `errors` and the occurrence consumed (a recurring schedule stays live; a
    one-shot is spent, as before). Only `null` refuses; `undefined` does not.
  - `sweep` now isolates each resume: a run whose resume throws is logged and
    retried once its lease lapses, instead of aborting the loop and stranding
    every reaped run after it (the reaper marks the whole batch `errored`, and no
    later reap selects those rows again).
  - A refused resume fires no `onRunFinished`: its meta carries the principal,
    and there is none.
  
  The hook now runs before the occurrence is consumed, inside the schedule's
  claim lease, so keep it well under `durability.leaseTtlMs`. If the lease does
  lapse, the fire is now skipped rather than duplicated: `completeSchedule` may
  return `false` when its fence rejected the write (another node holds the
  claim), and `runDue` then leaves the occurrence to that node. The drizzle
  adapter reports it; adapters returning `void` are treated as applied, as
  before. This also closes the older, narrower window between claim and consume.
  `completeSchedule` also takes an optional `claim` (`{ leaseExpiresAt }`, the
  value the claim stamped) so a re-claim by the SAME instance — two `runDue`
  passes sharing an `instanceId` — fences out the earlier pass's late consume;
  the drizzle adapter fences on it. Adapters that ignore it keep the owner-only
  fence.
  
  A refused resume also releases the run's lease, so the errored row cannot be
  re-claimed by a later `resume()`.
  
  Upgrading: existing hooks keep working unchanged. Tests that deep-equal
  `runDue`'s result need `rejected: 0`.

### Patch Changes

- 96cc9f7: Drop the AI SDK beta pin: both packages now declare `ai` as `>=7.0.0`, matching
  every other package in the repo.
  
  `latch-drizzle` and `latch-server` still declared `ai: ">=7.0.0-beta.178"` and
  dev-installed that exact beta, so a workspace install resolved two copies of
  `ai` — a beta for these two and a release for everyone else. Two copies in one
  process means two sets of error classes, so an `instanceof AISDKError` check
  across the boundary silently fails.
  
  No source change: the published code is byte-identical. Only the declared floor
  moves, from a prerelease nobody should still be on to the release line.
- Updated dependencies [e602c55]
  - @intentface/latch-core@0.12.0
  - @intentface/latch-agent-builder@0.12.0
  - @intentface/latch-memory@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [ae91f9c]
  - @intentface/latch-core@0.11.0
  - @intentface/latch-memory@0.11.0
  - @intentface/latch-agent-builder@0.11.0

## 0.10.0

### Minor Changes

- c70daf1: Agent records are now versioned, so editing a prompt no longer destroys the one
  that was running.
  
  `upsert` publishes: it writes the live record and appends a version, unless the
  content is unchanged — history stays a list of real changes rather than of save
  events. Rolling back is `activateVersion`, which moves a pointer and appends
  nothing, so flipping between two configurations can't inflate history. Each
  version carries its author, the fields that differ from its predecessor, and an
  optional note. A separate activation log records who made which version live and
  when, which the version list alone can't say once rollback stopped appending.
  
  Drafts are stored per editor, not per agent: `owner` is an isolation boundary a
  whole org shares, so a single draft per agent would let two admins silently
  overwrite each other's half-written prompt. A draft never affects a running
  agent, and carries the version it started from so a stale publish is detectable.
  
  The whole record is snapshotted, not just the instructions. A version is
  therefore always a configuration that actually ran together — restoring a prompt
  alone could produce a combination that never existed, such as one referencing a
  tool removed two edits ago.
  
  Runs and traces now record which version produced them (`agent_version` on the
  run, an `agent-version:<n>` Langfuse tag), so a past answer stays attributable to
  an exact configuration and scores can be compared across versions.
  
  Migrating backfills every existing agent as v1. Without it the first publish
  after upgrading would create v1 from the NEW content and the prompt that had been
  running would be lost — the exact failure this feature exists to prevent.

### Patch Changes

- Updated dependencies [65d1de5]
- Updated dependencies [c4458af]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0
  - @intentface/latch-agent-builder@0.10.0
  - @intentface/latch-memory@0.10.0

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
