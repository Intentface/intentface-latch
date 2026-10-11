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

## Deleting someone's data

When a person asks for their data to be deleted, or a customer leaves, delete it through Latch rather than with SQL behind its back:

```ts
// One conversation, with the subagent threads it spawned.
await runtime.deleteChat({ principal, chatId });

// Everything stored for a person, in every store you pass.
const also = { secrets: secretStore, agents: agentStore, memory: memoryJobStore, channels: myChannelStore };
await runtime.purgeOwner([orgId, userId], { also });

// A customer who has left: say what happens to their usage records.
await runtime.purgeOwner([orgId], { also, usage: "delete" });
```

`purgeOwner` works by owner path: `[orgId]` covers the organization's shared chats and every person in it, `[orgId, userId]` just that person. The storage adapter removes chats, messages, runs and schedules; the stores in `also` remove what they keep (the shipped secret, agent and memory job stores all can, including the drafts a person is writing in the organization's agents). It works in batches, so a large organization can't time out, and anything an answer is still writing is stopped first, so nothing comes back. If any store can't purge, it refuses before deleting anything, rather than leaving the owner half deleted.

**Usage records stay, unless you say otherwise.** The usage ledger (model, tokens and cost per answer, no content) is what you bill from, so deleting doesn't rewrite it:

- `deleteChat` keeps the chat's usage. Deleting a conversation doesn't make it cost less, and it doesn't give anyone more of their limits either: those count in a separate store.
- `purgeOwner([orgId, userId])` re-files the person's usage under `[orgId]` and clears its link to their runs, so the organization's totals stay right while nothing points at the person. That's pseudonymous rather than anonymous (a one-person organization can still be told apart), which is what keeping billing records usually means. Pass `usage: "keep"` to leave it as it is, `"delete"` to remove it, or `refileTo` to move it somewhere else.
- `purgeOwner([orgId])` has nothing above it to re-file to, so it asks you to choose: `usage: "delete"` or `"keep"`.

Two things stay yours: memories themselves live in your memory store, and usage-limit counters are keyed by the names you chose (they may contain the person's id, like `user:org1:u7`; clear those for a complete erasure). The handler also exposes `DELETE chats/:id` for the chat list's delete button.

## Go deeper

- What an adapter must guarantee: [Storage reference](https://intentface-latch-docs.vercel.app/docs/reference/storage)
- Why those guarantees matter: [Running on many servers](https://intentface-latch-docs.vercel.app/docs/hard-parts/durability)
