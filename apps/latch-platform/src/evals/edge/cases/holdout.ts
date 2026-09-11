/**
 * Edge Eval v0 — the SEALED holdout draw (plan: "Holdout 10 drawn stratified-at-random
 * BEFORE pilot results are seen").
 *
 * Rules, fixed here so no round can re-derive them by judgement:
 *  - drawn from the client-team register only. The seven Finnish end-user questions are
 *    a different register whose place in the benchmark is decided after the pilot; a
 *    holdout question that later leaves the benchmark would shrink the holdout.
 *  - INSIGHTS contributes 0: it has 3 questions and is one of four Tier-1 pillars, so all
 *    three stay in the optimization pool (plan: "INSIGHTS is only 3 of 75").
 *  - the remaining 10 are allocated across INFRA / AX / CODE proportionally to pool size
 *    (largest-remainder rounding), then drawn uniformly within each category with a
 *    seeded PRNG. Seed + git sha are recorded in holdout.json; holdout.test.ts re-draws
 *    and must reproduce the committed file byte for byte.
 */
import { createHash } from "node:crypto";
import { CATEGORIES, QUESTIONS, type Category, type Question } from "./questions";

export const HOLDOUT_SIZE = 10;
export const HOLDOUT_SEED = "edge-eval-v0-holdout-2026-09-11";

/** Deterministic 32-bit PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Questions eligible for the holdout draw. */
export const holdoutPool = (): Question[] =>
  QUESTIONS.filter((x) => x.register === "client-team" && x.category !== "INSIGHTS");

/** Proportional allocation with largest-remainder rounding. */
export function allocate(pool: Question[], size: number): Record<Category, number> {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, pool.filter((x) => x.category === c).length])) as Record<Category, number>;
  const total = pool.length;
  const exact = CATEGORIES.map((c) => [c, (counts[c] / total) * size] as const);
  const floors = Object.fromEntries(exact.map(([c, v]) => [c, Math.floor(v)])) as Record<Category, number>;
  let remaining = size - Object.values(floors).reduce((a, b) => a + b, 0);
  for (const [c] of [...exact].sort((a, b) => b[1] - Math.floor(b[1]) - (a[1] - Math.floor(a[1])))) {
    if (remaining <= 0) break;
    floors[c] += 1;
    remaining -= 1;
  }
  return floors;
}

export function drawHoldout(seed = HOLDOUT_SEED, size = HOLDOUT_SIZE): string[] {
  const rand = seededRandom(seed);
  const pool = holdoutPool();
  const alloc = allocate(pool, size);
  const picked: string[] = [];
  for (const c of CATEGORIES) {
    const ids = pool.filter((x) => x.category === c).map((x) => x.id);
    // Fisher–Yates over the category, take the first `alloc[c]`.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    picked.push(...ids.slice(0, alloc[c]));
  }
  return picked.sort();
}

export interface HoldoutRecord {
  seed: string;
  size: number;
  drawnAt: string;
  git_commit_sha: string;
  rules: string[];
  pool: { size: number; byCategory: Record<Category, number> };
  allocation: Record<Category, number>;
  holdout: string[];
}
