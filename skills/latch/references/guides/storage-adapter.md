<!-- Generated from apps/docs/content/docs/guides/storage-adapter.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Write your own storage adapter

Keep Latch's data in your own schema or another database, and prove it keeps the same guarantees.

Online: https://intentface-latch-docs.vercel.app/docs/guides/storage-adapter

The built-in adapters cover Postgres and SQLite. Write your own when you need Latch's data in a schema you already have, in another database, or behind a layer you control: an audit log, encryption, a cache.

## First: do you need to wrap, or replace?

Most needs are a **wrapper** around a built-in adapter: same tables, one method changed.

```ts
const base = createPostgresAdapter<Principal>(db, { owner });

const storage: StorageAdapter<Principal> = {
  ...base,
  appendMessages: async (chatId, messages, ...rest) => {
    await audit.record(chatId, messages);
    return base.appendMessages(chatId, messages, ...rest); // pass every argument on
  },
};
```

> **Pass every argument on**
>
> A wrapper that drops an argument quietly turns a guarantee off. Leave out the fence, and a server that lost its run can keep writing into the conversation after another server took over; leave out the owner key, and the adapter can no longer check whose chat it's writing to. Forward the rest of the arguments as they are (`...rest` above). The adapter returns `false` when it refuses a write: return that too.

Write one from scratch only for a different database or a different schema.

## Start from the checks

The guarantees an adapter must keep only show up under load: two servers claiming one run, a server waking up after its run was taken over. The conformance checks make them show up in a test, so write the test first and make it pass one check at a time.

```ts title="my-adapter.test.ts"
import { describe, it } from "vitest";
import { registerStorageConformance } from "@intentface/latch-core/testing";

registerStorageConformance({ describe, it }, "my adapter", async () => {
  const db = await openTestDatabase();
  return {
    store: createMyAdapter<Principal>(db, { owner: (p) => [p.orgId] }),
    principals: [{ orgId: "a" }, { orgId: "b" }], // two different owners
    close: () => db.close(),
  };
});
```

It runs under Vitest, Jest or `node:test`. The built-in adapters pass the same checks.

## The guarantees, in the order to build them

1. **Every read is scoped to its owner.** A chat from another owner is not found, not forbidden. Build the owner key with `encodeOwnerKey(owner(principal))` from `@intentface/latch-core`: it escapes each segment and refuses a missing one, so a principal without a `userId` can't land in a bucket shared with every other one.
2. **Messages keep their order** and are replaced by id, never duplicated.
3. **One running answer per chat.** Starting a second fails with the time left on the first.
4. **Claims are atomic.** Of many servers claiming the same run, exactly one wins.
5. **Leases come from the database's clock,** not each server's.
6. **Stale servers are fenced out.** Writes carry the run's fencing number, and a write with an old number is refused.

The [storage reference](https://intentface-latch-docs.vercel.app/docs/reference/storage) has every method and each guarantee in detail, with what breaks when it's missing.

## One schema or database per tenant

If each tenant's data lives in its own schema or database, calls by id are the hard part: `updateRun("run_8f3k")` doesn't say which tenant's schema the run is in. The runtime solves that by handing back the owner key on every such call, so:

1. **Make the tenant the first segment of your owner key**, e.g. `encodeOwnerKey([tenantId, userId])`.
2. **Return the key on every record**: `ChatRecord.owner` and `ScheduleRecord.owner` as usual, and `RunRecord.ownerKey` on every run, reaped and reclaimed ones included.
3. **Route each call by it**: `decodeOwnerKey(scope.ownerKey)[0]` is the tenant. `Runtime.getRun` is the one call that passes `{ principal }` instead; derive the key from it as your other methods do.
4. **Keep a global table for the two sweeps**, `reapExpiredRuns` and `claimDueSchedules`: active leases and due schedules across tenants, each with its owner key.
5. **Run the checks with `checksOwnerKey: true`.**

```ts
registerStorageConformance({ describe, it }, "per-tenant adapter", async () => ({
  store: createTenantAdapter<Principal>(cluster, { owner: (p) => [p.tenantId, p.userId] }),
  principals: [{ tenantId: "t1", userId: "u1" }, { tenantId: "t2", userId: "u2" }],
  checksOwnerKey: true,
}));
```
