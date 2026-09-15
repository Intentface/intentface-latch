/**
 * The durable tally. Without it, `costTracking` only measures one run, so a
 * limit resets on every turn and a conversation can spend it repeatedly.
 *
 * The trap this guards is double counting: `onSpend` fires after each step AND
 * once at the end, every time with the run's cumulative figure. Adding the
 * report each time counts the last step twice.
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
import {
  migrate,
  periodKey,
  readSpend,
  sqlitePersistence,
  sqliteSpend,
  type SqliteDatabase,
} from "./sqlite.js";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const pricing: Record<string, ModelPrice> = { "test-model": { input: 3, output: 15 } };
/** 1000 in + 500 out at 3/M and 15/M. */
const PER_STEP = (1000 * 3 + 500 * 15) / 1e6; // 0.0105

/** A turn with a big cache hit: 1000 input of which 800 was read from cache. */
const cachedAnswer = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "test-model", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1000, noCache: 150, cacheRead: 800, cacheWrite: 50 },
            outputTokens: { total: 500, text: 500, reasoning: 0 },
          },
        },
      ] as never),
    }),
  });

const answers = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "test-model", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(1000, 500) },
      ] as never),
    }),
  });

/** Keeps calling a tool, so the loop runs until something stops it. */
const loops = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "n", modelId: "test-model", timestamp: new Date(0) },
        { type: "tool-call", toolCallId: `c${Math.random()}`, toolName: "ping", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(1000, 500) },
      ] as never),
    }),
  });

const tools = { ping: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
const db = () => {
  const d = new Database(":memory:") as unknown as SqliteDatabase;
  migrate(d);
  return d;
};
const turn = (n: number): UIMessage[] => [
  { id: `u${n}`, role: "user", parts: [{ type: "text", text: "hi" }] },
];

describe("the ledger", () => {
  it("accumulates across turns instead of resetting", async () => {
    const d = db();
    for (const n of [1, 2, 3])
      await convertReadableStreamToArray(
        await runAgentLoop({
          model: answers(),
          tools: {},
          messages: turn(n),
          extensions: [costTracking({ pricing, ...sqliteSpend(d, "chat-1") })],
        }),
      );

    const total = readSpend(d, "chat-1");
    expect(total.steps).toBe(3);
    expect(total.cost).toBeCloseTo(PER_STEP * 3, 9);
    expect(total.inputTokens).toBe(3000);
    expect(total.outputTokens).toBe(1500);
  });

  it("does not double count the final step", async () => {
    const d = db();
    // Four steps in ONE run. `onSpend` fires five times: once per step plus
    // agent_end. Naive addition would bill the fourth step twice.
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: loops(),
        tools,
        messages: turn(1),
        maxSteps: 4,
        extensions: [costTracking({ pricing, ...sqliteSpend(d, "chat-1") })],
      }),
    );
    const total = readSpend(d, "chat-1");
    expect(total.steps).toBe(4);
    expect(total.cost).toBeCloseTo(PER_STEP * 4, 9);
  });

  it("enforces a limit across turns, not just within one", async () => {
    const d = db();
    // Ceiling of two steps' worth. Each turn is one step, so the third is refused.
    const budget = () => costTracking({ pricing, limit: PER_STEP * 2, ...sqliteSpend(d, "chat-1") });

    for (const n of [1, 2, 3, 4])
      await convertReadableStreamToArray(
        await runAgentLoop({ model: answers(), tools: {}, messages: turn(n), extensions: [budget()] }),
      );

    const total = readSpend(d, "chat-1");
    expect(total.steps).toBe(2);
    expect(total.cost).toBeCloseTo(PER_STEP * 2, 9);
  });

  it("persists the cache split, which is what makes the bill small", async () => {
    const d = db();
    const cachePricing: Record<string, ModelPrice> = {
      "test-model": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    };
    for (const n of [1, 2])
      await convertReadableStreamToArray(
        await runAgentLoop({
          model: cachedAnswer(),
          tools: {},
          messages: turn(n),
          extensions: [costTracking({ pricing: cachePricing, ...sqliteSpend(d, "chat-1") })],
        }),
      );

    const total = readSpend(d, "chat-1");
    expect(total.cacheReadTokens).toBe(1600);
    expect(total.cacheWriteTokens).toBe(100);
    expect(total.inputTokens).toBe(2000);

    // 150 fresh at 3/M, 800 cached at 0.3/M, 50 written at 3.75/M, 500 out at 15/M.
    const perTurn = (150 * 3 + 800 * 0.3 + 50 * 3.75 + 500 * 15) / 1e6;
    expect(total.cost).toBeCloseTo(perTurn * 2, 9);
    // Materially cheaper than pricing the whole 1000 as fresh input.
    expect(total.cost).toBeLessThan(((1000 * 3 + 500 * 15) / 1e6) * 2);
  });

  it("keeps separate keys apart", async () => {
    const d = db();
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools: {},
        messages: turn(1),
        extensions: [costTracking({ pricing, ...sqliteSpend(d, "alice") })],
      }),
    );
    expect(readSpend(d, "alice").steps).toBe(1);
    expect(readSpend(d, "bob").steps).toBe(0);
    expect(readSpend(d, "bob").cost).toBe(0);
  });

  it("buckets by period", async () => {
    const d = db();
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools: {},
        messages: turn(1),
        extensions: [costTracking({ pricing, ...sqliteSpend(d, "org", "month") })],
      }),
    );
    expect(readSpend(d, "org", "month").steps).toBe(1);
    // A different bucket for the same key is untouched.
    expect(readSpend(d, "org", "all").steps).toBe(0);
    expect(periodKey("month")).toMatch(/^\d{4}-\d{2}$/);
    expect(periodKey("day")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("an unknown key reads as zero rather than throwing", () => {
    expect(readSpend(db(), "nobody")).toMatchObject({ cost: 0, steps: 0 });
  });

  it("works alongside the persistence extension on the same database", async () => {
    const d = db();
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools: {},
        messages: turn(1),
        extensions: [
          sqlitePersistence(d, "chat-1"),
          costTracking({ pricing, ...sqliteSpend(d, "chat-1") }),
        ],
      }),
    );
    expect(readSpend(d, "chat-1").steps).toBe(1);
    expect(
      (d.prepare(`SELECT messages FROM chats WHERE id = ?`).get("chat-1") as { messages: string }).messages,
    ).toContain("assistant");
  });
});
