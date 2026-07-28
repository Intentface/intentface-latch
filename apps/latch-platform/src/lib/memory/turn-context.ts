import type { ScopeRef } from "@intentface/latch-memory";

/**
 * The `turnContext` payloads the memory sweep hands the built-in job agents
 * (via `runtime.runAgent`). Ephemeral by design — a resumed job turn has no
 * payload, and the agent factories degrade to tool-less (dry-run) configs.
 */

export interface MemoryExtractionTurnContext {
  kind: "memory-extraction";
  scope: ScopeRef;
  /** The chat being archived. */
  chatId: string;
  /** The memory-enabled agent whose scope this is (NOT `memory-extractor`). */
  targetAgent: string;
  /** Consolidation cooldown for the touched scope. */
  cooldownMs: number;
}

export interface MemoryConsolidationTurnContext {
  kind: "memory-consolidation";
  scope: ScopeRef;
}

export function asMemoryExtractionContext(
  tc: unknown,
): MemoryExtractionTurnContext | undefined {
  const t = tc as { kind?: unknown; scope?: { key?: unknown } } | undefined;
  return t?.kind === "memory-extraction" && typeof t.scope?.key === "string"
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
