/**
 * Edge Eval v0 — the judge's noise floor (plan, approved flow improvement 4).
 *
 * A benchmark's headline is only as sharp as the instrument reading it. Two numbers say how
 * sharp this one is, and both are cheap:
 *   (a) SELF-CONSISTENCY — the same model judging the same cells twice. Anything the judge
 *       disagrees with itself about is noise, and a prompt change smaller than that noise is
 *       not a result.
 *   (b) JUDGE–JUDGE — a second model family on the same items. Agreement there is evidence
 *       the rubric, not one model's taste, is doing the work.
 * Human calibration (judge vs reviewers) is the third leg and lives in edge-review-import.ts.
 *
 * Produce the inputs first, then diff them:
 *   node … src/scripts/edge-judge.ts --run demo-3 --out judgments-pass2.jsonl
 *   node … src/scripts/edge-judge-pairwise.ts --run demo-3 --anchors-only --judge-model claude-opus-5 --out judgments-pairwise-opus.jsonl
 *   node --import tsx src/scripts/edge-judge-reliability.ts --run demo-3 \
 *       --a judgments.jsonl --b judgments-pass2.jsonl \
 *       --pair-a review/judgments-pairwise.jsonl --pair-b review/judgments-pairwise-opus.jsonl
 *
 * Writes edge-eval-runs/<run>/judge-reliability.json. Comparisons are per (case, variant,
 * rep) for the rubric dimensions and per pair for the pairwise dimension; κ is Cohen's,
 * quadratically weighted on the ordered scales (agreement.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BINARY_DIMENSIONS, SCALED_DIMENSIONS } from "../evals/edge/judge/rubric";
import { binaryAgreement, categoricalAgreement, ordinalAgreement } from "../evals/edge/judge/agreement";
import type { Judgment } from "./edge-judge";
import type { PairJudgment } from "./edge-judge-pairwise";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg("run");
if (!RUN) throw new Error("--run <name> is required");
const RUN_DIR = resolve(`edge-eval-runs/${RUN}`);
const A = arg("a", "judgments.jsonl")!;
const B = arg("b");
const PAIR_A = arg("pair-a", "review/judgments-pairwise.jsonl")!;
const PAIR_B = arg("pair-b");

const readJsonl = <T>(rel: string): T[] => {
  const p = join(RUN_DIR, rel);
  if (!existsSync(p)) throw new Error(`no ${p}`);
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
};

const cellKey = (j: Judgment) => `${j.case_id}|${j.variant}|${j.repetition}`;

/** Per-dimension agreement between two judgment files over the cells both contain. */
function compareRubric(a: Judgment[], b: Judgment[]) {
  const byKey = new Map(b.map((j) => [cellKey(j), j]));
  const pairs = a.flatMap((x) => {
    const y = byKey.get(cellKey(x));
    return y ? [[x, y] as const] : [];
  });
  if (!pairs.length) throw new Error("the two judgment files share no cells");
  const scaled = Object.fromEntries(
    SCALED_DIMENSIONS.map((d) => {
      const both = pairs.flatMap(([x, y]) => (x.scores[d] !== undefined && y.scores[d] !== undefined ? [[x.scores[d]!, y.scores[d]!] as [number, number]] : []));
      return [d, ordinalAgreement(both)];
    }),
  );
  const binary = Object.fromEntries(
    BINARY_DIMENSIONS.map((d) => {
      const both = pairs.flatMap(([x, y]) => (x.passes[d] !== undefined && y.passes[d] !== undefined ? [[x.passes[d]!, y.passes[d]!] as [boolean, boolean]] : []));
      return [d, binaryAgreement(both)];
    }),
  );
  const composite = ordinalAgreement(pairs.map(([x, y]) => [x.composite, y.composite] as [number, number]));
  return {
    cells: pairs.length,
    judge_models: { a: pairs[0]![0].judge_model, b: pairs[0]![1].judge_model },
    composite,
    // The decision the benchmark actually reports: did the two passes agree on pass/fail?
    overall_pass: binaryAgreement(pairs.map(([x, y]) => [x.overall_pass, y.overall_pass] as [boolean, boolean])),
    hard_failure: categoricalAgreement(pairs.map(([x, y]) => [x.hard_failure, y.hard_failure] as [string, string])),
    scaled,
    binary,
    // Per-arm mean composite in each pass: a judge that is noisy but unbiased leaves the
    // ARM ORDER intact, which is what the headline depends on.
    by_variant: Object.fromEntries(
      [...new Set(pairs.map(([x]) => x.variant))].sort().map((v) => {
        const xs = pairs.filter(([x]) => x.variant === v);
        const mean = (f: (p: readonly [Judgment, Judgment]) => number) => +(xs.reduce((s, p) => s + f(p), 0) / xs.length).toFixed(2);
        return [v, { n: xs.length, composite_a: mean(([x]) => x.composite), composite_b: mean(([, y]) => y.composite) }];
      }),
    ),
  };
}

