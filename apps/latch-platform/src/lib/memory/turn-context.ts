import type { MemoryScope } from "@intentface/latch-core";
import type { ScopeRef } from "@intentface/latch-memory";

/**
 * The `turnContext` payloads the memory sweep hands the built-in job agents
 * (via `runtime.runAgent`). Ephemeral by design — a resumed job turn has no
 * payload, and the agent factories degrade to tool-less (dry-run) configs.
 */

/**
 * Called with the outcome of every memory write the job agent attempts.
 *
 * The sweep decides from this whether the run may consume its input (tombstone
 * a transcript window, consume pending episodes). A run whose every write
 * failed still answers with a confident one-line summary — the model treats a
 * failing tool as a reason to describe what it *would* have saved — so the
 * answer is no evidence that anything landed. Never called means "nothing
 * needed writing", which is a legitimate success.
 *
 * Ephemeral like the rest of the payload: a resumed turn has no context, and
 * `turnContext` is passed by reference and never persisted.
 */
export type MemoryWriteAttemptSink = (ok: boolean) => void;

export interface MemoryExtractionTurnContext {
  kind: "memory-extraction";
  /** The primary scope (guards, back-compat); always also present in `targets`. */
  scope: ScopeRef;
  /** Every participating level (primary first), each with its resolved scope and schema. */
  targets: Array<{ level: MemoryScope; scope: ScopeRef; schema: string }>;
  /** The chat being archived. */
  chatId: string;
  /** The memory-enabled agent whose scope this is (NOT `memory-extractor`). */
  targetAgent: string;
  /** Consolidation cooldown for the touched scopes. */
  cooldownMs: number;
  onWriteAttempt?: MemoryWriteAttemptSink;
}

export interface MemoryConsolidationTurnContext {
  kind: "memory-consolidation";
  scope: ScopeRef;
  /** This scope's level and index schema, when resolved by the sweep. */
  level?: MemoryScope;
  schema?: string;
  onWriteAttempt?: MemoryWriteAttemptSink;
}

export function asMemoryExtractionContext(
  tc: unknown,
): MemoryExtractionTurnContext | undefined {
  const t = tc as
    | { kind?: unknown; scope?: { key?: unknown }; targets?: unknown }
    | undefined;
  return t?.kind === "memory-extraction" &&
    typeof t.scope?.key === "string" &&
    Array.isArray(t.targets)
    ? (tc as MemoryExtractionTurnContext)
    : undefined;
}

export function asMemoryConsolidationContext(
  tc: unknown,
): MemoryConsolidationTurnContext | undefined {
  const t = tc as { kind?: unknown; scope?: { key?: unknown } } | undefined;
  return t?.kind === "memory-consolidation" && typeof t.scope?.key === "string"
    ? (tc as MemoryConsolidationTurnContext)
    : undefined;
}
