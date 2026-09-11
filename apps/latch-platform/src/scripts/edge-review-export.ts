/**
 * Edge Eval v0 — Step 5: put blinded D-vs-A pairs in front of the reviewers via Langfuse
 * annotation queues (one queue per reviewer — an item has one global completion status and
 * no assignee, so a shared queue would let the first reviewer close an item for everyone).
 *
 *   node --env-file=.env --env-file=.env.langfuse-local --import tsx src/scripts/edge-review-export.ts --run v0 [--rep 1] [--anchor 10] [--dry-run]
 *
 * Per case: one synthesized trace whose OUTPUT holds the two turn-2 recommendations as
 * "Left" and "Right" in a seeded random order. The variant behind each side is written ONLY
 * to edge-eval-runs/<run>/review/pairs.json (gitignored) — never to trace metadata or tags,
 * which the UI renders. Two score configs: `edge_pairwise_preference` (5-way, −2…+2 so it
 * averages) and `edge_primary_reason` (one category; further reasons go in the comment).
 * The anchor set (default 10, stratified by category, seeded) goes to ALL reviewers' queues
 * for inter-rater agreement; the remaining pairs are split round-robin. Idempotent: existing
 * configs / queues / items are reused by name and objectId.
 *
 * Reviewer user ids come from EDGE_REVIEWER_IDS (name:id,…) written by
 * tools/langfuse-local/setup-reviewers.sh.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLangfuseClient, isLangfuseConfigured } from "@intentface/latch-langfuse";
import type { Arm } from "../evals/edge/variants";
// The pair rubric — the same two score configs the pairwise JUDGE answers against
// (src/evals/edge/judge/pairwise.ts), so humans and judge annotate one vocabulary.
import { PREFERENCE_CONFIG, REASON_CONFIG } from "../evals/edge/judge/pairwise";
import { QUESTIONS } from "../evals/edge/cases/questions";
import { followupFor } from "../evals/edge/cases/followup";
import { seededRandom } from "../evals/edge/cases/holdout";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN_ARG = arg("run");
if (!RUN_ARG) throw new Error("--run <name> is required");
const RUN: string = RUN_ARG;
const RUN_DIR = resolve(`edge-eval-runs/${RUN}`);
const REVIEW_DIR = join(RUN_DIR, "review");
const REP = Number(arg("rep", "1"));
const ANCHOR_N = Number(arg("anchor", "10"));
const DRY = process.argv.includes("--dry-run");
const SEED = arg("seed", `edge-review-${RUN}`)!;
// One clock for everything this export creates: the pair traces carry it, pairs.json keeps
// it, and the pairwise judge pins its score writes to it so re-judging upserts rather than
// duplicating (Langfuse dedupes a score on id + name + timestamp at date granularity).
const NOW = new Date().toISOString();
const LEFT_ARM = "D" as const;
const RIGHT_ARM = "A" as const; // the pair under review is D vs A (plan: headline = D-vs-A win rate)

interface Cell {
  case_id: string;
  category: string;
  variant: Arm;
  repetition: number;
  turn1: { runId?: string; answer: string };
  turn2: { runId?: string; answer: string };
  error?: string;
}
export interface Pair {
  pair_id: string;
  trace_id: string;
  /** The pair trace's clock, fixed at first export: re-exports and score writes pin to it. */
  timestamp?: string;
  case_id: string;
  category: string;
  anchor: boolean;
  left: { variant: "A" | "D"; runId?: string };
  right: { variant: "A" | "D"; runId?: string };
  queues: string[]; // reviewer keys this pair was added for
}

const traceIdFor = (run: string, caseId: string) => createHash("sha256").update(`edge-review:${run}:${caseId}`).digest("hex").slice(0, 32);

function reviewers(): Array<{ key: string; userId: string }> {
  const raw = process.env.EDGE_REVIEWER_IDS;
  if (!raw) throw new Error("EDGE_REVIEWER_IDS missing — run tools/langfuse-local/setup-reviewers.sh");
  return raw.split(",").map((kv) => {
    const [key, userId] = kv.split(":");
    if (!key || !userId) throw new Error(`bad EDGE_REVIEWER_IDS entry: ${kv}`);
    return { key, userId };
  });
}

