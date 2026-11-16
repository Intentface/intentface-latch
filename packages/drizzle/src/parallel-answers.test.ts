import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext, type AppMessage, type StorageAdapter } from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

/**
 * One step asks several questions, and the answers arrive together. No run
 * guards an answer that waits for the others, so each request used to save its
 * own copy of the message: the later save dropped the earlier answer, every
 * request answered an empty 200, and the turn never resumed.
 */

type P = { orgId: string; userId: string };
const me: P = { orgId: "o1", userId: "u1" };
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

/** First call: `count` questions in one step. Then text. */
function asking(count: number) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const chunks: unknown[] =
        n++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              ...Array.from({ length: count }, (_, i) => ({ type: "tool-call", toolCallId: `q${i + 1}`, toolName: "askUser", input: "{}" })),
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
    }) as never,
  });
}

type Part = { type: string; state?: string; output?: unknown; toolCallId?: string };

const stores: Record<string, () => Promise<StorageAdapter<P>>> = {
  SQLite: async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    return createSqliteAdapter<P>(drizzle(client, { schema }), { owner: (p) => [p.orgId, p.userId] });
  },
  Postgres: async () => {
    const db = drizzlePg(new PGlite(), { schema: pgSchema });
    await migratePostgres(db);
    return createPostgresAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] });
  },
};

async function paused(store: string, count: number) {
  const storage = await stores[store]!();
  const runtime = createRuntime<P>({
    storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      a: defineAgent<P>({
        model: asking(count),
        instructions: "Be brief.",
        tools: { askUser: tool({ description: "Ask the user.", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }) }) },
      }),
    },
  });
  const message = { id: "u1", role: "user", parts: [{ type: "text", text: "go" }], metadata: { visibility: "user" } } as AppMessage;
  await (await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message })).text();
  const answers = async () =>
    (await storage.loadMessages(me, "c1")).flatMap((m) =>
      (m.parts as Part[]).filter((p) => p.type === "tool-askUser").map((p) => [p.toolCallId, p.state, p.output]),
    );
  const answer = (toolCallId: string, output: string) => runtime.applyToolResult({ chatId: "c1", principal: me, toolCallId, output });
  /** What each response was: the resumed turn's text, or "" for an answer that waits. */
  const settle = async (sent: Promise<Response>[]) => {
    const texts: string[] = [];
    for (const res of await Promise.all(sent)) {
      expect(res.status).toBe(200);
      texts.push(res.body ? ((await res.text()).includes('"delta":"done"') ? "done" : "other") : "");
    }
    return texts.sort();
  };
  return { storage, runtime, answers, answer, settle };
}

describe.each(Object.keys(stores))("several questions asked in one step (%s)", (store) => {
  it("keeps both answers and resumes once when they arrive together", async () => {
    const t = await paused(store, 2);
    expect(await t.settle([t.answer("q1", "a"), t.answer("q2", "b")])).toEqual(["", "done"]);
    expect(await t.answers()).toEqual([
      ["q1", "output-available", "a"],
      ["q2", "output-available", "b"],
    ]);
    expect((await t.runtime.listRuns({ principal: me })).map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("does the same for five at once", async () => {
    const t = await paused(store, 5);
    const texts = await t.settle(["q1", "q2", "q3", "q4", "q5"].map((id) => t.answer(id, id.toUpperCase())));
    expect(texts).toEqual(["", "", "", "", "done"]);
    expect(await t.answers()).toEqual(["q1", "q2", "q3", "q4", "q5"].map((id) => [id, "output-available", id.toUpperCase()]));
  });

  it("still waits for the rest when they arrive one by one", async () => {
    const t = await paused(store, 2);
    expect(await t.settle([t.answer("q1", "a")])).toEqual([""]);
    expect(await t.answers()).toEqual([
      ["q1", "output-available", "a"],
      ["q2", "input-available", undefined],
    ]);
    expect(await t.settle([t.answer("q2", "b")])).toEqual(["done"]);
  });
});

describe.each(Object.keys(stores))("replaceMessage (%s)", (store) => {
  it("writes only onto the message as it was read", async () => {
    const t = await paused(store, 2);
    const read = (await t.storage.loadMessages(me, "c1")).at(-1)!;
    const mine = { ...read, parts: [...read.parts, { type: "text", text: "mine" }] } as AppMessage;
    const theirs = { ...read, parts: [...read.parts, { type: "text", text: "theirs" }] } as AppMessage;
    expect(await t.storage.replaceMessage!("c1", read, theirs)).toBe(true);
    // Read before that write: refused, and nothing changes.
    expect(await t.storage.replaceMessage!("c1", read, mine)).toBe(false);
    expect((await t.storage.loadMessages(me, "c1")).at(-1)!.parts.at(-1)).toEqual({ type: "text", text: "theirs" });
    expect(await t.storage.replaceMessage!("c1", theirs, mine)).toBe(true);
    expect(await t.storage.replaceMessage!("c1", { ...read, id: "nope" } as AppMessage, mine)).toBe(false);
  });
});
