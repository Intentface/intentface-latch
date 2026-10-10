<!-- Generated from apps/docs/content/docs/concepts/storage.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Storage

Where conversations, runs, usage and schedules live, in your own database, through an adapter.

Online: https://intentface-latch-docs.vercel.app/docs/concepts/storage

**Storage is where Latch keeps everything: conversations, runs, usage and schedules.** It lives in your own database, through an adapter.

## Why it exists

Saving messages is the easy part. The hard part is the rules storage has to enforce, because it's the only place every server sees: one answer at a time per chat, exactly one server taking over a crashed run, a stale server's writes refused, each customer seeing only their own rows. An adapter keeps those guarantees in the database itself, so they hold however many servers you run.

## The smallest version

```ts
import { createPostgresAdapter, migratePostgres } from "@intentface/latch-drizzle";

await migratePostgres(db); // creates the latch_* tables
const storage = createPostgresAdapter<Principal>(db, { owner: (p) => [p.orgId, p.userId] });
```

`createSqliteAdapter` does the same for SQLite and Turso. `owner` decides whose conversation is whose: `[orgId, userId]` for private chats, `[orgId]` for chats the whole team shares.

## Your own database

You can write your own adapter for another database or your own schema. `@intentface/latch-core/testing` ships the checks the built-in adapters pass, so you can prove yours keeps the same guarantees:

```ts
import { registerStorageConformance } from "@intentface/latch-core/testing";

registerStorageConformance({ describe, it }, "my adapter", async () => ({
  store: createMyAdapter(db),
  principals: [{ orgId: "a" }, { orgId: "b" }],
}));
```

## Go deeper

- What an adapter must guarantee: [Storage reference](https://intentface-latch-docs.vercel.app/docs/reference/storage)
- Why those guarantees matter: [Running on many servers](https://intentface-latch-docs.vercel.app/docs/hard-parts/durability)
