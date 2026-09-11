/**
 * Edge Eval v0 — the ablation arms as agent RECORDS.
 *
 * Why records (upserted under the eval principal by the runner) rather than
 * code-declared agents in `src/agents/index.ts`:
 *  - production edge-v2 IS a record; D must equal it modulo the listed edits, and a
 *    record carries the same `tools.approval` map, `maxSteps`, `modelId` string;
 *  - `modelId` resolves through the same catalog production uses (`gpt-5.6-sol`
 *    → OpenAI by id prefix — the runner asserts the resolution, since an unknown
 *    id silently falls back to the default model);
 *  - no dev-server restart per prompt edit, and `prompt:<sha8>` is computed from
 *    the composed text so a change to D is a new cohort automatically.
 *
 * Held constant across arms (guide 233-242 + user decisions 2026-09-10): model,
 * maxSteps 20 (production), no web tools (production has none; the eval docs are
 * silent), no `exec.memory` (production has it on — a second, non-resettable Tier 3;
 * off in all arms so cells stay independent), identical sampling (provider default).
 *
 * Variant boundary is real at BOTH layers (impl notes 231-236): connections
 * (this file) and instructions (edge-v2.prompt.md selection). A′ (`AP`) is the one arm
 * that differs at neither — see ARMS below.
 */
import { readFileSync } from "node:fs";
import type { AgentRecordInput } from "@intentface/latch-agent-builder";
import { composeInstructions, promptSha8, type Variant } from "./prompt/compose";

/** The captured production record (src/evals/edge/v0/edge-v2-record.json). */
interface CapturedRecord {
  record: { modelId: string; maxSteps: number; connections: string[]; tools: { approval: Record<string, boolean> } };
}
export const CAPTURED_RECORD_PATH = new URL("./v0/edge-v2-record.json", import.meta.url);
const record = JSON.parse(readFileSync(CAPTURED_RECORD_PATH, "utf8")) as CapturedRecord;

/** The model in every arm — the doc's "Sol Edge", reconfirmed by the user 2026-09-10. */
export const EDGE_EVAL_MODEL = "gpt-5.6-sol";

/**
 * The ARMS of the benchmark. Four of them are the prompt variants A–D; `AP` is A′, the
 * prompted baseline (plan, approved 2026-09-11): the SAME composed prompt as A and the same
 * empty connection set, differing only in that the runner prefixes a fixed client card to
 * its turn-1 question (src/evals/edge/client-card.ts). It is an arm, not a variant, because
 * nothing about the prompt or the tool surface changes — so the tag vocabulary in
 * `prompt/compose.ts` stays A/B/C/D and every arm composes through `COMPOSE_AS`.
 *
 * `AP` rather than `A'`: the letter travels through CLI args, JSONL keys and per-cell
 * filenames. Reports and prose say A′.
 */
export const ARMS = ["A", "AP", "B", "C", "D"] as const;
export type Arm = (typeof ARMS)[number];

/** The prompt-composition letter behind each arm. */
export const COMPOSE_AS: Record<Arm, Variant> = { A: "A", AP: "A", B: "B", C: "C", D: "D" };

/** Arms whose turn-1 prompt carries the fixed client card. */
export const CARD_ARMS: readonly Arm[] = ["AP"];

export const ARM_LABEL: Record<Arm, string> = {
  A: "A · prompt only",
  AP: "A′ · prompted baseline",
  B: "B · client plane",
  C: "C · knowledge plane",
  D: "D · full Edge",
};

export const isArm = (s: string): s is Arm => (ARMS as readonly string[]).includes(s);

/** Agent names under the eval principal. Prefixed so they never collide with production `edge-v2`. */
export const agentNameFor = (a: Arm) => (a === "AP" ? "edge-eval-a-prime" : `edge-eval-${a.toLowerCase()}`);

/** Connection names are production's — per-principal, so the eval principal binds them to the eval planes. */
export const CONNECTIONS = {
  client: "edge-client",
  kn: "edge-v2-kn",
  inbox: "edge-v2-inbox",
} as const;

export const CONNECTIONS_FOR: Record<Arm, readonly string[]> = {
  A: [],
  AP: [], // A′ knows the client only from the card in its prompt — no plane, by construction.
  B: [CONNECTIONS.client],
  C: [CONNECTIONS.kn],
  D: [CONNECTIONS.client, CONNECTIONS.kn, CONNECTIONS.inbox],
};

/**
 * Production's approval map, filtered to the connections an arm has. `true` =
 * user-approval → with `blockGated: true` the call is stubbed: present in the
 * transcript (so `required_memory_write_missing` = "did not ATTEMPT") but inert.
 */
const PRODUCTION_APPROVAL = record.record.tools.approval;

export function approvalFor(arm: Arm): Record<string, boolean> {
  const prefixes = CONNECTIONS_FOR[arm].map((c) => `${c}_`);
  return Object.fromEntries(
    Object.entries(PRODUCTION_APPROVAL).filter(([tool]) => prefixes.some((p) => tool.startsWith(p))),
  );
}

/** The six write tools of a Loredex connection — every one must be gated wherever the connection is present. */
export const WRITE_TOOLS = ["create", "edit_file", "write_db", "add_comment", "add_link", "share_file"] as const;

export interface EdgeVariant {
  /** The arm (A, AP, B, C, D). Kept as `variant` — it is the cell/judgment field name. */
  variant: Arm;
  name: string;
  promptSha8: string;
  record: AgentRecordInput;
}

export function buildVariant(arm: Arm): EdgeVariant {
  const instructions = composeInstructions(COMPOSE_AS[arm]);
  const approval = approvalFor(arm);
  return {
    variant: arm,
    name: agentNameFor(arm),
    promptSha8: promptSha8(COMPOSE_AS[arm]),
    record: {
      name: agentNameFor(arm),
      title: `Edge eval ${arm === "AP" ? "A′" : arm}`,
      description: {
        A: "Ablation arm A — prompt only: edge-v2 minus every context-plane section; no connections.",
        AP: "Ablation arm A′ — the prompted baseline: arm A's prompt and no connections, with a fixed client card prefixed to the question by the runner.",
        B: "Ablation arm B — horizontal only: client context plane (edge-client) + its instructions.",
        C: "Ablation arm C — vertical only: knowledge plane (edge-v2-kn) + its instructions; no inbox.",
        D: "Ablation arm D — full edge-v2: both planes + inbox, production instructions modulo the v0 pre-freeze edits.",
      }[arm],
      modelId: EDGE_EVAL_MODEL,
      instructions,
      connections: [...CONNECTIONS_FOR[arm]],
      maxSteps: record.record.maxSteps,
      // `enabled: []` = all tools of the listed connections, as production.
      ...(Object.keys(approval).length ? { tools: { enabled: [], approval } } : {}),
      // No `exec` at all: no memory, no web tools, no sandbox — see the header.
      scope: "user",
    },
  };
}

export const buildAllVariants = (): EdgeVariant[] => ARMS.map(buildVariant);
