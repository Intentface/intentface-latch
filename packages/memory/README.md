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
- **Provenance**: every fact is tagged `user-said` / `tool-derived` /
  `user-requested`; the extractor is instructed to scrub secrets/PII.

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

## Caveat

On an org-shared connection, per-user scope separation is a **folder
convention** — anyone with workspace access can read `_memory/**`. Use a
personal connection where that matters.
