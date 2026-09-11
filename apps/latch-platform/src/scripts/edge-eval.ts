/**
 * Edge Eval v0 — the batch runner (plan Step 3).
 *
 * Per (case × variant × repetition): turn 1 = the question, turn 2 = the canned follow-up on
 * the same thread; every gated tool is stubbed (`blockGated: true`) so writes are PRESENT
 * in the transcript but inert. One wide event per cell → `cells.jsonl`, one Markdown
 * transcript per cell, a `summary.json`. Cohort dimensions land on the Langfuse trace of
 * each run as a categorical score (`edge_cell`) carrying case / variant / rep / prompt sha.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-eval.ts --name smoke --variants A,D --cases INFRA-02,AX-01,CODE-03 --reps 1
 *   node --env-file=.env --import tsx src/scripts/edge-eval.ts --name pilot --variants A,D --cases all --reps 1 --concurrency 3
 *   node --env-file=.env --import tsx src/scripts/edge-eval.ts --name v0 --variants A,AP,B,C,D --cases optimization --reps 3
 *
 * Pre-sweep assertions (all fatal): the model id resolves to itself (the catalog falls
 * back silently otherwise), every connection a selected arm needs is authorized and
 * exposes the expected tool surface, BOTH context planes hash to their committed manifests
 * (horizontal over REST, vertical through the read-only edge-v2-kn scope), and the arm
 * records upsert cleanly. Post-sweep: both plane hashes are re-checked.
 *
 * Arm A′ (`AP`) additionally needs a CLIENT CARD: a fixed 5–6 sentence paragraph built once
 * at sweep start from the live client plane (src/evals/edge/client-card.ts), cached in the
 * run directory so `--resume` continues with the identical card, and prefixed to every
 * turn-1 question of that arm. It is never written to the repo.
 *
 * Output dir: apps/latch-platform/edge-eval-runs/<name>/ (gitignored).
 */
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAgentRecord } from "@intentface/latch-agent-builder";
import { isLangfuseConfigured, postScore } from "@intentface/latch-langfuse";
import { getLatch } from "../lib/latch";
import type { Principal } from "../lib/session";
import { extractToolCalls } from "../lib/evals/run";
import { ARMS, buildVariant, CARD_ARMS, CONNECTIONS, CONNECTIONS_FOR, EDGE_EVAL_MODEL, isArm, WRITE_TOOLS, type Arm, type EdgeVariant } from "../evals/edge/variants";
import { buildClientCard, withClientCard, type ClientCard } from "../evals/edge/client-card";
import { QUESTIONS, byId, type Question } from "../evals/edge/cases/questions";
import { followupFor } from "../evals/edge/cases/followup";
import { checkSurface, evalPrincipal } from "./edge-connections";
import { planeVersion, readLivePlane, readManifest } from "./edge-plane-snapshot";
import { readVerticalManifest, verticalPlaneVersion } from "./edge-vertical-snapshot";
import type { Dynamic } from "../evals/edge/judge/reference";

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN_NAME = arg("name") ?? `run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const VARIANT_ARG = (arg("variants", "A,D") ?? "A,D").split(",").map((v) => v.trim().toUpperCase()) as Arm[];
const CASES_ARG = arg("cases", "all") ?? "all";
const REPS = Number(arg("reps", "1"));
const CONCURRENCY = Number(arg("concurrency", "2"));
const ALLOW_DRIFT = flag("allow-drift");
const DRY_RUN = flag("dry-run");
// --resume: skip cells already present in <out>/cells.jsonl (a killed sweep picks up where it stopped).
const RESUME = flag("resume");
const MAX_ATTEMPTS = Number(arg("attempts", "3"));
// The pilot runs on a cheaper sibling (gpt-5.6-luna) to rank questions by spread without
// coupling the selection to Sol's own noise; the benchmark itself stays on EDGE_EVAL_MODEL.
const MODEL = arg("model", EDGE_EVAL_MODEL) ?? EDGE_EVAL_MODEL;
// The A′ card is written by the judge family, not the app model — a baseline should not be
// primed by the model under test. Overridable; `--client-card <file>` pins an existing card.
const CARD_MODEL = arg("card-model", "claude-sonnet-5")!;
const CARD_FILE = arg("client-card");
const OUT_DIR = resolve(arg("out") ?? `edge-eval-runs/${RUN_NAME}`);

for (const v of VARIANT_ARG) if (!isArm(v)) throw new Error(`unknown arm ${v} — one of ${ARMS.join(",")}`);

function selectCases(spec: string): Question[] {
  const holdout = readHoldout();
  if (spec === "all") return [...QUESTIONS];
  if (spec === "client-team") return QUESTIONS.filter((q) => q.register === "client-team");
  if (spec === "holdout") return holdout.map(byId);
  if (spec === "optimization") return QUESTIONS.filter((q) => q.register === "client-team" && !holdout.includes(q.id));
  return spec.split(",").map((id) => byId(id.trim()));
}
function readHoldout(): string[] {
  const p = new URL("../evals/edge/cases/holdout.json", import.meta.url);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { holdout: string[] }).holdout : [];
}

// ── Cell record (the wide event) ─────────────────────────────────────────────

interface ToolCallRecord {
  tool: string;
  blocked: boolean;
  turn: 1 | 2;
}
interface TurnRecord {
  runId?: string;
  answer: string;
  answerChars: number;
  latencyMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  cost?: number;
  toolsHash?: string;
  status?: string;
  error?: string;
}
interface CellRecord {
  run_name: string;
  edge_version: "v0";
  case_id: string;
  category: string;
  register: string;
  split: "holdout" | "optimization" | "end-user";
  variant: Arm;
  repetition: number;
  agent: string;
  prompt_sha8: string;
  model: string;
  horizontal_ctx_version: string;
  vertical_ctx_version?: string;
  /** A′ only: the sha8 of the client card prefixed to turn 1 (identical across all its cells). */
  client_card_sha8?: string;
  thread_id?: string;
  turn1: TurnRecord;
  turn2: TurnRecord;
  tool_calls: ToolCallRecord[];
  checks: {
    memory_write_attempted: boolean; // edge-client_edit_file or _create seen
    gap_write_attempted: boolean; // edge-v2-inbox_create seen
    context_correction_attempted: boolean; // edge-client_edit_file on a ctx file (heuristic: any edit_file counts; memory vs ctx needs args)
    unblocked_write: string[]; // any write tool that was NOT stubbed — must be empty
    kn_write_attempted: string[]; // any edge-v2-kn_<write> — must be empty
    leakage: string[]; // internal strings in the client-facing turn-2 answer
    first_turn_short: boolean; // turn 1 ≤ 5 sentences (rough)
    tool_calls_total: number;
  };
  started_at: string;
  ended_at: string;
  error?: string;
}

const LEAKAGE_PATTERNS: Array<[string, RegExp]> = [
  ["connection-name", /\bedge-(client|v2-kn|v2-inbox|kn|inbox)\b/],
  ["file-id", /\bfile_[A-Za-z0-9_-]{8,}/],
  ["folder-id", /\bfld_[A-Za-z0-9_-]{8,}/],
  ["path", /\bedge\/(ctx|memory|kn|examples|inbox)\b/],
  ["md-extension", /\b\w+\.md\b/],
  ["playbook", /\bplaybook\b/i],
  ["catalog", /\bcatalog\b/i],
  ["tool-name", /\b(orient|read_file|edit_file|write_db)\b/],
  ["see-ref", /\(see\s/i],
];

const sentenceCount = (s: string) => (s.match(/[.!?](\s|$)/g) ?? []).length;

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const principal: Principal = await evalPrincipal();
  const cases = selectCases(CASES_ARG);
  const holdout = new Set(readHoldout());
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[eval] ${RUN_NAME}: ${cases.length} cases × ${VARIANT_ARG.join("")} × ${REPS} reps = ${cases.length * VARIANT_ARG.length * REPS} cells → ${OUT_DIR}`);

  const latch = await getLatch();
  const { agentStore, runtime, dynamic, modelFor } = latch;

  // 1. Model resolves to itself (catalog falls back to the default model on unknown ids).
  const resolved = modelFor(MODEL) as { modelId?: string; provider?: string };
  if (resolved.modelId !== MODEL) {
    throw new Error(`model "${MODEL}" resolved to "${resolved.modelId}" (${resolved.provider}) — catalog fallback; aborting`);
  }
  console.log(`[eval] model ${MODEL} → ${resolved.provider}/${resolved.modelId} ✓${MODEL !== EDGE_EVAL_MODEL ? "  (NOT the benchmark model — pilot/selection only)" : ""}`);

  // 2. Connections: authorized + expected surface, for every connection a selected variant needs.
  const needed = new Set(VARIANT_ARG.flatMap((v) => CONNECTIONS_FOR[v]));
  if (needed.size) {
    const status = await dynamic.status(principal);
    for (const name of needed) {
      const st = status.find((c) => c.name === name);
      if (!st?.authorized) {
        const msg = `connection ${name} is not authorized for the eval principal — run edge-connections.ts`;
        if (DRY_RUN) {
          console.warn(`[eval] WARNING ${msg}`);
          continue;
        }
        throw new Error(msg);
      }
      const tools = await dynamic.testTools(name, principal);
      const problems = checkSurface(name, tools);
      if (problems.length) throw new Error(`connection ${name} surface: ${problems.join("; ")}`);
      console.log(`[eval] connection ${name}: ${tools.length} tools ✓`);
    }
  }

  // 3. Client plane matches the committed manifest.
  const manifest = readManifest();
  if (!manifest) throw new Error("no client-plane manifest — run edge-plane-snapshot.ts");
  const planeBefore = planeVersion((await readLivePlane()).files.map((f) => [f.path, f.content]));
  if (planeBefore !== manifest.horizontal_ctx_version) {
    const msg = `client plane drifted: live ${planeBefore.slice(0, 16)} ≠ manifest ${manifest.horizontal_ctx_version.slice(0, 16)}`;
    if (!ALLOW_DRIFT) throw new Error(`${msg} — re-snapshot or pass --allow-drift`);
    console.warn(`[eval] WARNING ${msg}`);
  } else console.log(`[eval] client plane ${planeBefore.slice(0, 16)} ✓`);

  // 3b. Vertical (knowledge) plane — hashed through the read-only scope the arms read it by.
  // Every arm is graded against IF's stances, so the sweep records which stances those were
  // even when no selected arm holds the connection; it is skipped only if the eval principal
  // has no kn grant at all.
  const verticalManifest = readVerticalManifest();
  let verticalBefore: string | undefined;
  try {
    verticalBefore = (await verticalPlaneVersion(dynamic as unknown as Dynamic, principal)).version;
  } catch (e) {
    const msg = `vertical plane unreadable: ${(e as Error).message}`;
    if (!ALLOW_DRIFT) throw new Error(`${msg} — authorize ${CONNECTIONS.kn} or pass --allow-drift`);
    console.warn(`[eval] WARNING ${msg}`);
  }
  if (verticalBefore) {
    if (!verticalManifest) throw new Error("no vertical-plane manifest — run edge-vertical-snapshot.ts");
    if (verticalBefore !== verticalManifest.vertical_ctx_version) {
      const msg = `knowledge plane drifted: live ${verticalBefore.slice(0, 16)} ≠ manifest ${verticalManifest.vertical_ctx_version.slice(0, 16)}`;
      if (!ALLOW_DRIFT) throw new Error(`${msg} — re-snapshot (edge-vertical-snapshot.ts) or pass --allow-drift`);
      console.warn(`[eval] WARNING ${msg}`);
    } else console.log(`[eval] knowledge plane ${verticalBefore.slice(0, 16)} ✓`);
  }

  // 4. Upsert the variant records (validated + normalized — upsert itself does not validate).
  const variants: Record<string, EdgeVariant> = {};
  for (const v of VARIANT_ARG) {
    const built = buildVariant(v);
    const rec = parseAgentRecord({ ...built.record, modelId: MODEL });
    if (!DRY_RUN) await agentStore.upsert(principal, rec);
    variants[v] = built;
    console.log(`[eval] agent ${built.name} prompt:${built.promptSha8} connections=[${rec.connections.join(",")}] ${DRY_RUN ? "(dry-run, not upserted)" : "✓"}`);
  }
  // 4b. The A′ client card: built once, cached in the run dir, identical for every case.
  let card: ClientCard | undefined;
  if (VARIANT_ARG.some((v) => CARD_ARMS.includes(v))) {
    const cardPath = CARD_FILE ? resolve(CARD_FILE) : join(OUT_DIR, "client-card.json");
    if (existsSync(cardPath)) {
      card = JSON.parse(readFileSync(cardPath, "utf8")) as ClientCard;
      console.log(`[eval] client card ${card.sha8} reused from ${cardPath} (${card.text.length} chars, by ${card.writer_model})`);
    } else {
      const cardModel = modelFor(CARD_MODEL) as { modelId?: string };
      if (cardModel.modelId !== CARD_MODEL) throw new Error(`card model "${CARD_MODEL}" resolved to "${cardModel.modelId}" — catalog fallback; aborting`);
      const client = await dynamic.hostFor([CONNECTIONS.client]).open(principal);
      try {
        card = await buildClientCard(client, modelFor(CARD_MODEL), CARD_MODEL);
      } finally {
        await client.close();
      }
      writeFileSync(cardPath, JSON.stringify(card, null, 2) + "\n");
      console.log(`[eval] client card ${card.sha8} built by ${CARD_MODEL} → ${cardPath}`);
    }
    console.log(`[eval] card: ${card.text.replace(/\s+/g, " ")}`);
  }

  if (DRY_RUN) return console.log("[eval] dry-run: stopping before any model call");

  // 5. Cells.
  const cellsPath = join(OUT_DIR, "cells.jsonl");
  const prior: CellRecord[] = RESUME && existsSync(cellsPath)
    ? readFileSync(cellsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CellRecord).filter((c) => !c.error)
    : [];
  if (!RESUME && existsSync(cellsPath)) throw new Error(`${cellsPath} exists — pass --resume to continue it or pick another --name`);
  const doneKeys = new Set(prior.map((c) => `${c.case_id}|${c.variant}|${c.repetition}`));
  const plan: Array<{ q: Question; v: Arm; rep: number }> = [];
  for (const q of cases) for (const v of VARIANT_ARG) for (let rep = 1; rep <= REPS; rep++) {
    if (!doneKeys.has(`${q.id}|${v}|${rep}`)) plan.push({ q, v, rep });
  }
  if (RESUME) console.log(`[eval] resume: ${prior.length} cells already done, ${plan.length} to go`);

  const records: CellRecord[] = [...prior];
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const { q, v, rep } = plan[next++]!;
      const rec = await runCell({ q, v, rep, variant: variants[v]!, principal, runtime, planeBefore, verticalBefore, card, holdout });
      records.push(rec);
      appendFileSync(cellsPath, JSON.stringify(rec) + "\n");
      writeFileSync(join(OUT_DIR, `${q.id}__${v}__r${rep}.md`), renderTranscript(rec, q, card));
      const flags = [
        rec.error ? "ERROR" : "",
        rec.checks.unblocked_write.length ? "UNBLOCKED-WRITE" : "",
        rec.checks.leakage.length ? `leak:${rec.checks.leakage.join("+")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `[eval] ${records.length}/${plan.length + prior.length} ${q.id} ${v} r${rep} · t1 ${rec.turn1.answerChars}ch t2 ${rec.turn2.answerChars}ch · tools ${rec.checks.tool_calls_total} · mem=${rec.checks.memory_write_attempted ? "y" : "n"} gap=${rec.checks.gap_write_attempted ? "y" : "n"} · ${((rec.turn1.latencyMs ?? 0) + (rec.turn2.latencyMs ?? 0)) / 1000}s ${flags}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, plan.length)) }, worker));

  // 6. Post-sweep: both planes unchanged.
  const planeAfter = planeVersion((await readLivePlane()).files.map((f) => [f.path, f.content]));
  const planeUnchanged = planeAfter === planeBefore;
  if (!planeUnchanged) console.error(`[eval] ✗ client plane CHANGED during the sweep: ${planeBefore.slice(0, 16)} → ${planeAfter.slice(0, 16)}`);
  let verticalAfter: string | undefined;
  if (verticalBefore) {
    verticalAfter = await verticalPlaneVersion(dynamic as unknown as Dynamic, principal).then((r) => r.version).catch((e) => {
      console.warn(`[eval] knowledge plane re-hash failed: ${(e as Error).message}`);
      return undefined;
    });
    if (verticalAfter && verticalAfter !== verticalBefore) console.error(`[eval] ✗ knowledge plane CHANGED during the sweep: ${verticalBefore.slice(0, 16)} → ${verticalAfter.slice(0, 16)}`);
  }
  const verticalUnchanged = !verticalBefore || verticalAfter === verticalBefore;

  const summary = {
    run_name: RUN_NAME,
    edge_version: "v0",
    started_at: new Date(t0).toISOString(),
    ended_at: new Date().toISOString(),
    model: MODEL,
    benchmark_model: EDGE_EVAL_MODEL,
    arms: VARIANT_ARG,
    variants: Object.fromEntries(Object.values(variants).map((x) => [x.variant, { agent: x.name, prompt_sha8: x.promptSha8, connections: CONNECTIONS_FOR[x.variant], client_card: CARD_ARMS.includes(x.variant) }])),
    client_card: card ? { sha8: card.sha8, writer_model: card.writer_model, chars: card.text.length, sources: card.sources, built_at: card.built_at, text: card.text } : null,
    cases: cases.map((q) => q.id),
    reps: REPS,
    cells: records.length,
    errors: records.filter((r) => r.error).length,
    unblocked_writes: records.filter((r) => r.checks.unblocked_write.length).length,
    horizontal_ctx_version: { before: planeBefore, after: planeAfter, unchanged: planeUnchanged },
    vertical_ctx_version: verticalBefore
      ? { before: verticalBefore, after: verticalAfter ?? null, unchanged: verticalUnchanged, matches_manifest: verticalBefore === verticalManifest?.vertical_ctx_version, manifest_captured_at: verticalManifest?.capturedAt ?? null }
      : null,
    by_variant: Object.fromEntries(
      VARIANT_ARG.map((v) => {
        const rs = records.filter((r) => r.variant === v && !r.error);
        const mean = (f: (r: CellRecord) => number) => (rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : 0);
        return [
          v,
          {
            cells: rs.length,
            memory_write_rate: mean((r) => (r.checks.memory_write_attempted ? 1 : 0)),
            gap_write_rate: mean((r) => (r.checks.gap_write_attempted ? 1 : 0)),
            leakage_rate: mean((r) => (r.checks.leakage.length ? 1 : 0)),
            first_turn_short_rate: mean((r) => (r.checks.first_turn_short ? 1 : 0)),
            mean_tool_calls: mean((r) => r.checks.tool_calls_total),
            mean_turn2_chars: mean((r) => r.turn2.answerChars),
            mean_latency_ms: mean((r) => (r.turn1.latencyMs ?? 0) + (r.turn2.latencyMs ?? 0)),
            total_cost: rs.reduce((a, r) => a + (r.turn1.cost ?? 0) + (r.turn2.cost ?? 0), 0),
          },
        ];
      }),
    ),
  };
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`[eval] done in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${records.length} cells · ${summary.errors} errors · client plane ${planeUnchanged ? "unchanged ✓" : "CHANGED ✗"} · knowledge plane ${!verticalBefore ? "not hashed" : verticalUnchanged ? "unchanged ✓" : "CHANGED ✗"} · ${OUT_DIR}/summary.json`);
  if (!planeUnchanged || !verticalUnchanged || summary.unblocked_writes) process.exitCode = 1;
}

