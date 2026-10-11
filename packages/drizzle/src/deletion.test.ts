import { createClient } from "@libsql/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  defineAgent,
  isUnsupportedOperationError,
  type AppMessage,
  type StorageAdapter,
} from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as schemaPg from "./schema.pg.js";

/**
 * Deletion by owner path, as a host with tenants uses it: the owner key is
 * `[tenantId, userId]`, or `[tenantId]` for a tenant's shared chats.
 * `purgeOwner(["t1"])` removes a tenant, `purgeOwner(["t1", "u7"])` one
 * person, and ids with `_`, `%` or `/` in them can't widen either.
 */

type P = { tenantId: string; userId?: string };
const owner = (p: P) => (p.userId ? [p.tenantId, p.userId] : [p.tenantId]);

const adapters: [string, () => Promise<StorageAdapter<P>>][] = [
  [
    "SQLite",
    async () => {
      const client = createClient({ url: ":memory:" });
      await migrate(client);
      return createSqliteAdapter<P>(drizzle(client, { schema }), { owner });
    },
  ],
  [
    "Postgres",
    async () => {
      const db = drizzlePg(new PGlite(), { schema: schemaPg });
      await migratePostgres(db);
      return createPostgresAdapter<P>(db, { owner });
    },
  ],
];

const msg = (id: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

async function purgeAll(store: StorageAdapter<P>, segments: string[]) {
  for (let i = 0; i < 20; i++) if ((await store.purgeOwner!(segments, { usage: "delete" })).done) return;
  throw new Error("purge never finished");
}

describe.each(adapters)("purgeOwner by path (%s)", (_name, open) => {
  it("removes a person, leaving the tenant's shared chats and other people", async () => {
    const store = await open();
    const shared = await store.createChat({ tenantId: "t1" }, { agent: "a" });
    const u7 = await store.createChat({ tenantId: "t1", userId: "u7" }, { agent: "a" });
    const u70 = await store.createChat({ tenantId: "t1", userId: "u70" }, { agent: "a" });

    await purgeAll(store, ["t1", "u7"]);

    expect(await store.getChat({ tenantId: "t1", userId: "u7" }, u7.id)).toBeNull();
    expect(await store.getChat({ tenantId: "t1" }, shared.id)).not.toBeNull();
    expect(await store.getChat({ tenantId: "t1", userId: "u70" }, u70.id)).not.toBeNull();
  });

  it("removes a whole tenant, and never a tenant whose id only starts the same", async () => {
    const store = await open();
    const shared = await store.createChat({ tenantId: "t1" }, { agent: "a" });
    const person = await store.createChat({ tenantId: "t1", userId: "u7" }, { agent: "a" });
    await store.appendMessages(person.id, [msg("m1")]);
    const t10 = await store.createChat({ tenantId: "t10" }, { agent: "a" });

    await purgeAll(store, ["t1"]);

    expect(await store.getChat({ tenantId: "t1" }, shared.id)).toBeNull();
    expect(await store.getChat({ tenantId: "t1", userId: "u7" }, person.id)).toBeNull();
    expect(await store.getChat({ tenantId: "t10" }, t10.id)).not.toBeNull();
  });

  it("treats _ and % in ids as plain characters, not wildcards", async () => {
    const store = await open();
    const underscore = await store.createChat({ tenantId: "t_" }, { agent: "a" });
    const letter = await store.createChat({ tenantId: "tx" }, { agent: "a" });
    const percent = await store.createChat({ tenantId: "a%" }, { agent: "a" });
    const other = await store.createChat({ tenantId: "ab" }, { agent: "a" });

    await purgeAll(store, ["t_"]);
    await purgeAll(store, ["a%"]);

    expect(await store.getChat({ tenantId: "t_" }, underscore.id)).toBeNull();
    expect(await store.getChat({ tenantId: "a%" }, percent.id)).toBeNull();
    expect(await store.getChat({ tenantId: "tx" }, letter.id)).not.toBeNull();
    expect(await store.getChat({ tenantId: "ab" }, other.id)).not.toBeNull();
  });
});

describe("runtime.deleteChat", () => {
  const plain = new MockLanguageModelV4({ modelId: "mock" });

  it("takes the subagent threads the chat spawned with it, and nothing else", async () => {
    const store = await adapters[0]![1]();
    const rt = createRuntime<P>({ storage: store, agents: { a: defineAgent<P>({ model: plain }) } });
    const me: P = { tenantId: "t1", userId: "u7" };
    const parent = await store.createChat(me, { agent: "a" });
    const sub = await store.createChat(me, { agent: "a", kind: "internal" });
    const subOfSub = await store.createChat(me, { agent: "a", kind: "internal" });
    const otherConversation = await store.createChat(me, { agent: "a" });
    const someoneElses = await store.createChat({ tenantId: "t2", userId: "u1" }, { agent: "a", kind: "internal" });
    await store.appendMessages(parent.id, [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-spawn_agent", toolCallId: "c1", state: "output-available", input: {}, output: { threadId: sub.id, answer: "done" } },
          { type: "data-subagent-progress", id: "p1", data: { agent: "a", threadId: otherConversation.id, messages: [] } },
          { type: "data-subagent-approval", id: "s1", data: { subChatId: someoneElses.id } },
        ],
      } as unknown as AppMessage,
    ]);
    await store.appendMessages(sub.id, [
      { id: "a2", role: "assistant", parts: [{ type: "tool-spawn_agent", toolCallId: "c2", state: "output-available", input: {}, output: { threadId: subOfSub.id } }] } as unknown as AppMessage,
    ]);

    const { deleted } = await rt.deleteChat({ principal: me, chatId: parent.id });

    expect(deleted.sort()).toEqual([parent.id, sub.id, subOfSub.id].sort());
    expect(await store.getChat(me, otherConversation.id)).not.toBeNull(); // a user chat, not a sub-thread
    expect(await store.getChat({ tenantId: "t2", userId: "u1" }, someoneElses.id)).not.toBeNull();
    expect((await rt.deleteChat({ principal: { tenantId: "t9", userId: "x" }, chatId: otherConversation.id })).deleted).toEqual([]);
  });
});

