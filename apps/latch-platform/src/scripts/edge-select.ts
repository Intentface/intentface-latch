/**
 * Edge Eval v0 — pick the 20 optimization cases from the pilot (plan: "Case selection").
 *
 *   node --import tsx src/scripts/edge-select.ts --run pilot-luna [--write]
 *
 * Rules, fixed in code so no round can re-derive them by judgement:
 *  - pool = client-team register, minus the sealed holdout (never the end-user questions);
 *  - rank by |composite(D) − composite(A)| — spread in EITHER direction (plan: selecting
 *    "where D wins" would inflate the headline). Ties: a hard failure in either arm first
 *    (those are the diagnostic cases), then the lower composite (harder question);
 *  - INSIGHTS: all pilot-run INSIGHTS questions are taken (3 of 68; one of four Tier-1
 *    pillars — the benchmark must be able to see an insights regression);
 *  - the remaining seats are allocated to INFRA / AX / CODE proportionally to pool size
 *    (largest-remainder rounding) and filled greedily by spread;
 *  - author cap: no single author supplies more than AUTHOR_CAP of the 20 (the reviewers
 *    are also the authors; nobody should dominate the set they later review). When the
 *    cap blocks a pick, the next question by spread in that category is taken instead.
 *
 * Without --write it prints the ranking and the proposed selection. With --write it seals
 * cases/selection.json (refusing to overwrite unless --reseal).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATEGORIES, QUESTIONS, byId, type Category } from "../evals/edge/cases/questions";
import { allocate } from "../evals/edge/cases/holdout";
import type { Judgment } from "./edge-judge";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg("run");
if (!RUN) throw new Error("--run <pilot run name> is required");
const WRITE = process.argv.includes("--write");
const RESEAL = process.argv.includes("--reseal");
export const OPTIMIZATION_SIZE = 20;
export const AUTHOR_CAP = 5;

interface Ranked {
  id: string;
  category: Category;
  author: string;
  a: number | null;
  d: number | null;
  spread: number;
  hardFailure: boolean;
  aPass: boolean | null;
  dPass: boolean | null;
}

function loadJudgments(run: string): Judgment[] {
  const p = resolve(`edge-eval-runs/${run}/judgments.jsonl`);
  if (!existsSync(p)) throw new Error(`no judgments at ${p} — run edge-judge.ts first`);
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Judgment);
}

export function rank(judgments: Judgment[], holdout: Set<string>): Ranked[] {
  const pool = QUESTIONS.filter((q) => q.register === "client-team" && !holdout.has(q.id));
  const mean = (js: Judgment[]) => (js.length ? js.reduce((a, j) => a + j.composite, 0) / js.length : null);
  return pool
    .map((q) => {
      // A cell counts when its FOUR scaled dimensions are present (composite is complete);
      // an error on a binary/categorical dimension does not disqualify it.
      const complete = (j: Judgment) => ["decision_quality", "client_specificity", "expert_stance_fidelity", "stage_calibration"].every((d) => !(d in j.errors));
      const A = judgments.filter((j) => j.case_id === q.id && j.variant === "A" && complete(j));
      const D = judgments.filter((j) => j.case_id === q.id && j.variant === "D" && complete(j));
      const a = mean(A);
      const d = mean(D);
      return {
        id: q.id,
        category: q.category,
        author: q.author,
        a,
        d,
        spread: a !== null && d !== null ? Math.abs(d - a) : -1,
        hardFailure: [...A, ...D].some((j) => j.hard_failure !== "none"),
        aPass: A.length ? A.every((j) => j.overall_pass) : null,
        dPass: D.length ? D.every((j) => j.overall_pass) : null,
      };
    })
    .sort((x, y) => y.spread - x.spread || Number(y.hardFailure) - Number(x.hardFailure) || Math.min(x.a ?? 99, x.d ?? 99) - Math.min(y.a ?? 99, y.d ?? 99));
}

export function select(ranked: Ranked[]): { picked: Ranked[]; allocation: Record<Category, number>; skippedForCap: string[] } {
  const judged = ranked.filter((r) => r.spread >= 0);
  const insights = judged.filter((r) => r.category === "INSIGHTS");
  const rest = judged.filter((r) => r.category !== "INSIGHTS");
  const seats = OPTIMIZATION_SIZE - insights.length;
  const alloc = allocate(
    rest.map((r) => byId(r.id)),
    seats,
  );
  alloc.INSIGHTS = insights.length;
  const picked: Ranked[] = [...insights];
  const byAuthor = new Map<string, number>();
  for (const r of insights) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
  const skippedForCap: string[] = [];
  for (const cat of CATEGORIES.filter((c) => c !== "INSIGHTS")) {
    let need = alloc[cat];
    for (const r of rest.filter((x) => x.category === cat)) {
      if (need <= 0) break;
      if (r.author !== "unattributed" && (byAuthor.get(r.author) ?? 0) >= AUTHOR_CAP) {
        skippedForCap.push(r.id);
        continue;
      }
      picked.push(r);
      byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
      need--;
    }
  }
  return { picked, allocation: alloc, skippedForCap };
}

function main() {
  const holdout = new Set((JSON.parse(readFileSync(resolve("src/evals/edge/cases/holdout.json"), "utf8")) as { holdout: string[] }).holdout);
  const judgments = loadJudgments(RUN!);
  const ranked = rank(judgments, holdout);
  const unjudged = ranked.filter((r) => r.spread < 0).map((r) => r.id);
  const { picked, allocation, skippedForCap } = select(ranked);

  console.log(`[select] ${RUN}: ${judgments.length} judgments · pool ${ranked.length} · judged ${ranked.length - unjudged.length}${unjudged.length ? ` · UNJUDGED ${unjudged.join(",")}` : ""}`);
  console.log(`[select] allocation`, allocation, `author cap ${AUTHOR_CAP}`);
  console.log(`\n rank  id           cat       author        A     D   |D−A|  hf  pass(A/D)`);
  ranked.forEach((r, i) => {
    const mark = picked.includes(r) ? "*" : " ";
    console.log(
      ` ${mark}${String(i + 1).padStart(3)}  ${r.id.padEnd(12)} ${r.category.padEnd(9)} ${r.author.padEnd(12)} ${fmt(r.a)} ${fmt(r.d)}  ${r.spread < 0 ? "  -  " : r.spread.toFixed(1).padStart(5)}  ${r.hardFailure ? "!" : " "}   ${p(r.aPass)}/${p(r.dPass)}`,
    );
  });
  if (skippedForCap.length) console.log(`\n[select] skipped for author cap: ${skippedForCap.join(", ")}`);
  const byAuthor = Object.entries(picked.reduce<Record<string, number>>((m, r) => ((m[r.author] = (m[r.author] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  console.log(`[select] picked ${picked.length}: by category`, Object.fromEntries(CATEGORIES.map((c) => [c, picked.filter((r) => r.category === c).length])), `· by author`, Object.fromEntries(byAuthor));

  if (!WRITE) return console.log(`\n[select] dry run — pass --write to seal cases/selection.json`);
  const out = resolve("src/evals/edge/cases/selection.json");
  if (existsSync(out) && !RESEAL) {
    console.error(`[select] ${out} exists — the selection is sealed; pass --reseal to redo (and say why in the commit)`);
    process.exit(1);
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        pilot_run: RUN,
        selectedAt: new Date().toISOString(),
        git_commit_sha: execSync("git rev-parse HEAD").toString().trim(),
        rules: [
          "pool = client-team register minus the sealed holdout",
          "ranked by |composite(D) - composite(A)| in either direction; ties: hard failure first, then lower composite",
          "all INSIGHTS questions taken",
          "INFRA / AX / CODE seats proportional to pool size (largest remainder), filled by spread",
          `author cap ${AUTHOR_CAP} of ${OPTIMIZATION_SIZE}`,
        ],
        allocation,
        optimization: picked.map((r) => r.id).sort(),
        ranking: ranked.map((r) => ({ id: r.id, category: r.category, author: r.author, a: r.a, d: r.d, spread: r.spread, hardFailure: r.hardFailure })),
        skippedForCap,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[select] sealed ${out}`);
}

const fmt = (v: number | null) => (v === null ? "  - " : v.toFixed(1).padStart(4));
const p = (v: boolean | null) => (v === null ? "-" : v ? "P" : "f");

if (process.argv[1] && /edge-select\.ts$/.test(process.argv[1])) main();
