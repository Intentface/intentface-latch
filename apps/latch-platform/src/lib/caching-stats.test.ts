import { describe, expect, it } from "vitest";
import {
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
