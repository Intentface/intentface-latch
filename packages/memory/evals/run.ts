import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInMemoryStore } from "../src/store/memory.js";
import { memorySearchTool } from "../src/tools.js";
import type { ScopeRef } from "../src/types.js";
import { serialize, CORPUS_SEED } from "./corpus/generator.js";
import { toPublicQuery } from "./qrels/seal.js";
import type { Qrel, QrelTier } from "./qrels/derive.js";
import { mean, ndcgAtK, precisionAtK, recallAtK, reciprocalRank, top1Hit } from "./scorer/metrics.js";
import { MEMORY_FILES_DIR, QRELS_PATH, RESULTS_DIR, RESULTS_PATH } from "./paths.js";

/**
 * Offline memory_search benchmark (`pnpm eval:memory-search`).
 *
 * Loads the committed reference memory files into the in-memory store, runs
 * every sealed qrels query through the REAL `memory_search` tool
 * (`memorySearchTool` → `MemoryStore.search`), and scores the ranked results
 * against the gold labels. Fully deterministic: zero LLM calls, zero network,
 * no clocks — the committed baseline report should reproduce byte-for-byte.
 *
 * Sealing: only `toPublicQuery(qrel).text` ever reaches the search path.
 */

const K = 5;
const SEARCH_LIMIT = 10;

const SCOPE: ScopeRef = {
  key: "mem:_memory/running-coach/u-eval",
  connection: "mem",
  root: "_memory/running-coach/u-eval",
};

interface QueryResult {
  id: string;
  tier: QrelTier;
  query: string;
  expected: string;
  got: string[];
  p_at_5: number;
  r_at_5: number;
  rr: number;
  ndcg_at_5: number;
  top1: 0 | 1;
}

interface TierReport {
  queries: number;
  p_at_5: number;
  r_at_5: number;
  mrr: number;
  ndcg_at_5: number;
  top1_hit_rate: number;
}

function aggregate(results: readonly QueryResult[]): TierReport {
  return {
    queries: results.length,
    p_at_5: mean(results.map((r) => r.p_at_5)),
    r_at_5: mean(results.map((r) => r.r_at_5)),
    mrr: mean(results.map((r) => r.rr)),
    ndcg_at_5: mean(results.map((r) => r.ndcg_at_5)),
    top1_hit_rate: mean(results.map((r) => r.top1)),
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const roundReport = (t: TierReport): TierReport => ({
  queries: t.queries,
  p_at_5: round(t.p_at_5),
  r_at_5: round(t.r_at_5),
  mrr: round(t.mrr),
  ndcg_at_5: round(t.ndcg_at_5),
  top1_hit_rate: round(t.top1_hit_rate),
});

async function main(): Promise<void> {
  // Load the committed memory-file fixtures into the store.
  const memoryFileNames = readdirSync(MEMORY_FILES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const files: Record<string, string> = {};
  for (const file of memoryFileNames) {
    files[`${SCOPE.root}/memories/${file}`] = readFileSync(
      path.join(MEMORY_FILES_DIR, file),
      "utf8",
    );
  }
  const store = createInMemoryStore({ files });

  const qrels = JSON.parse(readFileSync(QRELS_PATH, "utf8")) as Qrel[];

  // The real agent-facing search tool, bound exactly as the provider binds it.
  const tool = memorySearchTool([
    { level: "agent-user", bound: { store, principal: {}, scope: SCOPE } },
  ]) as unknown as {
    execute: (
      input: { query: string; limit?: number },
      options: unknown,
    ) => Promise<{ hits: Array<{ path: string; snippet: string }> }>;
  };

  const perQuery: QueryResult[] = [];
  for (const qrel of qrels) {
    const pub = toPublicQuery(qrel); // gold is stripped here — id + text only
    const { hits } = await tool.execute(
      { query: pub.text, limit: SEARCH_LIMIT },
      { toolCallId: `eval-${pub.id}`, messages: [] },
    );
    const ranked = Array.from(
      new Set(
        hits
          .map((h) => h.path)
          .filter((p) => p.startsWith(`${SCOPE.root}/memories/`))
          .map((p) => path.basename(p, ".md")),
      ),
    );
    const relevantSet = new Set(qrel.relevant.map((r) => r.name));
    const grades = new Map(qrel.relevant.map((r) => [r.name, r.grade]));
    perQuery.push({
      id: qrel.id,
      tier: qrel.tier,
      query: qrel.query,
      expected: qrel.first_relevant,
      got: ranked.slice(0, K),
      p_at_5: round(precisionAtK(ranked, relevantSet, K)),
      r_at_5: round(recallAtK(ranked, relevantSet, K)),
      rr: round(reciprocalRank(ranked, relevantSet)),
      ndcg_at_5: round(ndcgAtK(ranked, grades, K)),
      top1: top1Hit(ranked, qrel.first_relevant),
    });
  }

  const tierNames = Array.from(new Set(perQuery.map((r) => r.tier)));
  const tiers = Object.fromEntries(
    tierNames.map((tier) => [tier, roundReport(aggregate(perQuery.filter((r) => r.tier === tier)))]),
  );
  const overall = roundReport(aggregate(perQuery));

  const report = {
    config: {
      seed: CORPUS_SEED,
      k: K,
      search_limit: SEARCH_LIMIT,
      memory_files: memoryFileNames.length,
      queries: qrels.length,
    },
    overall,
    tiers,
    per_query: perQuery,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(RESULTS_PATH, serialize(report), "utf8");

  // ---- console report ----
  const fmt = (n: number) => n.toFixed(3);
  const row = (label: string, t: TierReport) =>
    `${label.padEnd(22)} ${String(t.queries).padStart(3)}  ${fmt(t.p_at_5)}  ${fmt(t.r_at_5)}  ${fmt(t.mrr)}  ${fmt(t.ndcg_at_5)}   ${fmt(t.top1_hit_rate)}`;

  console.log(`memory_search offline eval — ${qrels.length} queries over ${memoryFileNames.length} memory files (k=${K})`);
  console.log("");
  console.log(`${"tier".padEnd(22)}   n  P@5    R@5    MRR    nDCG@5  top-1`);
  for (const tier of tierNames) console.log(row(tier, tiers[tier]));
  console.log(row("OVERALL", overall));

  const misses = perQuery.filter((r) => r.top1 === 0);
  if (misses.length > 0) {
    console.log("");
    console.log(`top-1 misses (${misses.length}):`);
    for (const miss of misses) {
      console.log(`  ${miss.id} [${miss.tier}] "${miss.query}"`);
      console.log(`      expected ${miss.expected}; got ${miss.got.slice(0, 3).join(", ") || "(nothing)"}`);
    }
  }
  console.log("");
  console.log(`report written to ${RESULTS_PATH}`);
}

await main();
