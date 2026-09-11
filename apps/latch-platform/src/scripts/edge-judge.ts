/**
 * Edge Eval v0 — Judge v0 over a sweep's cells (plan Step 4).
 *
 *   node --env-file=.env --import tsx src/scripts/edge-judge.ts --run smoke-3 [--judge-model claude-sonnet-5] [--concurrency 4] [--dims decision_quality,grounding]
 *
 * Reads edge-eval-runs/<run>/cells.jsonl, fetches the reference material LIVE through the
 * eval principal's connections (client plane via edge-client_read_file, the category's
 * pillar via edge-v2-kn_read_file — nothing is copied to disk), judges every dimension of
 * every cell with one call each, and writes judgments.jsonl + judge-summary.json. Each
 * dimension also lands on the cell's turn-2 Langfuse trace as a score.
 *
 * Judge model: a different family from the app model (guide line 352). Default
 * claude-sonnet-5; the id must resolve to itself (the catalog falls back silently).
 * Claude 5 models reject `temperature` — none is set. Reference material sits first in the
 * prompt and is marked cacheable so the per-cell cost stays low.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateObject, type LanguageModel } from "ai";
import { isLangfuseConfigured, postScore } from "@intentface/latch-langfuse";
import { getLatch } from "../lib/latch";
import type { Principal } from "../lib/session";
import { CONNECTIONS } from "../evals/edge/variants";
import { byId } from "../evals/edge/cases/questions";
import { followupFor } from "../evals/edge/cases/followup";
import {
  BINARY_DIMENSIONS,
  DETERMINISTIC_HARD_FAILURES,
  DIMENSIONS,
  PILLAR_FOR,
  SCALED_DIMENSIONS,
  cellBlock,
  dimensionSchema,
  referenceBlock,
  type Category,
  type Dimension,
  type DimensionSpec,
  type HardFailure,
} from "../evals/edge/judge/rubric";
import { evalPrincipal } from "./edge-connections";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const RUN = arg("run");
if (!RUN) throw new Error("--run <name> is required");
const RUN_DIR = resolve(`edge-eval-runs/${RUN}`);
const JUDGE_MODEL = arg("judge-model", "claude-sonnet-5")!;
const CONCURRENCY = Number(arg("concurrency", "4"));
const DIMS = arg("dims") ? new Set(arg("dims")!.split(",")) : undefined;
const FORCE = process.argv.includes("--force");

// ── Types shared with the runner's cell record (subset) ──────────────────────
interface Cell {
  run_name: string;
  case_id: string;
  category: Category;
  variant: "A" | "B" | "C" | "D";
  repetition: number;
  prompt_sha8: string;
  model: string;
  thread_id?: string;
  turn1: { runId?: string; answer: string };
  turn2: { runId?: string; answer: string };
  tool_calls: Array<{ tool: string; blocked: boolean; turn: 1 | 2 }>;
  checks: { memory_write_attempted: boolean; leakage: string[] };
  error?: string;
}

export interface Judgment {
  run_name: string;
  case_id: string;
  category: Category;
  variant: Cell["variant"];
  repetition: number;
  judge_model: string;
  judge_version: "v0";
  scores: Partial<Record<(typeof SCALED_DIMENSIONS)[number], number>>;
  passes: Partial<Record<(typeof BINARY_DIMENSIONS)[number], boolean>>;
  hard_failure: HardFailure;
  hard_failures_all: HardFailure[];
  reasons: Partial<Record<Dimension, string>>;
  composite: number; // sum of the four 0–3 dimensions, 0–12
  overall_pass: boolean;
  errors: Partial<Record<Dimension, string>>;
  judged_at: string;
}

// ── Reference material, fetched live once per connection/file ────────────────

type Opened = { tools: Record<string, unknown>; close: () => Promise<void> };
type Executable = { execute?: (input: unknown, opts: { toolCallId: string; messages: unknown[] }) => Promise<unknown> };

function textOf(result: unknown): string {
  // MCP tool results arrive either as the parsed JSON or as { content: [{ type: "text", text }] }.
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text ?? "").join("\n");
  return JSON.stringify(result);
}

/** Strip the `N|` line-number prefixes Loredex read_file returns. */
const stripLineNumbers = (s: string) => s.replace(/^\d+\|/gm, "");

