import type { IndexEntry } from "./index-file.js";

/**
 * Match evidence for `memory_search` results: WHY a result matched, so the
 * agent can judge whether a memory already exists before creating one with
 * `memory_save`.
 *
 * Index entries have no separate "name" field — an entry's `aka:` alias list
 * IS its set of names — so the spec's name-exact/alias-exact collapse into
 * one `alias-exact` level. The one-line fact text plays the "description"
 * role; anything the backend search surfaced without index evidence is
 * `body`.
 */
export type MatchEvidence = "alias-exact" | "description" | "body";

/** How safe it is to CREATE a new memory for the searched subject. */
export type CreateSafety = "exists" | "probable" | "unknown";

/** Strongest-first ranking for strongest-signal-wins merging. */
export const EVIDENCE_RANK: Record<MatchEvidence, number> = {
  "alias-exact": 3,
  description: 2,
  body: 1,
};

/** Normalize for matching: NFKC, lowercase, collapsed whitespace. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Strongest evidence one ACTIVE index entry offers for `query`, or undefined
 * when it offers none. Exact (normalized) equality against an alias is the
 * strongest signal; a substring hit in the entry's fact text is descriptive
 * evidence. Very short queries (< 3 chars) skip the substring check — they
 * match everything and prove nothing.
 */
export function entryEvidence(
  query: string,
  entry: Pick<IndexEntry, "aliases" | "text">,
): Exclude<MatchEvidence, "body"> | undefined {
  const q = normalizeForMatch(query);
  if (!q) return undefined;
  if (entry.aliases.some((a) => normalizeForMatch(a) === q)) return "alias-exact";
  if (q.length >= 3 && normalizeForMatch(entry.text).includes(q)) return "description";
  return undefined;
}

/**
 * Derive the response-level `create_safety` from all result evidence:
 * an exact alias match proves the memory exists; descriptive evidence makes
 * it probable; body-only hits (or none at all) prove nothing either way.
 */
export function createSafetyOf(evidence: readonly MatchEvidence[]): CreateSafety {
  if (evidence.includes("alias-exact")) return "exists";
  if (evidence.includes("description")) return "probable";
  return "unknown";
}
