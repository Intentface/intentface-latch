/**
 * Edge Eval v0 — the PAIRWISE judge: the judge answers the humans' question, on the humans'
 * artefact (plan, approved flow improvement 1).
 *
 *   node --env-file=.env --env-file=.env.langfuse-local --import tsx src/scripts/edge-judge-pairwise.ts --run demo-3
 *   … --judge-model claude-opus-5 --anchors-only --out judgments-pairwise-opus.jsonl   # the second family (improvement 4b)
 *   … --force --no-post                                                                 # re-judge, don't write to Langfuse
 *
 * Reads edge-eval-runs/<run>/review/pairs.json (written by edge-review-export.ts) and the
 * sweep's cells, rebuilds each blinded LEFT/RIGHT pair exactly as the reviewers see it, and
 * asks for one verdict: the 5-way preference (−2…+2, left-negative) and the single primary
 * reason, from the same two vocabularies the annotation queues use. κ against the humans is
 * then like-for-like — the absolute rubric stays a diagnostic.
 *
 * The judge never learns which side is which arm: the side→arm mapping lives only in
 * pairs.json, which is read here to fetch the two answers and never shown to the model.
 *
 * Output: review/<out> (default judgments-pairwise.jsonl) + review/<out>-summary.json, and —
 * unless --no-post — two scores on the pair's Langfuse trace, named `*_judge` so they never
 * mix with the reviewers' annotations, carrying judge_model/judge_version in metadata and
 * pinned to the pair trace's own timestamp so a re-judge upserts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { generateObject, type LanguageModel } from "ai";
import { getLangfuseClient, isLangfuseConfigured } from "@intentface/latch-langfuse";
import { getLatch } from "../lib/latch";
import { byId } from "../evals/edge/cases/questions";
import { followupFor } from "../evals/edge/cases/followup";
import { CONTRACTS, contractCriteria } from "../evals/edge/cases/contracts";
import { PILLAR_FOR, referenceBlock, type Category } from "../evals/edge/judge/rubric";
import {
  JUDGE_PREFERENCE_SCORE,
  JUDGE_REASON_SCORE,
  normalizePairwise,
  pairwiseBlock,
  PairwiseVerdict,
  REASON_LABELS,
  type ReasonLabel,
} from "../evals/edge/judge/pairwise";
import { loadJudgeReference, type Dynamic } from "../evals/edge/judge/reference";
import { evalPrincipal } from "./edge-connections";
import type { Pair } from "./edge-review-export";
import type { Arm } from "../evals/edge/variants";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg("run");
if (!RUN) throw new Error("--run <name> is required");
const RUN_DIR = resolve(`edge-eval-runs/${RUN}`);
const REVIEW_DIR = join(RUN_DIR, "review");
const JUDGE_MODEL = arg("judge-model", "claude-sonnet-5")!;
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT_NAME = arg("out", "judgments-pairwise.jsonl")!;
const ANCHORS_ONLY = process.argv.includes("--anchors-only");
const FORCE = process.argv.includes("--force");
const NO_POST = process.argv.includes("--no-post");
const JUDGE_VERSION = "pairwise-v0";
const JUDGE_TIMEOUT_MS = 120_000;

interface Cell {
  case_id: string;
  category: Category;
  variant: Arm;
  repetition: number;
  turn1: { runId?: string; answer: string };
  turn2: { runId?: string; answer: string };
  error?: string;
}

export interface PairJudgment {
  run_name: string;
  pair_id: string;
  trace_id: string;
  case_id: string;
  category: Category;
  anchor: boolean;
  judge_model: string;
  judge_version: string;
  /** Left-negative, exactly as the human config reads. */
  preference_raw: number;
  primary_reason: ReasonLabel;
  reason: string;
  /** Unblinded locally from pairs.json — never shown to the judge. */
  left_variant: Arm;
  right_variant: Arm;
  preferred_variant: Arm | "tie";
  /** Oriented to the LEFT_ARM of the export (D): + favours D, − favours the baseline. */
  d_minus_a: number;
  judged_at: string;
  error?: string;
}

async function judgePair(model: LanguageModel, reference: string, task: string): Promise<{ preference: number; primary_reason: ReasonLabel; reason: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { object } = await generateObject({
        model,
        schema: PairwiseVerdict,
        // Reference first and cacheable: identical across every pair of a category.
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: reference, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
              { type: "text", text: `\n\n${task}` },
            ],
          },
        ],
        // Two full recommendations plus adaptive thinking share this budget.
        maxOutputTokens: 8000,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      const o = object as { preference?: number; primary_reason?: string; reason: string };
      const v = normalizePairwise(o);
      return { ...v, reason: o.reason };
    } catch (e) {
      const raw = (e as { text?: string })?.text;
      lastError = (e instanceof Error ? e.message : String(e)) + (raw ? ` | raw: ${raw.slice(0, 300).replace(/\s+/g, " ")}` : "");
    }
  }
  throw new Error(lastError);
}

