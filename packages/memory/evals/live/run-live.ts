import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { memorySearchTool } from "../../src/tools.js";
import { serialize } from "../corpus/generator.js";
import { toPublicQuery } from "../qrels/seal.js";
import type { Qrel, QrelTier } from "../qrels/derive.js";
import {
  mean,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  top1Hit,
} from "../scorer/metrics.js";
import { QRELS_PATH, RESULTS_DIR } from "../paths.js";
import { createLiveStore, LIVE_SCOPE } from "./live-store.js";

/**
 * LIVE memory_search benchmark (`pnpm eval:memory-search:live`): the same 37
 * sealed qrels queries as the offline eval (`evals/run.ts`), but through
 * `createLoredexStore` against the real Loredex eval workspace — so this
 * measures Loredex's server-side ranking, not the in-memory BM25 stand-in.
 *
 * Prerequisites: `LOREDEX_EVAL_TOKEN` set, workspace seeded via
 * `pnpm eval:seed-live`. Needs network; NOT byte-deterministic (latency, and
 * the backend may evolve) — the report lands in `memory-search-live.json`,
 * separate from the committed offline baseline, and diffs against it are the
 * point: they show where the stand-in and production ranking disagree.
 */

const K = 5;
const SEARCH_LIMIT = 10;
const LIVE_RESULTS_PATH = path.join(RESULTS_DIR, "memory-search-live.json");

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
  ms: number;
}

interface TierReport {
  queries: number;
  p_at_5: number;
  r_at_5: number;
  mrr: number;
  ndcg_at_5: number;
  top1_hit_rate: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

function aggregate(results: readonly QueryResult[]): TierReport {
  return {
    queries: results.length,
    p_at_5: round(mean(results.map((r) => r.p_at_5))),
    r_at_5: round(mean(results.map((r) => r.r_at_5))),
    mrr: round(mean(results.map((r) => r.rr))),
    ndcg_at_5: round(mean(results.map((r) => r.ndcg_at_5))),
    top1_hit_rate: round(mean(results.map((r) => r.top1))),
  };
}

async function main(): Promise<void> {
  const { store } = await createLiveStore();

  if (!(await store.available({}, LIVE_SCOPE))) {
    console.error(
      "live store unavailable — check auth (pnpm eval:auth-live), network, and that " +
        "the workspace is seeded (pnpm eval:seed-live).",
    );
    process.exit(1);
  }

  const qrels = JSON.parse(readFileSync(QRELS_PATH, "utf8")) as Qrel[];

  const tool = memorySearchTool({ store, principal: {}, scope: LIVE_SCOPE }) as unknown as {
    execute: (
      input: { query: string; limit?: number },
      options: unknown,
    ) => Promise<{ hits: Array<{ path: string; snippet: string }> }>;
  };

  const perQuery: QueryResult[] = [];
  for (const qrel of qrels) {
    const pub = toPublicQuery(qrel); // gold stripped — id + text only
    const started = Date.now();
    const { hits } = await tool.execute(
      { query: pub.text, limit: SEARCH_LIMIT },
      { toolCallId: `eval-${pub.id}`, messages: [] },
    );
    const ms = Date.now() - started;
    // Loredex hits carry no folder path — the store derives `<root>/<title>`
    // (see parseSearchHits) — so identify hits by filename, excluding the
    // compiled index and any hit that only resolved to an opaque file id.
    const ranked = Array.from(
      new Set(
        hits
          .map((h) => h.path)
          .filter((p) => p.startsWith(`${LIVE_SCOPE.root}/`) && p.endsWith(".md"))
          .map((p) => path.basename(p, ".md"))
          .filter((name) => name !== "MEMORY"),
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
      ms,
    });
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const tierNames = Array.from(new Set(perQuery.map((r) => r.tier)));
  const tiers = Object.fromEntries(
    tierNames.map((t) => [t, aggregate(perQuery.filter((r) => r.tier === t))]),
  );
  const overall = aggregate(perQuery);
  const latencies = perQuery.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

  const report = {
    config: {
      backend: "loredex-live",
      k: K,
      search_limit: SEARCH_LIMIT,
      queries: qrels.length,
      ran_at: new Date().toISOString(),
    },
    overall,
    tiers,
    per_query: perQuery,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(LIVE_RESULTS_PATH, serialize(report), "utf8");

  const fmt = (n: number) => n.toFixed(3);
  const row = (label: string, t: TierReport) =>
    `${label.padEnd(22)} ${String(t.queries).padStart(3)}  ${fmt(t.p_at_5)}  ${fmt(t.r_at_5)}  ${fmt(t.mrr)}  ${fmt(t.ndcg_at_5)}   ${fmt(t.top1_hit_rate)}`;
  console.log(`memory_search LIVE eval (Loredex) — ${qrels.length} queries (k=${K})`);
  console.log("");
  console.log(`${"tier".padEnd(22)}   n  P@5    R@5    MRR    nDCG@5  top-1`);
  for (const tier of tierNames) console.log(row(tier, tiers[tier]));
  console.log(row("OVERALL", overall));
  console.log("");
  console.log(`latency ms: p50 ${pct(0.5)}, p95 ${pct(0.95)}, max ${latencies[latencies.length - 1]}`);

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
  console.log(`report written to ${LIVE_RESULTS_PATH}`);
  console.log("compare with the offline baseline: evals/results/memory-search-baseline.json");
}

await main();
