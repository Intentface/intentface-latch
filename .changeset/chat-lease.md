---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
"@intentface/latch-channels": minor
---

One active run per chat, enforced in storage. `createRun` / `claimRun` throw
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
