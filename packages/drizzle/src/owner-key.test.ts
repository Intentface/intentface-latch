import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { createSqliteAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";
import { createSqliteSecretStore } from "./secret-store.js";

/**
 * A principal missing an id the owner key needs is refused, not filed under
 * the string "undefined", where every principal missing it would share a
 * bucket.
 */

type P = { orgId: string; userId?: string };
const owner = (p: P) => [p.orgId, p.userId as string];

async function db() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return drizzle(client, { schema });
}

describe("owner keys", () => {
  it("refuse a missing segment in chat storage", async () => {
    const storage = createSqliteAdapter<P>(await db(), { owner });
    await expect(storage.createChat({ orgId: "o1" }, { agent: "a" })).rejects.toThrow(/empty segment at position 1/);
    await expect(storage.listChats({ orgId: "o1" })).rejects.toThrow(/empty segment/);
  });

  it("refuse an empty segment in the secret store", async () => {
    const store = createSqliteSecretStore<P>(await db(), { owner });
    await expect(store.list({ orgId: "o1", userId: "" })).rejects.toThrow(/empty segment at position 1/);
  });

  it("still keep complete principals apart", async () => {
    const storage = createSqliteAdapter<P>(await db(), { owner });
    const chat = await storage.createChat({ orgId: "o1", userId: "u1" }, { agent: "a" });
    expect(await storage.getChat({ orgId: "o1", userId: "u1" }, chat.id)).not.toBeNull();
    expect(await storage.getChat({ orgId: "o1", userId: "u2" }, chat.id)).toBeNull();
  });
});
