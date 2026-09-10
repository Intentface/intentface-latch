/**
 * Edge Eval v0 — the four ablation arms as agent RECORDS.
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
 * (this file) and instructions (edge-v2.prompt.md selection).
 */
import { readFileSync } from "node:fs";
import type { AgentRecordInput } from "@intentface/latch-agent-builder";
import { composeInstructions, promptSha8, VARIANTS, type Variant } from "./prompt/compose";

/** The captured production record (src/evals/edge/v0/edge-v2-record.json). */
interface CapturedRecord {
  record: { modelId: string; maxSteps: number; connections: string[]; tools: { approval: Record<string, boolean> } };
}
export const CAPTURED_RECORD_PATH = new URL("./v0/edge-v2-record.json", import.meta.url);
const record = JSON.parse(readFileSync(CAPTURED_RECORD_PATH, "utf8")) as CapturedRecord;

/** The model in every arm — the doc's "Sol Edge", reconfirmed by the user 2026-09-10. */
export const EDGE_EVAL_MODEL = "gpt-5.6-sol";

/** Agent names under the eval principal. Prefixed so they never collide with production `edge-v2`. */
export const agentNameFor = (v: Variant) => `edge-eval-${v.toLowerCase()}` as const;

/** Connection names are production's — per-principal, so the eval principal binds them to the eval planes. */
export const CONNECTIONS = {
  client: "edge-client",
  kn: "edge-v2-kn",
  inbox: "edge-v2-inbox",
} as const;

export const CONNECTIONS_FOR: Record<Variant, readonly string[]> = {
  A: [],
  B: [CONNECTIONS.client],
  C: [CONNECTIONS.kn],
  D: [CONNECTIONS.client, CONNECTIONS.kn, CONNECTIONS.inbox],
};

/**
 * Production's approval map, filtered to the connections a variant has. `true` =
 * user-approval → with `blockGated: true` the call is stubbed: present in the
 * transcript (so `required_memory_write_missing` = "did not ATTEMPT") but inert.
 */
const PRODUCTION_APPROVAL = record.record.tools.approval;

export function approvalFor(variant: Variant): Record<string, boolean> {
  const prefixes = CONNECTIONS_FOR[variant].map((c) => `${c}_`);
  return Object.fromEntries(
    Object.entries(PRODUCTION_APPROVAL).filter(([tool]) => prefixes.some((p) => tool.startsWith(p))),
  );
}

/** The six write tools of a Loredex connection — every one must be gated wherever the connection is present. */
export const WRITE_TOOLS = ["create", "edit_file", "write_db", "add_comment", "add_link", "share_file"] as const;

export interface EdgeVariant {
  variant: Variant;
  name: string;
  promptSha8: string;
  record: AgentRecordInput;
}

export function buildVariant(variant: Variant): EdgeVariant {
  const instructions = composeInstructions(variant);
  const approval = approvalFor(variant);
  return {
    variant,
    name: agentNameFor(variant),
    promptSha8: promptSha8(variant),
    record: {
      name: agentNameFor(variant),
      title: `Edge eval ${variant}`,
      description: {
        A: "Ablation arm A — prompt only: edge-v2 minus every context-plane section; no connections.",
        B: "Ablation arm B — horizontal only: client context plane (edge-client) + its instructions.",
        C: "Ablation arm C — vertical only: knowledge plane (edge-v2-kn) + its instructions; no inbox.",
        D: "Ablation arm D — full edge-v2: both planes + inbox, production instructions modulo the v0 pre-freeze edits.",
      }[variant],
      modelId: EDGE_EVAL_MODEL,
      instructions,
      connections: [...CONNECTIONS_FOR[variant]],
      maxSteps: record.record.maxSteps,
      // `enabled: []` = all tools of the listed connections, as production.
      ...(Object.keys(approval).length ? { tools: { enabled: [], approval } } : {}),
      // No `exec` at all: no memory, no web tools, no sandbox — see the header.
      scope: "user",
    },
  };
}

export const buildAllVariants = (): EdgeVariant[] => VARIANTS.map(buildVariant);
