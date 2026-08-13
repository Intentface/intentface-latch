import type { MemoryScope } from "@intentface/latch-core";
import { LOREDEX_SHARED_ROOT, MEMORY_ROOT_PREFIX } from "./scope.js";

/**
 * Memory index schemas: markdown outlines (top-level `##` headings, optional
 * description bullets) that steer WHAT the background extractor captures per
 * level and HOW the consolidator organizes that level's MEMORY.md.
 *
 * Schemas are ADVISORY: they enter the extraction/consolidation prompts and
 * `memory_write_index` nudges one self-correction round on sections outside
 * the outline (`schemaSectionWarnings`), but a rewrite is never hard-failed
 * over schema drift — sweeps must not wedge on model non-compliance.
 *
 * Two homes:
 * - agent-held levels (`agent-user`, `agent-org`): `MemoryConfig.schemas`.
 * - the cross-agent `user` level: one shared workspace file per connection at
 *   `USER_SCHEMA_PATH` — deliberately OUTSIDE the private root (schemas carry
 *   no PII, and an org-wide file must resolve identically for every caller;
 *   `__private_root` is caller-relative). User memory DATA stays private.
 */

export const MEMORY_SCHEMA_FILENAME = "SCHEMA.md";

/**
 * Workspace path of the shared, org-wide `user`-level schema file — anchored
 * at the shared root so it resolves to ONE physical file for every caller
 * (see LOREDEX_SHARED_ROOT for the caller-relative resolution hazard).
 */
export const USER_SCHEMA_PATH = `${LOREDEX_SHARED_ROOT}/${MEMORY_ROOT_PREFIX}/_user/${MEMORY_SCHEMA_FILENAME}`;

/**
 * The non-negotiable per-level policy floor. Always present in extraction and
 * consolidation prompts, independent of (and above) any configured schema —
 * editing or deleting a schema can never relax it.
 */
export const MEMORY_POLICY_FLOOR: Record<MemoryScope, string> = {
  "agent-user":
    "Private per-user memory: personal detail relevant to this agent is allowed. " +
    "NEVER store credentials, secrets, tokens, one-time codes, or full account/ID numbers.",
  "agent-org":
    "Organization-shared memory: NO personally identifying information and NO facts " +
    "attributed to named or identifiable individuals — store aggregate patterns, team-level " +
    "observations, process decisions, and org-level facts only.",
  user:
    "Cross-agent user profile: profile-level facts about the user only (identity, stable " +
    "preferences, expertise, life/work context) — no agent-domain specifics, and never " +
    "credentials, secrets, or account numbers.",
};

/** Fallback outlines used whenever a level has no configured schema. */
export const DEFAULT_MEMORY_SCHEMAS: Record<MemoryScope, string> = {
  "agent-user": [
    "## Identity & preferences",
    "- Who the user is to this agent; how they like to work with it",
    "## Projects & context",
    "- Ongoing work, goals, and constraints that persist across sessions",
    "## Working agreements",
    "- Decisions, commitments, and standing instructions",
    "## Open loops",
    "- Unfinished threads future sessions must pick up",
  ].join("\n"),
  "agent-org": [
    "## Team patterns",
    "- Aggregate observations about how teams work and respond (no individuals)",
    "## Process decisions",
    "- Org-level decisions and conventions this agent should honor",
    "## Recurring topics",
    "- Themes that keep coming up across the organization",
  ].join("\n"),
  user: [
    "## Profile",
    "- Who the user is: role, background, expertise level",
    "## Preferences",
    "- Stable cross-agent preferences (tone, language, formats)",
    "## Life & work context",
    "- Durable context any of the user's agents may need",
  ].join("\n"),
};

/** The section outline of a schema: its top-level `##` headings, in order. */
export function schemaSections(schema: string): string[] {
  const out: string[] = [];
  for (const line of schema.split("\n")) {
    const m = /^##(?!#)\s*(.+?)\s*$/.exec(line.trim());
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/** FNV-1a 64-bit, hex — deterministic, dependency-free (mirrors extraction-key). */
function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Short stable fingerprint of one schema's normalized text (trailing
 * whitespace and blank-line runs ignored). `"0"` for undefined/blank —
 * "no schema" fingerprints identically everywhere.
 */
export function schemaFingerprint(schema: string | undefined): string {
  const normalized = (schema ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!normalized) return "0";
  return fnv1a64(normalized);
}

/**
 * Combined fingerprint over every participating level and its schema. Folded
 * into extraction idempotency keys: editing any level's schema — or adding/
 * removing a level — changes the key, so tombstoned windows become
 * re-extractable under the new configuration. Order-independent (levels are
 * sorted) so callers need not care about target ordering.
 */
export function schemasFingerprint(
  targets: ReadonlyArray<{ level: MemoryScope; schema: string | undefined }>,
): string {
  const parts = targets
    .map((t) => `${t.level}:${schemaFingerprint(t.schema)}`)
    .sort()
    .join("|");
  return fnv1a64(parts);
}

/**
 * Advisory schema check for an index rewrite: top-level `##` sections in
 * `content` that are neither in the schema's outline nor `## Archive`
 * (case-insensitive). Returns problem strings for the tool's self-correction
 * loop — NEVER used to hard-fail a write.
 */
export function schemaSectionWarnings(schema: string, content: string): string[] {
  const allowed = new Set(schemaSections(schema).map((s) => s.toLowerCase()));
  allowed.add("archive");
  if (allowed.size <= 1) return []; // no outline configured — nothing to check
  const outline = schemaSections(schema)
    .map((s) => `## ${s}`)
    .join(", ");
  const problems: string[] = [];
  for (const section of schemaSections(content)) {
    if (allowed.has(section.toLowerCase())) continue;
    problems.push(
      `unexpected top-level section "## ${section}" — this index's schema sections are: ` +
        `${outline} (plus ## Archive); move its entries under one of those`,
    );
  }
  return problems;
}