// ── One cell ─────────────────────────────────────────────────────────────────

type Runtime = Awaited<ReturnType<typeof getLatch>>["runtime"];

async function runCell(args: {
  q: Question;
  v: Arm;
  rep: number;
  variant: EdgeVariant;
  principal: Principal;
  runtime: Runtime;
  planeBefore: string;
  verticalBefore?: string;
  card?: ClientCard;
  holdout: Set<string>;
}): Promise<CellRecord> {
  const { q, v, rep, variant, principal, runtime } = args;
  const started = new Date();
  const cell: CellRecord = {
    run_name: RUN_NAME,
    edge_version: "v0",
    case_id: q.id,
    category: q.category,
    register: q.register,
    split: q.register === "end-user" ? "end-user" : args.holdout.has(q.id) ? "holdout" : "optimization",
    variant: v,
    repetition: rep,
    agent: variant.name,
    prompt_sha8: variant.promptSha8,
    model: MODEL,
    horizontal_ctx_version: args.planeBefore,
    ...(args.verticalBefore ? { vertical_ctx_version: args.verticalBefore } : {}),
    ...(CARD_ARMS.includes(v) && args.card ? { client_card_sha8: args.card.sha8 } : {}),
    turn1: { answer: "", answerChars: 0 },
    turn2: { answer: "", answerChars: 0 },
    tool_calls: [],
    checks: {
      memory_write_attempted: false,
      gap_write_attempted: false,
      context_correction_attempted: false,
      unblocked_write: [],
      kn_write_attempted: [],
      leakage: [],
      first_turn_short: false,
      tool_calls_total: 0,
    },
    started_at: started.toISOString(),
    ended_at: "",
  };

  try {
    // Turn 1 — the question. Turn 2 — the canned follow-up on the SAME thread (serialized:
    // one active run per chat is a storage invariant). A transient provider failure on
    // either turn restarts the CELL on a fresh thread (up to MAX_ATTEMPTS) — a thread whose
    // turn 1 errored must not be continued, the cell would be invalid.
    // A′ is the only arm whose turn-1 prompt is not the bare question: the fixed client card
    // goes in front of it. Turn 2 is the same canned follow-up for every arm — the card is
    // already in the thread.
    const turn1Prompt = CARD_ARMS.includes(v) && args.card ? withClientCard(args.card.text, q.text) : q.text;
    if (CARD_ARMS.includes(v) && !args.card) throw new Error(`arm ${v} needs a client card but none was built`);
    let t1!: Awaited<ReturnType<typeof runTurn>>;
    let t2!: Awaited<ReturnType<typeof runTurn>>;
    for (let attempt = 1; ; attempt++) {
      try {
        t1 = await runTurn(runtime, principal, variant.name, turn1Prompt, undefined);
        t2 = await runTurn(runtime, principal, variant.name, followupFor(q), t1.threadId, new Set(t1.turn.runId ? [t1.turn.runId] : []));
        break;
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS || !isTransient(e)) throw e;
        console.warn(`[eval] ${q.id} ${v} r${rep}: attempt ${attempt} failed (${(e as Error).message.slice(0, 120)}) — retrying on a fresh thread in ${attempt * 20}s`);
        await sleep(attempt * 20_000);
      }
    }
    cell.thread_id = t1.threadId;
    cell.turn1 = t1.turn;
    cell.turn2 = t2.turn;

    // Tool calls, attributed to turns by run id on the assistant messages.
    const history = await runtime.loadHistory({ chatId: t1.threadId, principal });
    for (const m of history as Array<{ role: string; parts?: unknown[]; metadata?: { runId?: string } }>) {
      if (m.role !== "assistant") continue;
      const turn: 1 | 2 = m.metadata?.runId === t2.turn.runId ? 2 : 1;
      for (const c of extractToolCalls([m])) cell.tool_calls.push({ tool: c.tool, blocked: c.blocked === true, turn });
    }
    const isWrite = (tool: string) => WRITE_TOOLS.some((w) => tool.endsWith(`_${w}`));
    cell.checks.tool_calls_total = cell.tool_calls.length;
    cell.checks.memory_write_attempted = cell.tool_calls.some((c) => c.tool === `${CONNECTIONS.client}_edit_file` || c.tool === `${CONNECTIONS.client}_create`);
    cell.checks.context_correction_attempted = cell.tool_calls.some((c) => c.tool === `${CONNECTIONS.client}_edit_file`);
    cell.checks.gap_write_attempted = cell.tool_calls.some((c) => c.tool === `${CONNECTIONS.inbox}_create`);
    cell.checks.unblocked_write = cell.tool_calls.filter((c) => isWrite(c.tool) && !c.blocked).map((c) => c.tool);
    cell.checks.kn_write_attempted = cell.tool_calls.filter((c) => c.tool.startsWith(`${CONNECTIONS.kn}_`) && isWrite(c.tool)).map((c) => c.tool);
    cell.checks.leakage = LEAKAGE_PATTERNS.filter(([, re]) => re.test(cell.turn2.answer) || re.test(cell.turn1.answer)).map(([k]) => k);
    cell.checks.first_turn_short = sentenceCount(cell.turn1.answer) <= 5;

    // Cohort dimensions onto both runs' Langfuse traces (deterministic ids; idempotent by startedAt).
    if (isLangfuseConfigured()) {
      for (const [turn, t] of [[1, t1.turn], [2, t2.turn]] as const) {
        if (!t.runId || !t.startedAt) continue;
        await postScore({
          runId: t.runId,
          name: "edge_cell",
          value: turn,
          dataType: "NUMERIC",
          timestamp: t.startedAt,
          comment: `${RUN_NAME} ${q.id} ${v} r${rep} turn ${turn}`,
          metadata: { run_name: RUN_NAME, case_id: q.id, category: q.category, variant: v, repetition: String(rep), turn: String(turn), prompt_sha8: variant.promptSha8, edge_version: "v0", split: cell.split },
        }).catch((e) => console.warn(`[eval] langfuse score failed for ${t.runId}: ${(e as Error).message}`));
      }
    }
  } catch (e) {
    cell.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  cell.ended_at = new Date().toISOString();
  return cell;
}

