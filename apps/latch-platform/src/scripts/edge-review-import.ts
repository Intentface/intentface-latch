/**
 * Edge Eval v0 — Step 5 (return leg): read the reviewers' annotations back and unblind them.
 *
 *   node --env-file=.env --env-file=.env.langfuse-local --import tsx src/scripts/edge-review-import.ts --run v0
 *
 * Scores are read with `fields=details,subject,annotation` so `authorUserId` and `queueId`
 * come back (plan finding 4). Each preference is mapped through review/pairs.json (local)
 * from left/right to the variant it favoured. Writes review/annotations.jsonl and
 * review/review-summary.json: D-vs-A win rate (humans), per-reviewer counts, the anchor
 * set's raw agreement, and — when the pairwise judge has run over the same pairs
 * (review/judgments-pairwise.jsonl) — judge-vs-human agreement on exactly the same question:
 * raw, sign, Cohen's κ and quadratically weighted κ over the −2…+2 scale, plus agreement on
 * the primary reason. That is the calibration number; the inputs for edge-analyze.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLangfuseClient } from "@intentface/latch-langfuse";
import { categoricalAgreement, ordinalAgreement } from "../evals/edge/judge/agreement";
import type { PairJudgment } from "./edge-judge-pairwise";
import type { Pair } from "./edge-review-export";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg("run");
if (!RUN) throw new Error("--run <name> is required");
const REVIEW_DIR = resolve(`edge-eval-runs/${RUN}/review`);

interface Annotation {
  pair_id: string;
  case_id: string;
  category: string;
  anchor: boolean;
  reviewer_user_id: string;
  reviewer: string;
  queue_id: string | null;
  preference_raw: number; // −2…+2, left-negative
  preferred_variant: "A" | "D" | "tie";
  d_minus_a: number; // +2…−2 oriented to D
  primary_reason: string | null;
  comment: string | null;
  timestamp: string;
}

async function main() {
  const pairsPath = join(REVIEW_DIR, "pairs.json");
  if (!existsSync(pairsPath)) throw new Error(`no ${pairsPath} — run edge-review-export first`);
  const mapping = JSON.parse(readFileSync(pairsPath, "utf8")) as { pairs: Pair[]; score_configs: { preference: string; reason: string }; reviewers: string[] };
  const byTrace = new Map(mapping.pairs.map((p) => [p.trace_id, p]));
  const reviewersById = new Map((process.env.EDGE_REVIEWER_IDS ?? "").split(",").filter(Boolean).map((kv) => kv.split(":") as [string, string]).map(([k, id]) => [id, k]));
  const lf = getLangfuseClient();

  // Pull every score of the two configs (paginated), keep those on our pair traces.
  const pull = async (configId: string) => {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = await lf.api.scoresV3.getManyV3({ configId, limit: 100, cursor, fields: "details,subject,annotation" });
      out.push(...(page.data as unknown as Array<Record<string, unknown>>));
      cursor = (page.meta as { nextCursor?: string } | undefined)?.nextCursor;
    } while (cursor);
    return out;
  };
  const prefs = await pull(mapping.score_configs.preference);
  const reasons = await pull(mapping.score_configs.reason);
  const traceOf = (s: Record<string, unknown>) => ((s.subject as { traceId?: string } | undefined)?.traceId ?? (s.traceId as string | undefined)) ?? "";

  const annotations: Annotation[] = [];
  for (const s of prefs) {
    const p = byTrace.get(traceOf(s));
    if (!p) continue;
    const author = (s.authorUserId as string | null) ?? "unknown";
    const raw = Number(s.value);
    const reason = reasons.find((r) => traceOf(r) === p.trace_id && (r.authorUserId ?? null) === (s.authorUserId ?? null));
    // Orient to D: negative raw favours LEFT.
    const leftIsD = p.left.variant === "D";
    const dMinusA = leftIsD ? -raw : raw;
    annotations.push({
      pair_id: p.pair_id,
      case_id: p.case_id,
      category: p.category,
      anchor: p.anchor,
      reviewer_user_id: author,
      reviewer: reviewersById.get(author) ?? author,
      queue_id: (s.queueId as string | null) ?? null,
      preference_raw: raw,
      preferred_variant: raw === 0 ? "tie" : dMinusA > 0 ? "D" : "A",
      d_minus_a: dMinusA,
      primary_reason: (reason?.stringValue as string | undefined) ?? (reason?.value != null ? String(reason.value) : null),
      comment: (s.comment as string | null) ?? null,
      timestamp: String(s.timestamp),
    });
  }
  writeFileSync(join(REVIEW_DIR, "annotations.jsonl"), annotations.map((a) => JSON.stringify(a)).join("\n") + (annotations.length ? "\n" : ""));

  const dWins = annotations.filter((a) => a.preferred_variant === "D").length;
  const ties = annotations.filter((a) => a.preferred_variant === "tie").length;
  const perReviewer = Object.fromEntries(
    [...new Set(annotations.map((a) => a.reviewer))].map((r) => {
      const as = annotations.filter((a) => a.reviewer === r);
      return [r, { n: as.length, d_wins: as.filter((a) => a.preferred_variant === "D").length, ties: as.filter((a) => a.preferred_variant === "tie").length, mean_d_minus_a: +(as.reduce((x, a) => x + a.d_minus_a, 0) / Math.max(1, as.length)).toFixed(2) }];
    }),
  );
  // Anchor agreement: for each anchor pair with ≥2 reviewers, do they agree on the sign?
  const anchorPairs = [...new Set(annotations.filter((a) => a.anchor).map((a) => a.pair_id))];
  const agreements = anchorPairs
    .map((id) => annotations.filter((a) => a.pair_id === id).map((a) => a.preferred_variant))
    .filter((vs) => vs.length >= 2);
  const anchorAgreement = agreements.length ? +(agreements.filter((vs) => new Set(vs).size === 1).length / agreements.length).toFixed(2) : null;
  // Judge vs human on the SAME artefact and the SAME question (plan improvement 1).
  // One human rating per (pair, reviewer): a pair with three reviewers contributes three
  // comparisons against the one judge verdict, which is what κ against a single rater means.
  const judgePath = join(REVIEW_DIR, arg("judge-file", "judgments-pairwise.jsonl")!);
  const judgeByPair = new Map<string, PairJudgment>(
    existsSync(judgePath)
      ? readFileSync(judgePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairJudgment).filter((j) => !j.error).map((j) => [j.pair_id, j])
      : [],
  );
  const joined = annotations.flatMap((a) => {
    const j = judgeByPair.get(a.pair_id);
    return j ? [{ a, j }] : [];
  });
  const judgeVsHuman = joined.length
    ? {
        judge_file: judgePath,
        judge_model: joined[0]!.j.judge_model,
        comparisons: joined.length,
        pairs: new Set(joined.map((x) => x.a.pair_id)).size,
        preference: ordinalAgreement(joined.map((x) => [x.j.d_minus_a, x.a.d_minus_a] as [number, number])),
        primary_reason: categoricalAgreement(joined.map((x) => [x.j.primary_reason, x.a.primary_reason ?? "none"] as [string, string])),
        // Does the judge lean the same way overall, or is it simply harsher/softer?
        mean_d_minus_a: { judge: +(joined.reduce((s, x) => s + x.j.d_minus_a, 0) / joined.length).toFixed(2), human: +(joined.reduce((s, x) => s + x.a.d_minus_a, 0) / joined.length).toFixed(2) },
        per_reviewer: Object.fromEntries(
          [...new Set(joined.map((x) => x.a.reviewer))].map((r) => {
            const xs = joined.filter((x) => x.a.reviewer === r);
            return [r, ordinalAgreement(xs.map((x) => [x.j.d_minus_a, x.a.d_minus_a] as [number, number]))];
          }),
        ),
      }
    : null;

  const summary = {
    run: RUN,
    annotations: annotations.length,
    pairs_total: mapping.pairs.length,
    pairs_annotated: new Set(annotations.map((a) => a.pair_id)).size,
    human_d_vs_a_win_rate: annotations.length ? +(dWins / annotations.length).toFixed(3) : null,
    ties,
    mean_d_minus_a: annotations.length ? +(annotations.reduce((x, a) => x + a.d_minus_a, 0) / annotations.length).toFixed(2) : null,
    per_reviewer: perReviewer,
    anchor_pairs_with_2plus_reviews: agreements.length,
    anchor_raw_agreement: anchorAgreement,
    reasons: Object.fromEntries([...new Set(annotations.map((a) => a.primary_reason ?? "none"))].map((r) => [r, annotations.filter((a) => (a.primary_reason ?? "none") === r).length])),
    judge_vs_human: judgeVsHuman,
  };
  writeFileSync(join(REVIEW_DIR, "review-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`[review-import] ${annotations.length} annotations on ${summary.pairs_annotated}/${mapping.pairs.length} pairs · human D-vs-A win rate ${summary.human_d_vs_a_win_rate ?? "–"} · anchor agreement ${anchorAgreement ?? "–"}`);
  console.log(`[review-import] per reviewer`, perReviewer);
  if (judgeVsHuman) {
    const p = judgeVsHuman.preference;
    console.log(`[review-import] judge (${judgeVsHuman.judge_model}) vs human on ${judgeVsHuman.comparisons} ratings · raw ${p.raw} · sign ${p.signAgreement} · κ ${p.kappa ?? "–"} · weighted κ ${p.weightedKappa ?? "–"} · mean |Δ| ${p.meanAbsDelta} · reason κ ${judgeVsHuman.primary_reason.kappa ?? "–"}`);
  } else console.log(`[review-import] no pairwise judge file at ${judgePath} — run edge-judge-pairwise.ts for judge–human agreement`);
}

main()
  .catch((e) => {
    console.error("[review-import] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