/** Anchor pairs: stratified by category, seeded — never by difficulty (plan: agreement ceiling must be comparable across rounds). */
function pickAnchors(caseIds: string[], n: number, rand: () => number): Set<string> {
  const byCat = new Map<string, string[]>();
  for (const id of caseIds) {
    const cat = QUESTIONS.find((q) => q.id === id)!.category;
    byCat.set(cat, [...(byCat.get(cat) ?? []), id]);
  }
  for (const ids of byCat.values()) for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
  const picked = new Set<string>();
  const cats = [...byCat.keys()].sort();
  let round = 0;
  while (picked.size < Math.min(n, caseIds.length)) {
    for (const c of cats) {
      const list = byCat.get(c)!;
      if (list[round] && picked.size < n) picked.add(list[round]!);
    }
    round++;
    if (round > caseIds.length) break;
  }
  return picked;
}

async function main() {
  if (!isLangfuseConfigured()) throw new Error("Langfuse is not configured (LANGFUSE_PUBLIC_KEY / SECRET_KEY)");
  const cells = readFileSync(join(RUN_DIR, "cells.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Cell).filter((c) => !c.error);
  const caseIds = [...new Set(cells.map((c) => c.case_id))].filter((id) => cells.some((c) => c.case_id === id && c.variant === LEFT_ARM && c.repetition === REP) && cells.some((c) => c.case_id === id && c.variant === RIGHT_ARM && c.repetition === REP)).sort();
  if (!caseIds.length) throw new Error(`no cases with both ${LEFT_ARM} and ${RIGHT_ARM} at rep ${REP}`);
  const revs = reviewers();
  const rand = seededRandom(SEED);
  const anchors = pickAnchors(caseIds, ANCHOR_N, rand);

  // Existing mapping (idempotency) or a fresh one.
  mkdirSync(REVIEW_DIR, { recursive: true });
  const pairsPath = join(REVIEW_DIR, "pairs.json");
  const existing: Pair[] = existsSync(pairsPath) ? (JSON.parse(readFileSync(pairsPath, "utf8")) as { pairs: Pair[] }).pairs : [];
  const pairs: Pair[] = caseIds.map((id, i) => {
    const prior = existing.find((p) => p.case_id === id);
    if (prior) return prior;
    const d = cells.find((c) => c.case_id === id && c.variant === LEFT_ARM && c.repetition === REP)!;
    const a = cells.find((c) => c.case_id === id && c.variant === RIGHT_ARM && c.repetition === REP)!;
    const flip = rand() < 0.5;
    const left = flip ? a : d;
    const right = flip ? d : a;
    return {
      pair_id: `${RUN}-${String(i + 1).padStart(2, "0")}-${id}`,
      trace_id: traceIdFor(RUN, id),
      timestamp: NOW,
      case_id: id,
      category: QUESTIONS.find((q) => q.id === id)!.category,
      anchor: anchors.has(id),
      left: { variant: left.variant as "A" | "D", runId: left.turn2.runId },
      right: { variant: right.variant as "A" | "D", runId: right.turn2.runId },
      queues: [],
    };
  });
  const nonAnchor = pairs.filter((p) => !p.anchor);
  console.log(`[review] ${RUN}: ${pairs.length} pairs (${pairs.filter((p) => p.anchor).length} anchor → all ${revs.length} reviewers; ${nonAnchor.length} split ~${Math.ceil(nonAnchor.length / revs.length)} each)`);
  if (DRY) {
    for (const p of pairs) console.log(`[review]   ${p.pair_id} ${p.anchor ? "ANCHOR" : "      "} left=${p.left.variant} right=${p.right.variant}`);
    return console.log("[review] dry run — nothing sent");
  }

  const lf = getLangfuseClient();
  // 1. Score configs by name.
  const configs = await lf.api.scoreConfigs.get({ limit: 100 });
  const ensureConfig = async (spec: { name: string; description: string; categories: Array<{ label: string; value: number }> }) => {
    const found = configs.data.find((c) => c.name === spec.name);
    if (found) return found.id;
    const created = await lf.api.scoreConfigs.create({ name: spec.name, dataType: "CATEGORICAL", description: spec.description, categories: spec.categories });
    console.log(`[review] created score config ${spec.name}`);
    return created.id;
  };
  const prefId = await ensureConfig(PREFERENCE_CONFIG);
  const reasonId = await ensureConfig(REASON_CONFIG);

  // 2. Blinded pair traces (trace-create is idempotent on id; a re-run overwrites the same trace).
  const questionOf = (id: string) => QUESTIONS.find((q) => q.id === id)!;
  const cellOf = (p: Pair, side: "left" | "right") => cells.find((c) => c.case_id === p.case_id && c.variant === p[side].variant && c.repetition === REP)!;
  type TraceCreate = Parameters<typeof lf.api.ingestion.batch>[0]["batch"][number];
  const events: TraceCreate[] = pairs.map((p) => {
    const q = questionOf(p.case_id);
    const L = cellOf(p, "left");
    const R = cellOf(p, "right");
    const ts = p.timestamp ?? NOW;
    return {
      id: `evt-${p.trace_id}`,
      type: "trace-create" as const,
      timestamp: ts,
      body: {
        id: p.trace_id,
        timestamp: ts,
        name: `edge-review · ${p.case_id}`,
        environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "edge-eval-local",
        tags: ["edge-review", RUN] as string[],
        // Metadata renders in the UI — no variant identity here.
        metadata: { run: RUN, pair_id: p.pair_id, case_id: p.case_id, category: p.category, anchor: p.anchor },
        input: `## Question\n\n${q.text}\n\n## Follow-up\n\n${followupFor(q)}`,
        output: [
          `# Two recommendations — which would you rather the client received?`,
          ``,
          `Both answered the same question and the same follow-up. Score the SUBSTANCE for this client (TwentyOne): is the move right for their stage, does it use their facts, does it apply IF's view, is anything invented? Not polish, not length.`,
          ``,
          `---`,
          `## LEFT`,
          ``,
          `### First response`,
          L.turn1.answer,
          ``,
          `### Recommendation`,
          L.turn2.answer,
          ``,
          `---`,
          `## RIGHT`,
          ``,
          `### First response`,
          R.turn1.answer,
          ``,
          `### Recommendation`,
          R.turn2.answer,
        ].join("\n"),
      },
    };
  });
  const ing = await lf.api.ingestion.batch({ batch: events });
  if (ing.errors?.length) console.warn(`[review] ingestion errors:`, JSON.stringify(ing.errors).slice(0, 500));
  console.log(`[review] ${ing.successes?.length ?? 0} pair traces ingested`);

  // 3. Queues (one per reviewer), assignments, items.
  const queues = await lf.api.annotationQueues.listQueues({ limit: 100 });
  for (let r = 0; r < revs.length; r++) {
    const rev = revs[r]!;
    const name = `edge-review · ${RUN} · ${rev.key}`;
    let queue = queues.data.find((q) => q.name === name);
    if (!queue) {
      queue = await lf.api.annotationQueues.createQueue({ name, description: `Edge Eval ${RUN}: blinded D-vs-A pairs for ${rev.key}. Anchor pairs are shared with the other reviewers.`, scoreConfigIds: [prefId, reasonId] });
      console.log(`[review] created queue ${name}`);
    }
    try {
      await lf.api.annotationQueues.createQueueAssignment(queue.id, { userId: rev.userId });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!/exist|already|409/i.test(msg)) console.warn(`[review] assignment ${rev.key}: ${msg.slice(0, 120)}`);
    }
    const mine = pairs.filter((p) => p.anchor || nonAnchor.indexOf(p) % revs.length === r);
    const existingItems = await lf.api.annotationQueues.listQueueItems(queue.id, { limit: 100 });
    const have = new Set(existingItems.data.map((i) => i.objectId));
    let added = 0;
    for (const p of mine) {
      if (!have.has(p.trace_id)) {
        await lf.api.annotationQueues.createQueueItem(queue.id, { objectId: p.trace_id, objectType: "TRACE" });
        added++;
      }
      if (!p.queues.includes(rev.key)) p.queues.push(rev.key);
    }
    console.log(`[review] queue ${rev.key}: ${mine.length} pairs (${mine.filter((p) => p.anchor).length} anchor), ${added} added, id ${queue.id}`);
  }

  writeFileSync(pairsPath, JSON.stringify({ run: RUN, rep: REP, seed: SEED, left_right_note: "variant behind each side — LOCAL ONLY, never upload", score_configs: { preference: prefId, reason: reasonId }, reviewers: revs.map((r) => r.key), pairs }, null, 2) + "\n");
  console.log(`[review] mapping → ${pairsPath} (keep local)`);
  console.log(`[review] reviewers log in at ${process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com"} → Annotation queues`);
}

main()
  .catch((e) => {
    console.error("[review] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
