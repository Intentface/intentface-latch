import type { MemoryScope } from "@intentface/latch-core";
import {
  DEFAULT_MEMORY_SCHEMAS,
  MEMORY_POLICY_FLOOR,
  scopeLabelOf,
  levelConfigOf,
} from "@intentface/latch-memory";

/**
 * The one prompt for drafting a memory index schema from an agent's purpose —
 * shared by the editor's "Generate from instructions" server fn and the
 * builder agent's `generate_memory_schemas` tool, so the two paths can't
 * drift.
 */
export function buildSchemaGenerationPrompt(args: {
  agent: string;
  instructions: string;
  level: MemoryScope;
}): { system: string; prompt: string } {
  const label = scopeLabelOf(levelConfigOf({ scope: args.level, connection: "-" }, args.level));
  return {
    system: [
      "You design memory index schemas for AI agents. A schema is a short markdown outline:",
      'top-level "## Section" headings, each followed by one "- description" bullet saying what',
      "belongs there. The background memory system uses it to decide WHAT to extract from",
      "conversations at this memory level and HOW to organize the level's index file.",
      "",
      "Rules:",
      "- 3-6 sections, specific to the agent's domain — not generic catch-alls.",
      `- The level's non-negotiable policy floor (do not restate it as a section): ${MEMORY_POLICY_FLOOR[args.level]}`,
      "- Sections must be things future sessions genuinely need to recall.",
      "- Reply with ONLY the outline markdown — no preamble, no fences.",
      "",
      `A generic default for this level, as a shape reference (yours should be domain-specific):`,
      DEFAULT_MEMORY_SCHEMAS[args.level],
    ].join("\n"),
    prompt: [
      `Agent: ${args.agent}`,
      `Memory level: ${args.level} — ${label}.`,
      "",
      "Agent instructions:",
      args.instructions,
      "",
      `Draft the ${args.level} memory schema for this agent.`,
    ].join("\n"),
  };
}
