import { createClient } from "@libsql/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { simulateReadableStream, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, type AppMessage, type StorageAdapter } from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as schemaPg from "./schema.pg.js";

/**
 * The usage ledger records what was spent; deletion doesn't rewrite it.
 * Deleting a chat keeps its usage. Purging a person re-files theirs one level
 * up (or keeps it, or moves it where the host says), with the run id cleared.
 * Purging a tenant needs an explicit choice. And a failed answer's spend is in
 * the ledger like any other's.
 */

type P = { tenantId: string; userId?: string };
const owner = (p: P) => (p.userId ? [p.tenantId, p.userId] : [p.tenantId]);
const u7: P = { tenantId: "t1", userId: "u7" };

type Target = { store: StorageAdapter<P>; usage: () => Promise<{ owner: string; runId: string; cost: number }[]> };

const targets: [string, () => Promise<Target>][] = [
  [
    "SQLite",
    async () => {
      const client = createClient({ url: ":memory:" });
      await migrate(client);
      const db = drizzle(client, { schema });
      return { store: createSqliteAdapter<P>(db, { owner }), usage: () => db.select({ owner: schema.usage.owner, runId: schema.usage.runId, cost: schema.usage.cost }).from(schema.usage) };
    },
  ],
  [
    "Postgres",
    async () => {
      const db = drizzlePg(new PGlite(), { schema: schemaPg });
      await migratePostgres(db);
      return { store: createPostgresAdapter<P>(db, { owner }), usage: () => db.select({ owner: schemaPg.usage.owner, runId: schemaPg.usage.runId, cost: schemaPg.usage.cost }).from(schemaPg.usage) };
    },
  ],
];

/** A chat with one finished run that cost `cost`. */
async function spent(store: StorageAdapter<P>, p: P, cost: number) {
  const chat = await store.createChat(p, { agent: "a" });
  const run = await store.createRun(p, { chatId: chat.id, agent: "a" });
  await store.updateRun(run.id, { status: "completed" });
  await store.recordUsage(p, { runId: run.id, model: "m", inputTokens: 1, outputTokens: 1, cost });
  return { chat, run };
}

const bare = (createRuntimeFor: StorageAdapter<P>) => createRuntime<P>({ storage: createRuntimeFor, agents: {} });

describe.each(targets)("usage on deletion (%s)", (_name, open) => {
  it("deleting a chat keeps what it cost", async () => {
    const { store, usage } = await open();
    const { chat, run } = await spent(store, u7, 0.5);
    await bare(store).deleteChat({ principal: u7, chatId: chat.id });
    expect(await store.getChat(u7, chat.id)).toBeNull();
    expect(await usage()).toEqual([{ owner: "t1/u7", runId: run.id, cost: 0.5 }]);
  });

  it("purging a person re-files their usage one level up, unlinked from their runs", async () => {
    const { store, usage } = await open();
    await spent(store, u7, 0.5);
    await spent(store, { tenantId: "t1", userId: "u8" }, 0.25);
    const { removed } = await bare(store).purgeOwner(["t1", "u7"]);
    expect(removed.storage).toMatchObject({ chats: 1, usageRefiled: 1, usage: 0 });
    const rows = (await usage()).sort((a, b) => a.cost - b.cost);
    expect(rows[0]!.owner).toBe("t1/u8"); // someone else's: untouched
    expect(rows[1]).toEqual({ owner: "t1", runId: "erased", cost: 0.5 });
  });

  it("keeps it, or moves it where the host says, when asked", async () => {
    const kept = await open();
    await spent(kept.store, u7, 0.5);
    await bare(kept.store).purgeOwner(["t1", "u7"], { usage: "keep" });
    expect((await kept.usage()).map((r) => r.owner)).toEqual(["t1/u7"]);

    const moved = await open();
    await spent(moved.store, u7, 0.5);
    await bare(moved.store).purgeOwner(["t1", "u7"], { refileTo: ["billing", "t1"] });
    expect((await moved.usage()).map((r) => r.owner)).toEqual(["billing/t1"]);
  });

  it("purging a tenant needs a usage choice, and refuses before deleting anything", async () => {
    const { store, usage } = await open();
    const { chat } = await spent(store, u7, 0.5);
    await expect(bare(store).purgeOwner(["t1"])).rejects.toThrow(/nowhere to re-file usage/);
    await expect(bare(store).purgeOwner(["t1", "u7"], { refileTo: ["t1", "u7", "x"] })).rejects.toThrow(/inside the path/);
    expect(await store.getChat(u7, chat.id)).not.toBeNull();
    await bare(store).purgeOwner(["t1"], { usage: "delete" });
    expect(await usage()).toEqual([]);
  });
});

describe("a failed answer's spend", () => {
  it("is in the usage ledger and on its run", async () => {
    const { store, usage } = await targets[0]![1]();
    const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } });
    let n = 0;
    // Step 1 calls a tool and is paid for; step 2 fails mid-stream.
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: (async () =>
        n++ === 0
          ? {
              stream: simulateReadableStream({
                initialDelayInMs: 0,
                chunkDelayInMs: 0,
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
                  finish("tool-calls"),
                ],
              }),
            }
          : { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: [{ type: "stream-start", warnings: [] }, { type: "error", error: new Error("provider down") }] }) }) as never,
    });
    const lookup = tool({ description: "Look up", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ ok: true }) });
    const rt = createRuntime<P>({ storage: store, agents: { a: defineAgent<P>({ model, tools: { lookup } }) }, pricing: () => ({ inputPer1M: 1_000_000, outputPer1M: 1_000_000 }) as never });
    const msg: AppMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] };

    await (await rt.handleChat({ agent: "a", chatId: "c1", principal: u7, message: msg })).text();

    const run = (await store.listRuns(u7))[0]!;
    expect(run.status).toBe("errored");
    expect(run.usageInputTokens).toBe(5);
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(run.id);
  });
});
