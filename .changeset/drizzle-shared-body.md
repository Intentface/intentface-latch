---
"@intentface/latch-drizzle": patch
---

One adapter body, two dialect wrappers. `createSqliteAdapter` and
`createPostgresAdapter` shared ~460 duplicated lines that differed only in the
database type, the schema import, and whether a message batch runs in a
transaction; the same for the two secret stores. Both now delegate to
`adapter.shared.ts` / `secret-store.shared.ts` (the `memory-job-store` pattern),
with the transaction choice as a `withTx` seam: Postgres wraps the batch,
SQLite stays sequential for synchronous drivers. Public names and behaviour are
unchanged.
