/**
 * Budgets at more than one level: an organisation ceiling and a per-user one,
 * enforced together.
 *
 * Nothing new is needed for this. `costTracking` takes a limit and a tally,
 * `sqliteSpend` takes any key, and the principal is on every moment — so two
 * instances with different keys are just two extensions in the array.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { costTracking, type ModelPrice } from "./cost.js";
import { migrate, readSpend, sqliteSpend, type SqliteDatabase } from "./sqlite.js";
import type { Extension } from "./extension.js";

declare module "./extension.js" {
  interface Principal {
    orgId: string;
    userId: string;
  }
}

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 500, text: 500, reasoning: 0 },
};
const pricing: Record<string, ModelPrice> = { "test-model": { input: 3, output: 15 } };
const PER_STEP = (1000 * 3 + 500 * 15) / 1e6; // 0.0105

const answers = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "test-model", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never),
    }),
  });

const db = () => {
  const d = new Database(":memory:") as unknown as SqliteDatabase;
  migrate(d);
  return d;
};
const turn = (n: number): UIMessage[] => [
  { id: `u${n}`, role: "user", parts: [{ type: "text", text: "hi" }] },
];

/** What a host writes: two ceilings, keyed off the same principal. */
const budgets = (d: SqliteDatabase, p: { orgId: string; userId: string }): Extension[] => [
  costTracking({ name: "cost:org", pricing, limit: PER_STEP * 5, ...sqliteSpend(d, p.orgId, "month") }),
  costTracking({ name: "cost:user", pricing, limit: PER_STEP * 2, ...sqliteSpend(d, p.userId, "day") }),
];

const go = async (d: SqliteDatabase, p: { orgId: string; userId: string }, n: number) =>
  convertReadableStreamToArray(
    await runAgentLoop({
      model: answers(),
      tools: {},
      messages: turn(n),
      principal: p,
      extensions: budgets(d, p),
    }),
  );

describe("layered budgets", () => {
  it("the tighter ceiling wins, and both tallies stay accurate", async () => {
    const d = db();
    const alice = { orgId: "org_a", userId: "alice" };

    // Alice's own ceiling is two steps; the org's is five.
    for (const n of [1, 2, 3, 4]) await go(d, alice, n);

    expect(readSpend(d, "alice", "day").steps).toBe(2);
    expect(readSpend(d, "org_a", "month").steps).toBe(2);
  });

  it("a second user still has their own allowance under the org ceiling", async () => {
    const d = db();
    const alice = { orgId: "org_a", userId: "alice" };
    const bob = { orgId: "org_a", userId: "bob" };

    for (const n of [1, 2, 3]) await go(d, alice, n); // alice stops at 2
    for (const n of [4, 5, 6]) await go(d, bob, n); // bob has his own 2

    expect(readSpend(d, "alice", "day").steps).toBe(2);
    expect(readSpend(d, "bob", "day").steps).toBe(2);
    // The org saw four steps and its ceiling is five, so it has not tripped.
    expect(readSpend(d, "org_a", "month").steps).toBe(4);
  });

  it("the org ceiling stops everyone once it is reached", async () => {
    const d = db();
    const users = ["alice", "bob", "carol"].map((userId) => ({ orgId: "org_a", userId }));

    let n = 0;
    for (const u of users) for (const _ of [1, 2, 3]) await go(d, u, ++n);

    // Five steps of org allowance, shared: alice 2, bob 2, carol 1.
    expect(readSpend(d, "org_a", "month").steps).toBe(5);
    expect(readSpend(d, "carol", "day").steps).toBe(1);
  });

  it("a tool still runs under the ceiling and not over it", async () => {
    const d = db();
    const alice = { orgId: "org_a", userId: "alice" };
    let calls = 0;
    const tools = {
      ping: tool({
        inputSchema: z.object({}),
        execute: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    };
    const withTool = async (n: number) =>
      convertReadableStreamToArray(
        await runAgentLoop({
          model: answers(),
          tools,
          messages: turn(n),
          principal: alice,
          extensions: budgets(d, alice),
        }),
      );
    for (const n of [1, 2, 3]) await withTool(n);
    expect(readSpend(d, "alice", "day").steps).toBe(2);
    expect(calls).toBe(0); // this model never calls it; the point is nothing errored
  });
});

describe("naming", () => {
  it("layered budgets report separately", async () => {
    const d = db();
    const alice = { orgId: "org_a", userId: "alice" };
    expect(budgets(d, alice).map((e) => e.name)).toEqual(["cost:org", "cost:user"]);
  });
});
