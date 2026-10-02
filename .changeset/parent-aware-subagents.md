---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-mcp": minor
---

Parent-aware subagent resolution and connection tool listing.

- core: `ChatRecord.parentAgent` records which agent spawned a sub-thread. `spawn_agent` sets it, and every resolve of that thread passes `{ parentAgent, autoApprove }` to `DynamicAgentStore.resolve(name, principal, ctx?)` — the first sub-turn, a continuation (`runAgent({ threadId })`, the chat surface), approval resumes (on the sub-thread or bubbled through the parent), client tool results, compaction, and crash recovery (`resume` / `sweep`). A host can shape a subagent per parent (e.g. which of a connector's tools a given agent may use) without the shaping lapsing on a later turn. Optional third argument; stores that ignore it behave as before.
- drizzle: `latch_chats.parent_agent` column (SQLite + Postgres; idempotent ALTER in `migrate`).
- mcp: `McpConnections.listTools(name, principal)` returns the caller's tool set for one connection with descriptions and annotations (`OpenMcp.toolInfos`, `McpToolInfo.description`) — optional on the interface, like `close`, so a hand-built registry need not offer it; `bearer({ header?, prefix? })` sends the token in a custom header (e.g. `X-API-Key`).

**Upgrading:** a host with its own `StorageAdapter` should accept `parentAgent` in `createChat` and return it from `getChat`. Without that, the parent is known only on the turn that spawns the thread, and any later resolve of it sees none.
