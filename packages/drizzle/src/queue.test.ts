import { createClient } from "@libsql/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext, type AppMessage, type StorageAdapter } from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as schemaPg from "./schema.pg.js";

/**
 * The input queue through the real adapters: a message and a signal that
 * arrive while an answer is running are held in `latch_queued_inputs`, and
 * the answer that ends starts one turn with both, as the principal that sent
 * the message (read back from the row).
 */

type P = { orgId: string; userId: string };
const me: P = { orgId: "o1", userId: "u1" };
const owner = (p: P) => [p.orgId, p.userId];

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

const user = (text: string, id: string): AppMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }], metadata: { visibility: "user" } }) as AppMessage;

function answering(answers: string[]) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t0" },
          { type: "text-delta", id: "t0", delta: answers[Math.min(n++, answers.length - 1)]! },
          { type: "text-end", id: "t0" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } },
        ],
      }),
    })) as never,
  });
}

describe.each(adapters)("the input queue with crash recovery on (%s)", (_name, open) => {
  const runtimeOn = (storage: StorageAdapter<P>, model: MockLanguageModelV4) =>
    createRuntime<P>({
      storage,
      durability: { enabled: true, heartbeatMs: 5, leaseTtlMs: 60_000 },
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { a: defineAgent<P>({ model, instructions: "Be brief." }) },
    });

  it("answers what is held as a leased run of its own", async () => {
    const storage = await open();
    const model = answering(["a1", "a2"]);
    const runtime = runtimeOn(storage, model);
    const live = await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q1", "u1") });
    expect((await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q2", "u2"), ifBusy: "queue" })).status).toBe(202);
    await live.text();

    expect((await storage.loadMessages(me, "c1")).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const runs = await storage.listRuns(me, { chatId: "c1" });
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    // Each was a leased run of its own.
    expect(runs.every((r) => r.fencingToken === 1)).toBe(true);
    expect(new Set(runs.map((r) => r.id)).size).toBe(2);
  });

  it("starts the turn from the cron tick when the process that held the input is gone", async () => {
    const storage = await open();
    const model = answering(["a1", "a2"]);
    const first = runtimeOn(storage, model);
    await (await first.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q1", "u1") })).text();
    // Held by a process that died before it could start the turn.
    await storage.enqueueInput!(me, "c1", user("q2", "u2"), { cap: 20 });

    // Another server's tick, later.
    const second = runtimeOn(storage, model);
    const tick = await second.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    expect(tick.errors).toEqual([]);
    expect((await storage.loadMessages(me, "c1")).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(await storage.listQueuedInputs!(me, "c1")).toEqual([]);
  });
});

describe.each(adapters)("the input queue (%s)", (_name, open) => {
  it("holds what arrives mid-answer and answers it in one turn when that answer ends", async () => {
    const storage = await open();
    const model = answering(["a1", "a2"]);
    const seen: P[] = [];
    const runtime = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({
        build: async ({ principal }) => {
          seen.push(principal);
          return {};
        },
      }),
      agents: { a: defineAgent<P>({ model, instructions: "Be brief." }) },
    });

    const live = await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q1", "u1") });
    const held = await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q2", "u2"), ifBusy: "queue" });
    expect(held.status).toBe(202);
    expect(await runtime.sendSignal({ chatId: "c1", principal: me, text: "The export is ready.", id: "s1" })).toEqual({ id: "s1", queued: true });

    const during = (await runtime.pollChat({ chatId: "c1", principal: me }))!;
    expect(during.running).toBe(true);
    expect(during.queued.map((m) => m.id)).toEqual(["u2"]);
    expect((await storage.loadMessages(me, "c1")).map((m) => m.id)).toEqual(["u1"]);

    await live.text();
    const messages = await storage.loadMessages(me, "c1");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user", "assistant"]);
    expect(messages.slice(2, 4).map((m) => m.id)).toEqual(["s1", "u2"]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(await storage.listQueuedInputs!(me, "c1")).toEqual([]);
    // The held turn ran as the principal stored with the message.
    expect(seen.at(-1)).toEqual(me);

    const after = (await runtime.pollChat({ chatId: "c1", principal: me, cursor: during.cursor }))!;
    expect(after.running).toBe(false);
    expect(after.messages!.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((await runtime.pollChat({ chatId: "c1", principal: me, cursor: after.cursor }))!.messages).toBeUndefined();
  });
});

describe("held inputs left behind by an interrupted purge", () => {
  const cases: [string, () => Promise<{ storage: StorageAdapter<P>; dropChats: () => Promise<unknown>; rows: () => Promise<unknown[]> }>][] = [
    [
      "SQLite",
      async () => {
        const client = createClient({ url: ":memory:" });
        await migrate(client);
        const db = drizzle(client, { schema });
        return {
          storage: createSqliteAdapter<P>(db, { owner }),
          dropChats: () => db.delete(schema.chats),
          rows: () => db.select().from(schema.queuedInputs),
        };
      },
    ],
    [
      "Postgres",
      async () => {
        const db = drizzlePg(new PGlite(), { schema: schemaPg });
        await migratePostgres(db);
        return {
          storage: createPostgresAdapter<P>(db, { owner }),
          dropChats: () => db.delete(schemaPg.chats),
          rows: () => db.select().from(schemaPg.queuedInputs),
        };
      },
    ],
  ];

  it.each(cases)("are removed by the next pass (%s)", async (_name, open) => {
    const { storage, dropChats, rows } = await open();
    const runtime = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { a: defineAgent<P>({ model: answering(["a1"]), instructions: "Be brief." }) },
    });
    await (await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("q1", "u1") })).text();
    expect(await storage.enqueueInput!(me, "c1", user("q2", "u2"), { cap: 20 })).toBe(true);
    // A purge that stopped right after deleting the chats, with an input held meanwhile.
    await dropChats();
    expect(await rows()).toHaveLength(1);

    await storage.purgeOwner!(owner(me));
    expect(await rows()).toEqual([]);
  });
});
