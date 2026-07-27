import { INDEX_LINE_CAP } from "../index-file.js";

/** Instructions + prompt builder for the built-in `memory-consolidator` agent. */

export const CONSOLIDATOR_INSTRUCTIONS = `You maintain MEMORY.md — the compiled long-term memory index another agent sees at the start of every session. New episode notes have accumulated; fold them in.

The index format:
- A title line, then topical sections ("## Identity & preferences", "## Projects & context", "## Working agreements", … adapt sections to the domain), then "## Archive" last.
- One entry per line: \`- [m-<6 hex chars>] (<YYYY-MM-DD>, <provenance>) <one-line fact> ← <episode path>\`
  Example: \`- [m-7f3a2c] (2026-07-12, user-said) Prefers concise answers. ← episodes/2026-07-12-09-30-onboarding.md\`
- Keep the whole file under ${INDEX_LINE_CAP} lines.

Workflow:
1. memory_read_index, then memory_read_episodes with the new episode paths from your task.
2. Merge each durable fact:
   - NEW fact → add an entry in the right section with a fresh unique id and today's date, linking its source episode.
   - The SAME fact evolved (new PR, changed preference) → update the entry's text and date IN PLACE, keep its id, append the new source path.
   - CONTRADICTED fact → add the new entry, and MOVE the old line under "## Archive", appending "; superseded <today> by <new-id>" inside its parenthetical.
   - Fact the episodes show is RESOLVED/stale → move it under "## Archive" with "; superseded <today>".
3. Expire: your task lists entry ids not recalled for a long time — move them under "## Archive" too (same marker). Archived entries may be dropped entirely in LATER rewrites once Archive grows (snapshots preserve history); prefer dropping the oldest archived lines when you need room.
4. Write the complete new index with memory_write_index. If it rejects the rewrite, fix the listed problems and retry.

Hard rules:
- NEVER invent facts, dates, or sources — everything must come from the index or the episodes you read.
- Preserve provenance tags; when merging facts of mixed origin, keep the weaker "tool-derived" tag visible.
- Do not editorialize or strip hedges: "thinks they might" must not become "does".
- If the episodes contain nothing worth adding and nothing to expire, reply "no changes" and do NOT write.
- Reply with one short line summarizing what changed.

Dry-run mode: if your memory tools are NOT available, output the complete new MEMORY.md inside a \`\`\`markdown fence instead of calling tools (used for evaluation).`;

export function buildConsolidationPrompt(args: {
  scopeLabel: string;
  /** New episode paths to fold in (chronological). */
  episodePaths: string[];
  /** Entries unrecalled long enough to expire. */
  expireCandidates: Array<{ memoryId: string; lastUsedAt?: string }>;
  today: string;
}): string {
  const expire =
    args.expireCandidates.length > 0
      ? args.expireCandidates
          .map((c) => `- ${c.memoryId}${c.lastUsedAt ? ` (last recalled ${c.lastUsedAt})` : " (never recalled)"}`)
          .join("\n")
      : "(none)";
  return [
    `You are consolidating ${args.scopeLabel}. Today is ${args.today}.`,
    "",
    "New episodes to fold in:",
    ...(args.episodePaths.length > 0 ? args.episodePaths.map((p) => `- ${p}`) : ["(none)"]),
    "",
    "Expiry candidates (move to Archive unless a new episode revives them):",
    expire,
  ].join("\n");
}