/** A stable score id per (pair, score name, judge model) — a re-judge overwrites its own score. */
const scoreId = (pairId: string, name: string) => createHash("sha256").update(`edge-pairwise:${pairId}:${name}:${JUDGE_MODEL}`).digest("hex").slice(0, 32);

async function postJudgeScores(j: PairJudgment, traceTimestamp: string) {
  const lf = getLangfuseClient();
  const meta = { run: j.run_name, pair_id: j.pair_id, case_id: j.case_id, judge_model: j.judge_model, judge_version: j.judge_version, source: "judge" };
  const environment = process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "edge-eval-local";
  type Event = Parameters<typeof lf.api.ingestion.batch>[0]["batch"][number];
  const events = [
    {
      id: crypto.randomUUID(),
      type: "score-create" as const,
      timestamp: traceTimestamp,
      body: { id: scoreId(j.pair_id, JUDGE_PREFERENCE_SCORE), traceId: j.trace_id, name: JUDGE_PREFERENCE_SCORE, value: j.preference_raw, dataType: "NUMERIC", comment: j.reason, metadata: meta, environment, timestamp: traceTimestamp },
    },
    {
      id: crypto.randomUUID(),
      type: "score-create" as const,
      timestamp: traceTimestamp,
      body: { id: scoreId(j.pair_id, JUDGE_REASON_SCORE), traceId: j.trace_id, name: JUDGE_REASON_SCORE, value: j.primary_reason, dataType: "CATEGORICAL", metadata: meta, environment, timestamp: traceTimestamp },
    },
  ] as unknown as Event[];
  const res = await lf.api.ingestion.batch({ batch: events });
  if (res.errors.length) throw new Error(JSON.stringify(res.errors).slice(0, 300));
}