class TurnFailed extends Error {
  constructor(message: string, public readonly runStatus: string) {
    super(message);
    this.name = "TurnFailed";
  }
}

/** Provider-side transient failures worth a retry on a fresh thread. */
// Drizzle wraps libsql errors as "Failed query: <sql>" and drops the SQLITE_BUSY cause, so a
// storage write failure is treated as transient too — it is always environmental for a
// cell (a lock on the shared local DB), never a property of the answer.
const isTransient = (e: unknown) =>
  /overloaded|rate limit|429|timeout|ECONNRESET|503|502|temporarily|SQLITE_BUSY|database is locked|Failed query/i.test(String((e as Error)?.message ?? e));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTurn(
  runtime: Runtime,
  principal: Principal,
  agent: string,
  prompt: string,
  threadId: string | undefined,
  priorRunIds: ReadonlySet<string> = new Set(),
): Promise<{ threadId: string; turn: TurnRecord & { startedAt?: number } }> {
  const t0 = Date.now();
  // "simulate-success": gated writes are still stubbed (inert) but look successful to the
  // agent, as they would in production once the human approves. A "blocked" result makes
  // edge-v2 tell the client its note failed and skip the gap write (seen in smoke-2).
  const { threadId: tid, answer } = await runtime.runAgent({ principal, agent, prompt, threadId, blockGated: "simulate-success" });
  const history = await runtime.loadHistory({ chatId: tid, principal });
  const last = [...history].reverse().find((m) => (m as { role: string }).role === "assistant") as
    | { metadata?: { runId?: string; model?: string; usage?: TurnRecord["usage"]; cost?: number } }
    | undefined;
  let runId = last?.metadata?.runId;
  // A turn that produced no assistant message (provider error after retries) leaves no
  // NEW runId on the history: for turn 1 there is none at all; for turn 2 the last
  // assistant message is still turn 1's and `runAgent` hands back turn 1's answer
  // (smoke-3 CODE-03 A: identical answers, identical runId). Either way, find the
  // failed run row by chat so the failure is recorded rather than passed on.
  if (!runId || priorRunIds.has(runId)) {
    runId = undefined;
    const recent = await runtime.listRuns({ principal, limit: 50 });
    const own = recent.filter((r) => r.chatId === tid).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (own) {
      const err = own.error ?? `run ${own.id} ${own.status} with no new assistant message`;
      throw new TurnFailed(err, own.status);
    }
    throw new TurnFailed("turn produced no assistant message and no run row", "unknown");
  }
  const turn: TurnRecord & { startedAt?: number } = { runId, answer, answerChars: answer.length, latencyMs: Date.now() - t0 };
  if (runId) {
    const run = await runtime.getRun({ principal, runId });
    if (run?.status === "errored") throw new TurnFailed(run.error ?? `run ${run.id} errored`, run.status);
    if (run) {
      turn.usage = {
        inputTokens: run.usageInputTokens,
        outputTokens: run.usageOutputTokens,
        cacheReadTokens: run.usageCacheReadTokens,
        cacheWriteTokens: run.usageCacheWriteTokens,
      };
      turn.cost = run.costTotal ?? undefined;
      turn.toolsHash = run.toolsHash ?? undefined;
      turn.status = run.status;
      turn.startedAt = run.startedAt;
      if (run.startedAt && run.endedAt) turn.latencyMs = run.endedAt - run.startedAt;
      if (run.error) turn.error = run.error;
    }
  }
  return { threadId: tid, turn };
}