async function readViaConnection(opened: Opened, tool: string, fileId: string): Promise<string> {
  const t = opened.tools[tool] as Executable | undefined;
  if (!t?.execute) throw new Error(`tool ${tool} not available on the opened connection`);
  const raw = textOf(await t.execute({ fileId }, { toolCallId: `judge_${Date.now()}`, messages: [] }));
  // read_file returns { file, content } (or the batch { files: [...] }); keep the content.
  try {
    const parsed = JSON.parse(raw) as { content?: string; files?: Array<{ content?: string }> };
    const content = parsed.content ?? parsed.files?.map((f) => f.content ?? "").join("\n\n");
    if (content) return stripLineNumbers(content);
  } catch {
    /* not JSON — raw text */
  }
  return stripLineNumbers(raw);
}

async function loadReference(principal: Principal, dynamic: { hostFor: (names: string[]) => { open: (p: Principal) => Promise<Opened> } }) {
  const client = await dynamic.hostFor([CONNECTIONS.client]).open(principal);
  const kn = await dynamic.hostFor([CONNECTIONS.kn]).open(principal);
  try {
    const ctxFiles = ["edge/ctx/placement.md", "edge/ctx/strategy.md", "edge/ctx/product.md", "edge/ctx/roadmap.md", "edge/ctx/tech-stack.md"];
    const parts: string[] = [];
    for (const f of ctxFiles) parts.push(`--- ${f} ---\n${await readViaConnection(client, `${CONNECTIONS.client}_read_file`, f)}`);
    const clientContext = parts.join("\n\n");
    const stances: Partial<Record<Category, string>> = {};
    for (const [cat, pillar] of Object.entries(PILLAR_FOR) as Array<[Category, string]>) {
      stances[cat] = await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, `edge-kn/kn/${pillar}/playbook.md`);
    }
    return { clientContext, stances: stances as Record<Category, string> };
  } finally {
    await client.close();
    await kn.close();
  }
}

// ── Judging ──────────────────────────────────────────────────────────────────

const JUDGE_TIMEOUT_MS = 90_000;

async function judgeDimension(model: LanguageModel, reference: string, cell: Cell, dim: DimensionSpec): Promise<{ value: unknown; reason: string }> {
  const q = byId(cell.case_id);
  const tools = cell.tool_calls.map((t) => `${t.tool}${t.blocked ? " (inert)" : ""}`).join(", ");
  const user = cellBlock({ dimension: dim, question: q.text, followup: followupFor(q), turn1: cell.turn1.answer, turn2: cell.turn2.answer, tools });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model,
        schema: dimensionSchema(dim.kind),
        // This SDK version rejects system messages in `messages`; the stable reference
        // block goes first as its own user-content part, marked cacheable (Anthropic
        // provider option) so it is a cache hit across cells of the same category.
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: reference, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
              { type: "text", text: `\n\n${user}` },
            ],
          },
        ],
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      const o = object as { score?: number; pass?: boolean; failure?: string; reason: string };
      return { value: dim.kind === "scaled" ? o.score : dim.kind === "binary" ? o.pass : o.failure, reason: o.reason };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastError);
}

