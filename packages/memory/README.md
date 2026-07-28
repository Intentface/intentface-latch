# @intentface/latch-memory

Pluggable, platform-managed memory for Latch agents. Declare `memory` on an
agent and the platform does all upkeep:

1. **Always-loaded index** — a compiled `MEMORY.md` (≤100 lines, one fact per
   line with date, provenance, and source links) is injected into the system
   prompt every turn, plus standing instructions for the tools.
2. **Episodic store + recall** — immutable, timestamped episode notes live in
   the agent's own connection workspace under `_memory/<agent>/<scope>/`;
   the agent searches them on demand with `memory_search` (every recall is
   usage-tracked — the retention signal) and saves explicit "remember this"
   notes with `memory_save`.
3. **Background consolidation** — a cron sweep extracts durable facts from
   idle chats (`memory-extractor`, cheap model) and folds pending episodes
   into the index (`memory-consolidator`), superseding and expiring entries.

## Design invariants

- **Scopes** (`agent-user` | `agent-org` | `user`) are hard boundaries: tools
  are path-locked at construction, and consolidation never crosses a scope.
- **Non-destructive consolidation**: episodes are immutable; only the index is
  rewritten, every rewrite snapshots the previous version first, and the
  validator rejects any rewrite that silently drops a previously ACTIVE entry
  (supersede/expire = move to `## Archive`; archived entries may be dropped
  later — snapshots preserve history, so the size cap stays satisfiable).
- **Graceful degradation**: an unreachable/unauthorized store means a turn
  without memory, never a failed turn.
- **Anti-hot-loop**: every job completion advances its eligibility timestamp —
  success, failure, or "not actually memory-enabled".
- **Extraction idempotency**: every completed extraction records an idempotency
  key (`extractionRunKey` — content hash of the message window + the extraction
  prompt version). An unchanged window never re-buys a run, and a run that
  found NOTHING tombstones its content via the same key. Failed runs never
  record a key, so they stay retryable. Bump `EXTRACTION_PROMPT_VERSION` to
  invalidate old keys after a material prompt change.
- **Provenance**: every fact is tagged `user-said` / `tool-derived` /
  `user-requested`; the extractor is instructed to scrub secrets/PII.
- **Trust marks**: extractor-written episodes carry `status: unverified`
  frontmatter; index entries folded from them carry an `unverified` marker
  (labeled — in the injected block and in search results — never hidden). The
  consolidator promotes an entry only on later, independent corroboration.
  Explicit `memory_save` notes are never marked unverified.
- **Aliases + create-safety**: entries can carry `aka:` aliases (episodes:
  `aliases:` frontmatter) for subjects with several names/spellings.
  `memory_search` matches them exactly (NFKC/case/whitespace-normalized),
  tags every hit with `matchedOn` evidence (`alias-exact` | `description` |
  `body`), and derives a response-level `create_safety`
  (`exists` | `probable` | `unknown`) that `memory_save` instructs the agent
  to consult before creating anything new.
- **Injection hardening**: memory text is LLM-authored from user conversation —
  a prompt-injection persistence vector. At injection time (the `<memory>`
  block, search snippets) it passes through `sanitizeMemoryText`, which
  de-fangs envelope/role tags and strips a named set of known injection
  phrasings. Volume reduction, not a guarantee — the standing instructions
  additionally declare the envelope's content to be data, never instructions.

## Pieces

| Module | What it is |
| --- | --- |
| `types` / `scope` | `MemoryStore` seam, `ScopeRef` derivation (`scopeRefOf`) |
| `store/loredex` | `MemoryStore` over a Loredex MCP connection (opens per op via the `ConnectionRegistry`; tolerant result parsing; no delete — snapshot + rewrite) |
| `index-file` | MEMORY.md grammar: parse, `validateIndexRewrite`, id minting |
| `provider` | `createMemoryProvider` → the runtime's `MemoryProvider` (TTL-cached index block + bound tools) |
| `tools` | agent-facing `memory_search`/`memory_save` + scope-locked job tools |
| `prompts/*` | injection block, extractor/consolidator instructions + prompt builders |
| `jobs/types` | `MemoryJobStore` (implemented in `@intentface/latch-drizzle`: `createMemoryJobStore`) |

The sweep itself is platform glue (`apps/latch-platform/src/lib/memory/sweep.ts`),
following the Codex pattern: idle-gated parallel extraction, per-scope
lease-serialized consolidation with cooldown + watermark, usage-based expiry
(default 30 days unrecalled).

## Wiring it into a host

This package ships the ingredients, not the jobs — a host app (see
`apps/latch-platform` for the reference implementation of every step) wires:

1. **Tables + job store** — `@intentface/latch-drizzle`'s migrations create
   `latch_memory_chat_state` / `latch_memory_scope_state` / `latch_memory_usage`;
   build the store with `createMemoryJobStore(db)`.
2. **Store + provider → runtime** — in the composition root:

   ```ts
   const memoryStore = createLoredexStore({ connections });
   const memoryProvider = createMemoryProvider({
     store: memoryStore,
     scopeOf: ({ principal, agent, memory }) =>
       scopeRefOf({ agent, memory, userId: principal.userId }),
     recordUsage: (scopeKey, ids) => memoryJobs.recordUsage(scopeKey, ids, Date.now()),
     onEpisodeWritten: (a) => memoryJobs.touchScope(/* mark scope dirty */),
   });
   const runtime = createRuntime({ ...rest, memory: memoryProvider });
   ```

   That alone gives every agent declaring `memory` the injected index block and
   the `memory_search`/`memory_save` tools.
3. **Two job agents** — register `memory-extractor` and `memory-consolidator`
   as code agents (cheap model, no connections) built from the exported parts:
   `EXTRACTOR_INSTRUCTIONS`/`CONSOLIDATOR_INSTRUCTIONS` + the scope-locked tool
   factories (`memoryReadIndexTool`, `memoryWriteEpisodeTool`,
   `memoryReadEpisodesTool`, `memoryWriteIndexTool`), bound from the sweep's
   `turnContext`. Hide them from user-facing pickers (the platform reserves the
   `memory-*` name prefix).
4. **The sweep** — a cron-driven loop over `MemoryJobStore`: claim idle chats →
   `runtime.runAgent("memory-extractor", …)` under the chat's own reconstructed
   principal → advance the seq watermark; claim dirty scopes past cooldown →
   `runtime.runAgent("memory-consolidator", …)` → clear consumed episodes.
   Copy `apps/latch-platform/src/lib/memory/sweep.ts` — the always-advance
   eligibility discipline (no hot loops) and the lease fencing live there.
5. **Declare memory on agents** — `memory: { scope, connection }` in
   `defineAgent` config or the UI agent record; the connection must be one the
   agent itself declares.

## Caveat

On an org-shared connection, per-user scope separation is a **folder
convention** — anyone with workspace access can read `_memory/**`. Use a
personal connection where that matters.
