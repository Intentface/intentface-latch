import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "@intentface/latch-drizzle";
import {
  createCachingStats,
  lintAgentCaching,
  minCacheablePrefixTokens,
  type AgentCachingStats,
} from "./caching-stats";

const base: AgentCachingStats = {
  agent: "a",
  runs: 20,
  chats: 10,
  inputTokens: 100_000,
  outputTokens: 5_000,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 10_000,
  hitRate: 0.8,
  costUsd: 1,
  estWasteUsd: 0,
  medianGapMs: 30_000,
  p90GapMs: 60_000,
  distinctToolsets: 1,
  singleRunChatShare: 0.2,
  suggestions: [],
};
const agent = {
  name: "a",
  modelId: "claude-sonnet-4-6",
  instructions: "You are a careful assistant. ".repeat(200),
  memoryEnabled: false,
};
const rules = (s: Partial<AgentCachingStats>, a?: Partial<typeof agent> | null) =>
  lintAgentCaching(
    { ...base, ...s },
    a === null ? undefined : { ...agent, ...a },
  ).map((x) => x.rule);

describe("lintAgentCaching", () => {
  it("stays quiet on a healthy agent", () => {
    expect(rules({})).toEqual([]);
  });

  it("R1 flags dynamic-looking instructions", () => {
    expect(rules({}, { instructions: agent.instructions + " As of 2026-08-14, prices are..." })).toContain("R1");
    expect(rules({}, { instructions: agent.instructions + " Hello ${name}!" })).toContain("R1");
  });

  it("R2 flags turn gaps beyond the TTL", () => {
    expect(rules({ medianGapMs: 20 * 60_000 })).toContain("R2");
  });

  it("R3 flags low hit rate with fast turns; not with slow turns or few runs", () => {
    expect(rules({ hitRate: 0.1 })).toContain("R3");
    expect(rules({ hitRate: 0.1, medianGapMs: 20 * 60_000 })).not.toContain("R3");
    expect(rules({ hitRate: 0.1, runs: 3 })).not.toContain("R3");
  });

  it("R4 flags toolset churn", () => {
    expect(rules({ distinctToolsets: 3 })).toContain("R4");
  });

  it("R5 flags writes that never get read", () => {
    expect(rules({ cacheReadTokens: 1_000, cacheWriteTokens: 10_000 })).toContain("R5");
    expect(rules({ cacheWriteTokens: 0, cacheReadTokens: 0 })).not.toContain("R5");
  });

  it("R6 flags a prefix under the model minimum", () => {
    expect(rules({}, { instructions: "Be brief." })).toContain("R6");
    expect(rules({})).not.toContain("R6");
  });

  it("R7 flags mostly single-run chats", () => {
    expect(rules({ singleRunChatShare: 0.9 })).toContain("R7");
    expect(rules({ singleRunChatShare: 0.9, chats: 3 })).not.toContain("R7");
  });

  it("R8 points at memory rewrites when the toolset is stable but hits are low", () => {
    const r = rules({ hitRate: 0.1 }, { memoryEnabled: true });
    expect(r).toContain("R8");
    expect(rules({ hitRate: 0.1, distinctToolsets: 2 }, { memoryEnabled: true })).not.toContain("R8");
  });

  it("config rules are skipped without an agent record", () => {
    expect(rules({ hitRate: 0.1 }, null)).toEqual(["R3"]);
  });
});

describe("statsFor", () => {
  it("aggregates per agent, dedupes duplicate usage rows, and excludes non-turn traffic", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const now = Date.now();
    const owner = "org/u1";
    const exec = (sql: string, args: (string | number | null)[]) => client.execute({ sql, args });

    await exec(`INSERT INTO latch_chats (id, owner, agent, kind, created_at, updated_at) VALUES
      ('c1', ?, 'a', 'user', ?, ?), ('c2', ?, 'a', 'internal', ?, ?), ('c3', 'other', 'a', 'user', ?, ?)`,
      [owner, now, now, owner, now, now, now, now]);

    const run = (
      id: string, chat: string, kind: string | null, status: string,
      startedAt: number, endedAt: number, input: number, read: number, write: number, hash: string | null,
    ) =>
      exec(`INSERT INTO latch_runs (id, chat_id, agent, status, kind, started_at, ended_at,
              usage_input_tokens, usage_output_tokens, usage_cache_read_tokens, usage_cache_write_tokens,
              cost_total, tools_hash)
            VALUES (?, ?, 'a', ?, ?, ?, ?, ?, 10, ?, ?, 0.01, ?)`,
        [id, chat, status, kind, startedAt, endedAt, input, read, write, hash]);

    const t0 = now - 3_600_000;
    await run("r1", "c1", "turn", "completed", t0, t0 + 1_000, 1000, 0, 500, "h1");
    await run("r2", "c1", "turn", "completed", t0 + 61_000, t0 + 62_000, 1000, 800, 0, "h1");
    await run("r3", "c1", "compaction", "completed", t0 + 70_000, t0 + 71_000, 9999, 0, 0, null); // excluded: kind
    await run("r4", "c1", "turn", "errored", t0 + 80_000, t0 + 81_000, 9999, 0, 0, null); // excluded: status
    await run("r5", "c2", "turn", "completed", t0, t0 + 1_000, 9999, 0, 0, null); // excluded: internal chat
    await run("r6", "c3", "turn", "completed", t0, t0 + 1_000, 9999, 0, 0, null); // excluded: other owner

    // Duplicate usage rows for r1 — the join must stay one row per run.
    for (const id of ["u1", "u2"]) {
      await exec(`INSERT INTO latch_usage (id, owner, run_id, model, input_tokens, output_tokens, cost, created_at)
                  VALUES (?, ?, 'r1', 'model-x', 1000, 10, 0.01, ?)`, [id, owner, now]);
    }

    const stats = createCachingStats({
      client,
      pricing: () => ({ inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }),
    });
    const rows = await stats.statsFor({ ownerKey: owner, windowDays: 7, agents: [] });

    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.agent).toBe("a");
    expect(a.runs).toBe(2); // r1 + r2 only, once each despite the duplicate usage row
    expect(a.inputTokens).toBe(2000);
    expect(a.cacheReadTokens).toBe(800);
    expect(a.cacheWriteTokens).toBe(500);
    expect(a.hitRate).toBeCloseTo(0.4);
    expect(a.chats).toBe(1);
    expect(a.distinctToolsets).toBe(1);
    expect(a.medianGapMs).toBe(60_000); // r2.started − r1.ended
  });
});

describe("minCacheablePrefixTokens", () => {
  it("uses the per-model table (non-monotonic across generations)", () => {
    expect(minCacheablePrefixTokens("claude-fable-5")).toBe(512);
    expect(minCacheablePrefixTokens("claude-opus-5")).toBe(512);
    expect(minCacheablePrefixTokens("claude-sonnet-4-6")).toBe(1024);
    expect(minCacheablePrefixTokens("claude-opus-4-7")).toBe(2048);
    expect(minCacheablePrefixTokens("claude-haiku-4-5")).toBe(4096);
    expect(minCacheablePrefixTokens("gpt-5.1")).toBe(1024);
  });
});
