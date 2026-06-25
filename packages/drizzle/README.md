# @intentface/latch-drizzle

The persistence tier for Latch — a `StorageAdapter` and `SecretStore` implemented on **Drizzle** (libsql/SQLite first-class, Postgres alongside).

## What it does

- **`createSqliteAdapter` / (pg variant)** — the `StorageAdapter` the runtime persists through: chats, messages (the `AppMessage` source of truth), runs (status, leases, usage, cost incl. cached-token split), usage ledger, and schedules. Owner-keyed for org/user isolation (the `owner` fn derives the key from your `Principal`).
- **`createSqliteSecretStore`** — the encrypted record store behind the core `Vault` (it never sees plaintext; the Vault wraps/unwraps).
- **`migrate(client)`** — creates the `latch_*` tables (`CREATE TABLE IF NOT EXISTS`) plus idempotent `ALTER`s for columns added later (timezone, cached-token counts, …). Safe to run at startup; no migration tooling required.

Tables: `latch_chats`, `latch_messages`, `latch_runs`, `latch_usage`, `latch_secrets`, `latch_schedules`.

## Usage

```ts
import { createClient } from "@libsql/client";
import { createSqliteAdapter, createSqliteSecretStore, migrate } from "@intentface/latch-drizzle";

const client = createClient({ url: DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
await migrate(client);

const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);
const storage = createSqliteAdapter<Principal>(client, { owner });
```

## Where it fits

The T1 (persistence) tier under `@intentface/latch-core`. Swap it for another `StorageAdapter` implementation behind the same contract.
