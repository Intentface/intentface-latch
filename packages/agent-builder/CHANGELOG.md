# @intentface/latch-agent-builder

## 0.20.0

### Minor Changes

- 58a56e2: **Deleting data.** Removing a person's data on request, or a customer who leaves, no longer means SQL behind Latch's back.
  
  - `runtime.deleteChat({ principal, chatId })` deletes a chat with its messages and runs, and the subagent threads it spawned. Its usage rows stay: the ledger records what was spent. It refuses while an answer is running (`ChatBusyError`). The handler serves it as `DELETE chats/:id` (`404` when the chat isn't the caller's, `409` while busy, `501` when storage can't delete).
  - `runtime.purgeOwner(segments, { also })` deletes everything stored for an owner path: `[orgId]` for an organization and everyone in it, `[orgId, userId]` for one person.
    - It runs every store until done and returns counts per store.
    - **Usage is kept by default**, re-filed one level up (`[orgId, userId]` → `[orgId]`) with its run id cleared, so billing totals stay right. Choose with `usage: "refile" | "keep" | "delete"` and `refileTo`. A one-segment path (a whole tenant) has nothing above it, so it needs `usage: "delete"` or `"keep"`.
    - It checks first that every store can purge, and refuses (`UnsupportedOperationError`) before deleting anything if one can't.
  - **New optional `purgeOwner`** on `StorageAdapter`, `SecretStore`, `AgentBuilderStore` and `MemoryJobStore`. It works in passes (`{ removed, done }`), is idempotent, and matches by prefix with a plain comparison, never SQL `LIKE`. `isUnderOwner(key, segments)` states the rule.
  - **New optional `deleteChats(principal, ids)`** on `StorageAdapter`: all or nothing, refusing with `ChatBusyError` if any of the chats has an answer running.
  - **latch-drizzle implements all of them.**
    - Run and message inserts look their chat up, so nothing can land for a deleted chat as an orphan. On Postgres the lookup waits for a deletion of that chat to commit, which serializes deleting a chat with a run starting in it.
    - A purge fences live runs before their chat goes.
    - The agent store also removes the drafts a person is writing in an organization's agents.
  - **Conformance kit:**
    - `deleteChats`: scoped, complete, all or nothing around a live run, and a deleted chat can't be written to.
    - `purgeOwner`: works in passes, idempotent, another owner untouched, a live run fenced out.
  
  **Fix:** an answer that failed partway never wrote its spend to the usage ledger, or onto its run, though it counted against limits. It now does both, so a bill from the ledger includes failed answers.

### Patch Changes

- Updated dependencies [58a56e2]
  - @intentface/latch-core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [302f5c0]
  - @intentface/latch-core@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [666085c]
- Updated dependencies [7339995]
  - @intentface/latch-core@0.18.0

## 0.17.1

### Patch Changes

- f2a16e5: Doc comments rewritten for people using the options: `createLatchApp` and `createLatchHandler`, MCP connections and `oauth()`, the storage and agent store options, and the Telegram, Slack and WhatsApp channels. They show in your editor and in the generated reference on the docs site. No code changes.
- Updated dependencies [a132539]
- Updated dependencies [0bee5fd]
  - @intentface/latch-core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [e16480d]
- Updated dependencies [39c2910]
- Updated dependencies [744431b]
  - @intentface/latch-core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [a8e7b0d]
- Updated dependencies [d655b0c]
  - @intentface/latch-core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [d4356e3]
- Updated dependencies [d77af82]
  - @intentface/latch-core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [ab7a88e]
  - @intentface/latch-core@0.14.0

## 0.13.3

### Patch Changes

- Updated dependencies [4fe9ecd]
  - @intentface/latch-core@0.13.3

## 0.13.2

### Patch Changes

- Updated dependencies [dfe9b90]
  - @intentface/latch-core@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [6fed7fa]
- Updated dependencies [cf10a1c]
  - @intentface/latch-core@0.13.1

## 0.13.0

### Minor Changes

- 41647d1: Candidates: named, unpublished configurations of an agent that everyone who can edit it shares — "haiku with shorter instructions", "new tools". Unlike a draft, which belongs to one person, a candidate belongs to the agent: `saveCandidate` / `getCandidate` / `listCandidates` / `closeCandidate` on the store, and `name@c_<id>` resolves one read-only, the way `name@7` pins a version, so it can be run (and measured) without going live. Closing one — discarded, or published with `publishedAs` — keeps it, so anything filed under it keeps its name and still resolves. New table `latch_agent_candidates` (SQLite and Postgres, created by `migrate`). `parseAgentRef` returns `at: "c_…"` for a candidate ref, and `isCandidateId` tells one apart.
  
  A pinned resolve (`name@7`, a draft, a candidate) now reports the version that actually runs as `configVersion` — `7`, or none for a draft or candidate — instead of the live one, so run records and traces attribute pinned answers correctly.
  
  **Upgrading:**
  
  - **A store of your own no longer type-checks.** `AgentBuilderStore` has four new required methods: `listCandidates`, `getCandidate`, `saveCandidate`, `closeCandidate`. Nothing calls them unless you use candidates, so a store that doesn't support them can throw from all four; `@intentface/latch-drizzle` implements them.
  - **Run `migrate`, or add the table yourself.** `migrate` creates `latch_agent_candidates`. If you build migrations from the exported schema (e.g. drizzle-kit) instead, generate one for `agentCandidates`. It is only read when candidates are used.
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

- Updated dependencies [3b0dbfb]
- Updated dependencies [71630e1]
- Updated dependencies [80f1630]
- Updated dependencies [015e0a1]
- Updated dependencies [96013b6]
  - @intentface/latch-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e602c55]
  - @intentface/latch-core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [ae91f9c]
  - @intentface/latch-core@0.11.0

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

- c4458af: `@intentface/latch-agent-builder` is importable again in Node ESM.
  
  0.9.1 shipped with relative imports missing their `.js` extension in five source
  files. TypeScript accepts those under `moduleResolution: "Bundler"` and never
  rewrites specifiers on emit, so the package compiled clean and then failed at
  `import('@intentface/latch-agent-builder')` with `ERR_MODULE_NOT_FOUND` — and
  since the exports map blocks deep paths, there was no consumer-side workaround.
  Only the `/record` subpath, whose file already carried the extensions, loaded.
  
  All 18 specifiers now carry `.js`. `pnpm verify:publish` also imports every
  published JS export target in Node for real, so a target that exists but does
  not load fails the release rather than the consumer.
- Updated dependencies [65d1de5]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0

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

## 0.9.0

### Minor Changes

- d96d6d8: `save_agent` no longer detaches state it doesn't manage: when the input omits
  `tools` (per-tool selection, editor-managed) or `attachedEvals` (an evals
  feature's rubrics), the existing record's values are carried over — pinned to
  the record's own scope so a same-named agent in the other scope never donates
  its state. `delete_agent`'s schedule cascade now runs regardless of the
  `scheduling` option (schedules may come from other surfaces; an orphan errors
  on every tick).
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

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0

## 0.5.0

### Patch Changes

- @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
