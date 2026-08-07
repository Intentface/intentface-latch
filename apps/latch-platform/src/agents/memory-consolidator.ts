import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "@intentface/latch-core";
import {
  CONSOLIDATOR_INSTRUCTIONS,
  memoryReadEpisodesTool,
  memoryReadIndexTool,
  memoryWriteIndexTool,
} from "@intentface/latch-memory";
import type { Principal } from "@/lib/session";
import { asMemoryConsolidationContext } from "@/lib/memory/turn-context";

/**
 * System agent: folds pending episode notes into a scope's compiled index
 * (MEMORY.md). Spawned only by the memory sweep; `memory_write_index` enforces
 * the non-destructive rewrite contract (snapshot first, line cap, no silent
 * deletion of active entries) — a rejected rewrite comes back as a structured
 * error the model fixes and retries. Without a sweep payload it runs tool-less,
 * which triggers the instructions' dry-run mode (used by evals).
 */
export const memoryConsolidator = defineAgent<Principal, { orgId: string }>(
  async ({ principal, turnContext }) => {
    const base = {
      model: anthropic("claude-haiku-4-5"),
      instructions: CONSOLIDATOR_INSTRUCTIONS,
      effort: "low" as const,
      maxSteps: 12,
    };
    const tc = asMemoryConsolidationContext(turnContext);
    if (!tc) return base; // tool-less → dry-run mode (evals)
    const { memoryStore } = await import("@/lib/latch").then((m) => m.getLatch());
    const bound = { store: memoryStore, principal, scope: tc.scope };
    return {
      ...base,
      tools: {
        memory_read_index: memoryReadIndexTool(bound),
        memory_read_episodes: memoryReadEpisodesTool(bound),
        // Schema adherence is advisory: one nudge round, then the write goes
        // through — see memoryWriteIndexTool.
        memory_write_index: memoryWriteIndexTool(bound, {
          schema: tc.schema,
          onWriteAttempt: tc.onWriteAttempt,
        }),
      },
    };
  },
  {
    title: "Memory Consolidator (system)",
    description:
      "Background maintainer: merges episode notes into the compiled memory index, superseding and expiring entries. Spawned by the memory sweep — not for direct use.",
  },
);
