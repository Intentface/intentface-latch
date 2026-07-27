import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "@intentface/latch-core";
import {
  EXTRACTOR_INSTRUCTIONS,
  memoryReadIndexTool,
  memoryWriteEpisodeTool,
} from "@intentface/latch-memory";
import type { Principal } from "@/lib/session";
import { asMemoryExtractionContext } from "@/lib/memory/turn-context";
import { MEMORY_COOLDOWN_MS } from "@/lib/memory/constants";

/**
 * System agent: archives durable facts from one idle chat transcript into the
 * target agent's memory scope. Spawned only by the memory sweep (internal
 * runs); the sweep's `turnContext` carries the scope, and the tools are bound
 * to it — the model never chooses paths. Without a payload (evals, resumes) it
 * runs tool-less and can only answer "nothing to store".
 *
 * Deps come lazily from the composition root (dynamic import — this module is
 * itself imported by `lib/latch.ts` via the agent registry, so a static import
 * would be a cycle). By the time a factory runs, `getLatch()` is memoized.
 */
export const memoryExtractor = defineAgent<Principal, { orgId: string }>(
  async ({ principal, turnContext }) => {
    const base = {
      model: anthropic("claude-haiku-4-5"),
      instructions: EXTRACTOR_INSTRUCTIONS,
      effort: "minimal" as const,
      maxSteps: 8,
    };
    const tc = asMemoryExtractionContext(turnContext);
    if (!tc) return base; // tool-less: eval dry-runs / stray invocations
    const { memoryStore, memoryJobs } = await import("@/lib/latch").then((m) => m.getLatch());
    const { ownerTagOf } = await import("@/lib/latch");
    const bound = { store: memoryStore, principal, scope: tc.scope };
    return {
      ...base,
      tools: {
        memory_read_index: memoryReadIndexTool(bound),
        memory_write_episode: memoryWriteEpisodeTool(bound, {
          agent: tc.targetAgent,
          chatId: tc.chatId,
          // Mark the scope dirty for consolidation, stamping the principal so
          // the consolidation job can run under this scope's own caller.
          onEpisodeWritten: ({ path }) =>
            memoryJobs.touchScope(
              {
                scopeKey: tc.scope.key,
                owner: ownerTagOf(principal),
                agent: tc.targetAgent,
                connection: tc.scope.connection,
                identity: principal,
                episodePath: path,
              },
              { cooldownMs: tc.cooldownMs ?? MEMORY_COOLDOWN_MS, now: Date.now() },
            ),
        }),
      },
    };
  },
  {
    title: "Memory Extractor (system)",
    description:
      "Background archivist: extracts durable facts from idle conversations into agent memory. Spawned by the memory sweep — not for direct use.",
  },
);