function renderTranscript(c: CellRecord, q: Question, card?: ClientCard): string {
  const calls = (turn: 1 | 2) =>
    c.tool_calls.filter((t) => t.turn === turn).map((t) => `- \`${t.tool}\`${t.blocked ? " (blocked → inert)" : ""}`).join("\n") || "- (none)";
  return `# ${c.case_id} · variant ${c.variant} · rep ${c.repetition}

| | |
|---|---|
| run | ${c.run_name} |
| agent | ${c.agent} (prompt:${c.prompt_sha8}, ${c.model}) |
| split | ${c.split} · ${c.category} · ${q.author} |
| thread | ${c.thread_id ?? "-"} |
| runs | t1 ${c.turn1.runId ?? "-"} · t2 ${c.turn2.runId ?? "-"} |
| latency | t1 ${c.turn1.latencyMs ?? "-"}ms · t2 ${c.turn2.latencyMs ?? "-"}ms |
| tokens | t1 in ${c.turn1.usage?.inputTokens ?? "-"} / out ${c.turn1.usage?.outputTokens ?? "-"} · t2 in ${c.turn2.usage?.inputTokens ?? "-"} / out ${c.turn2.usage?.outputTokens ?? "-"} |
| card | ${c.client_card_sha8 ? `client card ${c.client_card_sha8} prefixed to turn 1` : "-"} |
| checks | memory_write=${c.checks.memory_write_attempted} gap_write=${c.checks.gap_write_attempted} unblocked=${c.checks.unblocked_write.join(",") || "none"} kn_write=${c.checks.kn_write_attempted.join(",") || "none"} leakage=${c.checks.leakage.join(",") || "none"} first_turn_short=${c.checks.first_turn_short} |
${c.error ? `| **error** | ${c.error} |\n` : ""}
## Turn 1 — question${c.client_card_sha8 ? " (prefixed with the client card)" : ""}

${c.client_card_sha8 && card ? `> _Background on us, for context:_ ${card.text.replace(/\n+/g, " ")}\n>\n` : ""}> ${q.text}

### Tool calls
${calls(1)}

### Answer
${c.turn1.answer}

## Turn 2 — follow-up

> ${followupFor(q)}

### Tool calls
${calls(2)}

### Answer
${c.turn2.answer}
`;
}

main()
  .catch((e) => {
    console.error("[eval] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