describe("runtime.purgeOwner", () => {
  it("refuses before deleting anything when a store can't purge", async () => {
    const store = await adapters[0]![1]();
    const rt = createRuntime<P>({ storage: store, agents: {} });
    const chat = await store.createChat({ tenantId: "t1" }, { agent: "a" });

    const refused = await rt.purgeOwner(["t1"], { also: { channels: {} }, usage: "delete" }).catch((e: unknown) => e);

    expect(isUnsupportedOperationError(refused)).toBe(true);
    expect(String((refused as Error).message)).toContain("channels");
    expect(await store.getChat({ tenantId: "t1" }, chat.id)).not.toBeNull();
  });

  it("runs every store until done and reports what each removed", async () => {
    const store = await adapters[0]![1]();
    const rt = createRuntime<P>({ storage: store, agents: {} });
    for (let i = 0; i < 5; i++) await store.createChat({ tenantId: "t1", userId: `u${i}` }, { agent: "a" });
    const purged: string[][] = [];
    const channels = {
      purgeOwner: async (segments: string[]) => {
        purged.push(segments);
        return { removed: { bindings: 2 }, done: true };
      },
    };

    const { removed } = await rt.purgeOwner(["t1"], { also: { channels }, batchSize: 2, usage: "delete" });

    expect(removed.storage!.chats).toBe(5);
    expect(removed.channels).toEqual({ bindings: 2 });
    expect(purged).toEqual([["t1"]]);
  });

  it("stops with an error when a store says it's not done but removes nothing", async () => {
    const store = await adapters[0]![1]();
    const rt = createRuntime<P>({ storage: store, agents: {} });
    const stuck = { purgeOwner: async () => ({ removed: { rows: 0 }, done: false }) };
    await expect(rt.purgeOwner(["t1"], { also: { stuck }, usage: "delete" })).rejects.toThrow(/stuck store reported more to do but removed nothing/);
  });
});
