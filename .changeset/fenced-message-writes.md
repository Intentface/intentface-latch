---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

A run that lost its lease can no longer write into the conversation, lease times come from the database's clock, and storage adapters get a conformance suite.

- **Fenced message writes.** `appendMessages(chatId, messages, fence?)` takes the turn's lease (`RunFence`: `{ runId, owner, fencingToken }`). A durable turn passes it on every step checkpoint and on its final message, and the write lands only while the run still holds that lease, checked in the same statement as the write. Before, only the run row was fenced: a worker that had lost its run (a long pause, a network blip) could keep writing messages into a chat another node was now running, for up to one lease TTL. A refused write persists nothing and returns `false`; the turn then stops as if its heartbeat had failed.
- **One clock for leases.** The drizzle adapters set, renew and compare every lease time with the database's clock (`clock_timestamp()` on Postgres, `julianday('now')` on SQLite) instead of each app server's `Date.now()`. Clock skew between servers can no longer make one node reap a run another is still renewing. `reapExpiredRuns(now?)`: `now` is now optional and the runtime omits it; pass it only to simulate time in tests.
- **`@intentface/latch-core/testing`.** `registerStorageConformance({ describe, it }, name, open)` checks an adapter against the guarantees the runtime relies on: tenant scoping, message ordering and upserts, one active run per chat, racing claims and reclaims, heartbeats, the reaper, and fenced message writes. Runner-agnostic (Vitest, Jest, `node:test`). The drizzle SQLite and Postgres adapters now run it in CI.

**Upgrading:** nothing to do with the drizzle adapters. A host with its own `StorageAdapter` should honour `fence` in `appendMessages` (check the run's `leaseOwner` and `fencingToken` atomically with the write, return `false` when refused) and use one shared clock for lease times; an adapter that ignores `fence` keeps working as before. `reapExpiredRuns` may now be called without `now`. Run the conformance suite to check.
