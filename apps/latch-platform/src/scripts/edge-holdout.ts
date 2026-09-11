/**
 * Edge Eval v0 — draw and SEAL the holdout (run once; the test reproduces it).
 *
 *   node --import tsx src/scripts/edge-holdout.ts
 *
 * Writes src/evals/edge/cases/holdout.json. Refuses to overwrite an existing seal unless
 * --reseal is passed — the whole point is that the draw happens before any pilot result
 * is seen and never moves afterwards.
 */
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { allocate, drawHoldout, HOLDOUT_SEED, HOLDOUT_SIZE, holdoutPool, type HoldoutRecord } from "../evals/edge/cases/holdout";
import { CATEGORIES } from "../evals/edge/cases/questions";

const out = new URL("../evals/edge/cases/holdout.json", import.meta.url);
if (existsSync(out) && !process.argv.includes("--reseal")) {
  console.error(`[holdout] ${out.pathname} already exists — the holdout is sealed. Pass --reseal to redraw (and say why in the commit).`);
  process.exit(1);
}
const pool = holdoutPool();
const record: HoldoutRecord = {
  seed: HOLDOUT_SEED,
  size: HOLDOUT_SIZE,
  drawnAt: new Date().toISOString(),
  git_commit_sha: execSync("git rev-parse HEAD").toString().trim(),
  rules: [
    "client-team register only (the 7 Finnish end-user questions are excluded from the draw)",
    "INSIGHTS contributes 0 (3 questions total; all stay in the optimization pool)",
    "INFRA / AX / CODE allocated proportionally to pool size, largest-remainder rounding",
    "uniform draw within category via seeded PRNG (mulberry32 over sha256(seed))",
  ],
  pool: {
    size: pool.length,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, pool.filter((x) => x.category === c).length])) as HoldoutRecord["pool"]["byCategory"],
  },
  allocation: allocate(pool, HOLDOUT_SIZE),
  holdout: drawHoldout(),
};
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`[holdout] sealed ${record.holdout.length}: ${record.holdout.join(", ")}`);
console.log(`[holdout] allocation`, record.allocation, `pool`, record.pool.byCategory);
