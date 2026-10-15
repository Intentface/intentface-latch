import { createClient } from "@libsql/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { createVault, type SecretStore } from "@intentface/latch-core";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as schemaPg from "./schema.pg.js";
import { createSqliteSecretStore } from "./secret-store.js";
import { createPostgresSecretStore } from "./secret-store.pg.js";

/** Master key rotation over the shipped secret stores, with a tenant/user owner key. */

type P = { tenantId: string; userId: string };
const owner = (p: P) => [p.tenantId, p.userId];

const stores: [string, () => Promise<SecretStore<P>>][] = [
  [
    "SQLite",
    async () => {
      const client = createClient({ url: ":memory:" });
      await migrate(client);
      return createSqliteSecretStore<P>(drizzle(client, { schema }), { owner });
    },
  ],
  [
    "Postgres",
    async () => {
      const db = drizzlePg(new PGlite(), { schema: schemaPg });
      await migratePostgres(db);
      return createPostgresSecretStore<P>(db, { owner });
    },
  ],
];

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe.each(stores)("vault key rotation (%s)", (_name, open) => {
  it("re-wraps every secret onto the new key, in pages, and binds it to its owner", async () => {
    const store = await open();
    const k1 = { id: "k1", key: newKey() };
    const k2 = { id: "k2", key: newKey() };
    const people: P[] = [
      { tenantId: "t1", userId: "u1" },
      { tenantId: "t1", userId: "u2" },
      { tenantId: "t2", userId: "u1" },
    ];
    const v1 = createVault({ store, masterKey: k1 });
    for (const p of people) {
      await v1.set(p, "github", `gh-${p.tenantId}-${p.userId}`);
      await v1.set(p, "linear", `ln-${p.tenantId}-${p.userId}`);
    }

    const v2 = createVault({ store, masterKey: k2, previousKeys: [k1] });
    expect(await v2.rotate({ batchSize: 4 })).toEqual({ checked: 6, rewrapped: 6, remaining: 0, errors: [] });
    expect(await v2.rotate()).toMatchObject({ checked: 6, rewrapped: 0 });

    const k2Only = createVault({ store, masterKey: k2 });
    for (const p of people) expect(await k2Only.get(p, "linear")).toBe(`ln-${p.tenantId}-${p.userId}`);

    // A row copied into another person's place doesn't open there.
    const record = (await store.get(people[0]!, "github"))!;
    await store.put(people[1]!, record);
    await expect(k2Only.get(people[1]!, "github")).rejects.toThrow(/moved or altered/);
  });

  it("only replaces a wrap that's still the one it read", async () => {
    const store = await open();
    const me: P = { tenantId: "t1", userId: "u1" };
    const vault = createVault({ store, masterKey: newKey() });
    await vault.set(me, "token", "first");
    const [stale] = (await store.scan!({ limit: 10 })).records;
    await vault.set(me, "token", "second");

    expect(await store.replaceWrap!(stale!.owner, "token", stale!, stale!.wrappedDek)).toBe(false);
    expect(await vault.get(me, "token")).toBe("second");
  });
});