async function main() {
  const pairsPath = join(REVIEW_DIR, "pairs.json");
  if (!existsSync(pairsPath)) throw new Error(`no ${pairsPath} — run edge-review-export.ts first`);
  const mapping = JSON.parse(readFileSync(pairsPath, "utf8")) as { run: string; rep: number; pairs: Pair[] };
  const cells = readFileSync(join(RUN_DIR, "cells.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Cell).filter((c) => !c.error);
  const outPath = join(REVIEW_DIR, OUT_NAME);
  mkdirSync(REVIEW_DIR, { recursive: true });
  if (FORCE && existsSync(outPath)) writeFileSync(outPath, "");
  const done = new Set(
    existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as PairJudgment).pair_id) : [],
  );
  const todo = mapping.pairs.filter((p) => (!ANCHORS_ONLY || p.anchor) && !done.has(p.pair_id));
  console.log(`[pair-judge] ${RUN}: ${mapping.pairs.length} pairs${ANCHORS_ONLY ? " (anchors only)" : ""}, ${todo.length} to judge, model ${JUDGE_MODEL} → ${outPath}`);
  if (!todo.length) return;

  const principal = await evalPrincipal();
  const { dynamic, modelFor } = await getLatch();
  const resolved = modelFor(JUDGE_MODEL) as { modelId?: string; provider?: string };
  if (resolved.modelId !== JUDGE_MODEL) throw new Error(`judge model "${JUDGE_MODEL}" resolved to "${resolved.modelId}" — catalog fallback; aborting`);
  if (resolved.provider && /openai/i.test(resolved.provider)) throw new Error(`judge must be a different family from the app model (got ${resolved.provider})`);
  console.log(`[pair-judge] model ${JUDGE_MODEL} → ${resolved.provider}/${resolved.modelId} ✓`);
  const model = modelFor(JUDGE_MODEL);

  console.log(`[pair-judge] fetching reference material live (client plane + 4 pillars)…`);
  const { clientContext, stances } = await loadJudgeReference(principal, dynamic as unknown as Dynamic);
  const referenceFor = (cat: Category, caseId: string) => {
    const contract = CONTRACTS.find((c) => c.case_id === caseId);
    return referenceBlock({ clientContext, expertStance: stances[cat], pillar: PILLAR_FOR[cat], caseCriteria: contract ? contractCriteria(contract) : undefined });
  };

  const cellOf = (p: Pair, side: "left" | "right") =>
    cells.find((c) => c.case_id === p.case_id && c.variant === p[side].variant && c.repetition === mapping.rep);

  const results: PairJudgment[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++]!;
      const L = cellOf(p, "left");
      const R = cellOf(p, "right");
      const q = byId(p.case_id);
      const base = {
        run_name: RUN!,
        pair_id: p.pair_id,
        trace_id: p.trace_id,
        case_id: p.case_id,
        category: p.category as Category,
        anchor: p.anchor,
        judge_model: JUDGE_MODEL,
        judge_version: JUDGE_VERSION,
        left_variant: p.left.variant as Arm,
        right_variant: p.right.variant as Arm,
        judged_at: new Date().toISOString(),
      };
      let j: PairJudgment;
      if (!L || !R) {
        j = { ...base, preference_raw: 0, primary_reason: "tie_or_no_reason", reason: "", preferred_variant: "tie", d_minus_a: 0, error: `missing cell for ${!L ? "left" : "right"} side` };
      } else {
        try {
          const v = await judgePair(
            model,
            referenceFor(p.category as Category, p.case_id),
            pairwiseBlock({ question: q.text, followup: followupFor(q), left: { turn1: L.turn1.answer, turn2: L.turn2.answer }, right: { turn1: R.turn1.answer, turn2: R.turn2.answer } }),
          );
          // Orient to D exactly as edge-review-import.ts does for the humans.
          const leftIsD = p.left.variant === "D";
          const dMinusA = leftIsD ? -v.preference : v.preference;
          j = {
            ...base,
            preference_raw: v.preference,
            primary_reason: v.primary_reason,
            reason: v.reason,
            preferred_variant: v.preference === 0 ? "tie" : dMinusA > 0 ? "D" : (leftIsD ? p.right.variant : p.left.variant) as Arm,
            d_minus_a: dMinusA,
          };
        } catch (e) {
          j = { ...base, preference_raw: 0, primary_reason: "tie_or_no_reason", reason: "", preferred_variant: "tie", d_minus_a: 0, error: e instanceof Error ? e.message : String(e) };
        }
      }
      results.push(j);
      appendFileSync(outPath, JSON.stringify(j) + "\n");
      console.log(`[pair-judge] ${results.length}/${todo.length} ${j.pair_id}${j.anchor ? " ANCHOR" : ""} · pref ${j.preference_raw >= 0 ? "+" : ""}${j.preference_raw} (${j.preferred_variant}) · ${j.primary_reason}${j.error ? ` ERROR ${j.error.slice(0, 90)}` : ""}`);
      if (!j.error && !NO_POST && isLangfuseConfigured()) {
        await postJudgeScores(j, p.timestamp ?? j.judged_at).catch((e) => console.warn(`[pair-judge] langfuse: ${(e as Error).message}`));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, todo.length)) }, worker));

  const all = readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairJudgment);
  const ok = all.filter((j) => !j.error);
  const summary = {
    run: RUN,
    judge_model: JUDGE_MODEL,
    judge_version: JUDGE_VERSION,
    anchors_only: ANCHORS_ONLY,
    pairs: all.length,
    errors: all.length - ok.length,
    judge_d_vs_a_win_rate: ok.length ? +(ok.filter((j) => j.preferred_variant === "D").length / ok.length).toFixed(3) : null,
    ties: ok.filter((j) => j.preferred_variant === "tie").length,
    mean_d_minus_a: ok.length ? +(ok.reduce((s, j) => s + j.d_minus_a, 0) / ok.length).toFixed(2) : null,
    // A side bias would show as a non-zero mean on the raw (left-negative) scale.
    mean_preference_raw: ok.length ? +(ok.reduce((s, j) => s + j.preference_raw, 0) / ok.length).toFixed(2) : null,
    by_category: Object.fromEntries(
      [...new Set(ok.map((j) => j.category))].map((c) => {
        const js = ok.filter((j) => j.category === c);
        return [c, { n: js.length, mean_d_minus_a: +(js.reduce((s, j) => s + j.d_minus_a, 0) / js.length).toFixed(2) }];
      }),
    ),
    reasons: Object.fromEntries(REASON_LABELS.map((r) => [r, ok.filter((j) => j.primary_reason === r).length]).filter(([, n]) => (n as number) > 0)),
  };
  const summaryPath = join(REVIEW_DIR, OUT_NAME.replace(/\.jsonl$/, "") + "-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`[pair-judge] done · ${ok.length}/${all.length} judged · D win rate ${summary.judge_d_vs_a_win_rate ?? "–"} · mean D−A ${summary.mean_d_minus_a ?? "–"} · ${summaryPath}`);
}

main()
  .catch((e) => {
    console.error("[pair-judge] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
