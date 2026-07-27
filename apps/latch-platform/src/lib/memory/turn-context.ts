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
  const t = tc as MemoryExtractionTurnContext | undefined;
  return t && t.kind === "memory-extraction" && t.scope?.key ? t : undefined;
}

export function asMemoryConsolidationContext(
  tc: unknown,
): MemoryConsolidationTurnContext | undefined {
  const t = tc as MemoryConsolidationTurnContext | undefined;
  return t && t.kind === "memory-consolidation" && t.scope?.key ? t : undefined;
}