async function judgeCell(model: LanguageModel, references: Record<Category, string>, cell: Cell, dims: DimensionSpec[]): Promise<Judgment> {
  const j: Judgment = {
    run_name: cell.run_name,
    case_id: cell.case_id,
    category: cell.category,
    variant: cell.variant,
    repetition: cell.repetition,
    judge_model: JUDGE_MODEL,
    judge_version: "v0",
    scores: {},
    passes: {},
    hard_failure: "none",
    hard_failures_all: [],
    reasons: {},
    composite: 0,
    overall_pass: false,
    errors: {},
    judged_at: new Date().toISOString(),
  };
  await Promise.all(
    dims.map(async (dim) => {
      try {
        const { value, reason } = await judgeDimension(model, references[cell.category], cell, dim);
        j.reasons[dim.name] = reason;
        if (dim.kind === "scaled") j.scores[dim.name as (typeof SCALED_DIMENSIONS)[number]] = value as number;
        else if (dim.kind === "binary") j.passes[dim.name as (typeof BINARY_DIMENSIONS)[number]] = value as boolean;
        else if (value !== "none") j.hard_failures_all.push(value as HardFailure);
      } catch (e) {
        j.errors[dim.name] = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  // Deterministic hard failures from the runner's checks.
  if (cell.checks.leakage.length) j.hard_failures_all.push("source_or_path_leakage");
  if ((cell.variant === "B" || cell.variant === "D") && !cell.checks.memory_write_attempted) j.hard_failures_all.push("required_memory_write_missing");
  j.hard_failure = j.hard_failures_all[0] ?? "none";
  j.composite = SCALED_DIMENSIONS.reduce((a, d) => a + (j.scores[d] ?? 0), 0);
  const binariesPass = ["grounding", "actionability", "decisiveness"].every((d) => j.passes[d as (typeof BINARY_DIMENSIONS)[number]] === true);
  const scaledOk = SCALED_DIMENSIONS.every((d) => (j.scores[d] ?? 0) >= 2);
  j.overall_pass = binariesPass && scaledOk && j.hard_failure === "none" && Object.keys(j.errors).length === 0;
  return j;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cellsPath = join(RUN_DIR, "cells.jsonl");
  if (!existsSync(cellsPath)) throw new Error(`no cells at ${cellsPath}`);
  const cells = readFileSync(cellsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Cell)
    .filter((c) => !c.error);
  const outPath = join(RUN_DIR, "judgments.jsonl");
  const done = new Set<string>();
  if (existsSync(outPath) && !FORCE) {
    for (const l of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(l) as Judgment;
      done.add(`${j.case_id}|${j.variant}|${j.repetition}`);
    }
  } else if (FORCE) writeFileSync(outPath, "");
  const todo = cells.filter((c) => !done.has(`${c.case_id}|${c.variant}|${c.repetition}`));
  const dims = DIMENSIONS.filter((d) => !DIMS || DIMS.has(d.name));
  console.log(`[judge] ${RUN}: ${cells.length} cells, ${todo.length} to judge × ${dims.length} dims, model ${JUDGE_MODEL}`);

  const principal = await evalPrincipal();
  const { dynamic, modelFor, runtime } = await getLatch();
  const resolved = modelFor(JUDGE_MODEL) as { modelId?: string; provider?: string };
  if (resolved.modelId !== JUDGE_MODEL) throw new Error(`judge model "${JUDGE_MODEL}" resolved to "${resolved.modelId}" — catalog fallback; aborting`);
  if (resolved.provider && /openai/i.test(resolved.provider)) throw new Error(`judge must be a different family from the app model (got ${resolved.provider})`);
  console.log(`[judge] model ${JUDGE_MODEL} → ${resolved.provider}/${resolved.modelId} ✓`);
  const model = modelFor(JUDGE_MODEL);

  console.log(`[judge] fetching reference material live (client plane + 4 pillars)…`);
  const { clientContext, stances } = await loadReference(principal, dynamic as never);
  const references = Object.fromEntries(
    (Object.keys(PILLAR_FOR) as Category[]).map((cat) => [cat, referenceBlock({ clientContext, expertStance: stances[cat], pillar: PILLAR_FOR[cat] })]),
  ) as Record<Category, string>;
  console.log(`[judge] reference: client ${clientContext.length} chars · pillars ${Object.values(stances).map((s) => s.length).join("/")} chars`);

  mkdirSync(RUN_DIR, { recursive: true });
  const results: Judgment[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const cell = todo[next++]!;
      const j = await judgeCell(model, references, cell, dims);
      results.push(j);
      appendFileSync(outPath, JSON.stringify(j) + "\n");
      const errs = Object.keys(j.errors).length ? ` ERR:${Object.keys(j.errors).join(",")}` : "";
      console.log(
        `[judge] ${results.length}/${todo.length} ${cell.case_id} ${cell.variant} r${cell.repetition} · dq ${j.scores.decision_quality ?? "-"} cs ${j.scores.client_specificity ?? "-"} sf ${j.scores.expert_stance_fidelity ?? "-"} sc ${j.scores.stage_calibration ?? "-"} · g${b(j.passes.grounding)} a${b(j.passes.actionability)} d${b(j.passes.decisiveness)} t1${b(j.passes.first_turn_quality)} · hf ${j.hard_failure} · ${j.overall_pass ? "PASS" : "fail"}${errs}`,
      );
      if (isLangfuseConfigured()) await postScores(runtime, principal, cell, j).catch((e) => console.warn(`[judge] langfuse: ${(e as Error).message}`));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, todo.length)) }, worker));

  // Summary over ALL judgments in the file (previous + this run).
  const all = readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Judgment);
  const byVariant = Object.fromEntries(
    (["A", "B", "C", "D"] as const).map((v) => {
      const js = all.filter((j) => j.variant === v);
      const mean = (f: (j: Judgment) => number) => (js.length ? +(js.reduce((a, j) => a + f(j), 0) / js.length).toFixed(2) : null);
      return [
        v,
        js.length
          ? {
              cells: js.length,
              composite: mean((j) => j.composite),
              ...Object.fromEntries(SCALED_DIMENSIONS.map((d) => [d, mean((j) => j.scores[d] ?? 0)])),
              ...Object.fromEntries(BINARY_DIMENSIONS.map((d) => [`${d}_rate`, mean((j) => (j.passes[d] ? 1 : 0))])),
              overall_pass_rate: mean((j) => (j.overall_pass ? 1 : 0)),
              hard_failures: Object.fromEntries(
                [...new Set(js.flatMap((j) => j.hard_failures_all))].map((h) => [h, js.filter((j) => j.hard_failures_all.includes(h)).length]),
              ),
            }
          : null,
      ];
    }),
  );
  const summary = { run_name: RUN, judge_model: JUDGE_MODEL, judge_version: "v0", judged: all.length, by_variant: byVariant, deterministic_hard_failures: DETERMINISTIC_HARD_FAILURES };
  writeFileSync(join(RUN_DIR, "judge-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`[judge] done · ${all.length} judgments · ${join(RUN_DIR, "judge-summary.json")}`);
}

const b = (v: boolean | undefined) => (v === undefined ? "?" : v ? "✓" : "✗");

async function postScores(runtime: Awaited<ReturnType<typeof getLatch>>["runtime"], principal: Principal, cell: Cell, j: Judgment) {
  const runId = cell.turn2.runId;
  if (!runId) return;
  const run = await runtime.getRun({ principal, runId });
  const timestamp = run?.startedAt;
  const meta = { case_id: cell.case_id, variant: cell.variant, repetition: String(cell.repetition), judge_model: JUDGE_MODEL, judge_version: "v0" };
  for (const d of SCALED_DIMENSIONS) if (j.scores[d] !== undefined) await postScore({ runId, name: `edge_${d}`, value: j.scores[d]!, dataType: "NUMERIC", comment: j.reasons[d], metadata: meta, timestamp });
  for (const d of BINARY_DIMENSIONS) if (j.passes[d] !== undefined) await postScore({ runId, name: `edge_${d}`, value: j.passes[d] ? 1 : 0, dataType: "BOOLEAN", comment: j.reasons[d], metadata: meta, timestamp });
  await postScore({ runId, name: "edge_hard_failure", value: j.hard_failure === "none" ? 0 : 1, dataType: "BOOLEAN", comment: `${j.hard_failures_all.join(", ") || "none"} — ${j.reasons.hard_failure ?? ""}`, metadata: meta, timestamp });
  await postScore({ runId, name: "edge_composite", value: j.composite, dataType: "NUMERIC", metadata: meta, timestamp });
  await postScore({ runId, name: "edge_overall_pass", value: j.overall_pass ? 1 : 0, dataType: "BOOLEAN", metadata: meta, timestamp });
}

main()
  .catch((e) => {
    console.error("[judge] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