function comparePairwise(a: PairJudgment[], b: PairJudgment[]) {
  const byId = new Map(b.filter((j) => !j.error).map((j) => [j.pair_id, j]));
  const pairs = a.filter((j) => !j.error).flatMap((x) => {
    const y = byId.get(x.pair_id);
    return y ? [[x, y] as const] : [];
  });
  if (!pairs.length) return null;
  return {
    pairs: pairs.length,
    judge_models: { a: pairs[0]![0].judge_model, b: pairs[0]![1].judge_model },
    anchors_only: pairs.every(([x]) => x.anchor),
    preference: ordinalAgreement(pairs.map(([x, y]) => [x.d_minus_a, y.d_minus_a] as [number, number])),
    primary_reason: categoricalAgreement(pairs.map(([x, y]) => [x.primary_reason, y.primary_reason] as [string, string])),
    mean_d_minus_a: { a: +(pairs.reduce((s, [x]) => s + x.d_minus_a, 0) / pairs.length).toFixed(2), b: +(pairs.reduce((s, [, y]) => s + y.d_minus_a, 0) / pairs.length).toFixed(2) },
    // Both judges facing the same blinded sides: a shared lean towards one SIDE (rather than
    // one arm) would be a position bias in the pair presentation, not a verdict.
    mean_preference_raw: { a: +(pairs.reduce((s, [x]) => s + x.preference_raw, 0) / pairs.length).toFixed(2), b: +(pairs.reduce((s, [, y]) => s + y.preference_raw, 0) / pairs.length).toFixed(2) },
  };
}

function main() {
  const rubric = B ? compareRubric(readJsonl<Judgment>(A), readJsonl<Judgment>(B)) : null;
  const pairwise = PAIR_B ? comparePairwise(readJsonl<PairJudgment>(PAIR_A), readJsonl<PairJudgment>(PAIR_B)) : null;
  if (!rubric && !pairwise) throw new Error("nothing to compare — pass --b (rubric) and/or --pair-b (pairwise)");
  const out = {
    run: RUN,
    generated_at: new Date().toISOString(),
    note: "Judge noise floor. Same-model comparisons are self-consistency; different-model ones are judge–judge agreement. κ is Cohen's; weightedKappa is quadratically weighted (an off-by-one rung counts less than an opposite verdict).",
    rubric: rubric ? { files: { a: A, b: B }, kind: rubric.judge_models.a === rubric.judge_models.b ? "self-consistency" : "judge-judge", ...rubric } : null,
    pairwise: pairwise ? { files: { a: PAIR_A, b: PAIR_B }, kind: pairwise.judge_models.a === pairwise.judge_models.b ? "self-consistency" : "judge-judge", ...pairwise } : null,
  };
  const outPath = join(RUN_DIR, "judge-reliability.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  if (rubric) {
    console.log(`[reliability] rubric (${out.rubric!.kind}, ${rubric.judge_models.a} vs ${rubric.judge_models.b}) over ${rubric.cells} cells`);
    console.log(`[reliability]   composite: mean |Δ| ${rubric.composite.meanAbsDelta} · weighted κ ${rubric.composite.weightedKappa ?? "–"} · overall_pass raw ${rubric.overall_pass.raw} κ ${rubric.overall_pass.kappa ?? "–"}`);
    for (const d of SCALED_DIMENSIONS) console.log(`[reliability]   ${d.padEnd(24)} raw ${rubric.scaled[d]!.raw} · |Δ| ${rubric.scaled[d]!.meanAbsDelta} · wκ ${rubric.scaled[d]!.weightedKappa ?? "–"}`);
    for (const d of BINARY_DIMENSIONS) console.log(`[reliability]   ${d.padEnd(24)} raw ${rubric.binary[d]!.raw} · κ ${rubric.binary[d]!.kappa ?? "–"}`);
  }
  if (pairwise) {
    console.log(`[reliability] pairwise (${out.pairwise!.kind}, ${pairwise.judge_models.a} vs ${pairwise.judge_models.b}) over ${pairwise.pairs} pairs`);
    console.log(`[reliability]   preference: raw ${pairwise.preference.raw} · sign ${pairwise.preference.signAgreement} · κ ${pairwise.preference.kappa ?? "–"} · wκ ${pairwise.preference.weightedKappa ?? "–"} · reason κ ${pairwise.primary_reason.kappa ?? "–"}`);
  }
  console.log(`[reliability] → ${outPath}`);
}

main();
