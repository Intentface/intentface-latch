import type { Provenance } from "./types.js";

/**
 * The compiled index (MEMORY.md): parsing, id minting, and the rewrite
 * validator that makes consolidation non-destructive.
 *
 * Entry grammar (one line per fact):
 *
 *   - [m-7f3a] (2026-07-12, user-said) Prefers concise answers. ← episodes/2026-07-12-09-30-onboarding.md
 *   - [m-9911] (2026-06-02, user-said; superseded 2026-07-20 by m-a1c2) Old fact. ← episodes/…
 *
 * Optional `;`-separated parenthetical tail markers (any order):
 *   - `aka: Robert Smith, Bobby` — alternate names/spellings of the entry's
 *     subject, matched exactly by memory_search;
 *   - `unverified` — auto-extracted and not yet confirmed (trust mark; the
 *     consolidator removes it on corroboration).
 *
 * Entries under a `## Archive` heading are archived (superseded/expired).
 * The validator enforces the two invariants the research said matter most:
 * a hard size cap, and "no entry ever silently disappears" — a rewrite may
 * move an entry to Archive but never drop its id.
 */

export const MEMORY_INDEX_FILENAME = "MEMORY.md";
/** Soft cap the consolidator is instructed to stay under. */
export const INDEX_LINE_CAP = 100;
/** Hard cap: rewrites longer than this are rejected outright. */
export const INDEX_LINE_HARD_CAP = 120;

export interface IndexEntry {
  id: string;
  /** YYYY-MM-DD the fact was recorded/updated. */
  date?: string;
  provenance?: Provenance;
  /** Set when the parenthetical carries a `superseded <date> by <id>` marker. */
  superseded?: { date?: string; by?: string };
  /** Alternate names/spellings of the entry's subject (the `aka:` marker). */
  aliases: string[];
  /** True when the parenthetical carries the `unverified` trust mark. */
  unverified: boolean;
  text: string;
  /** Source episode paths (the `← …` tail). */
  sources: string[];
  /** True when the entry sits under the `## Archive` heading. */
  archived: boolean;
  /** The entry line verbatim (for surfacing the entry as a search snippet). */
  raw: string;
}

export interface ParsedIndex {
  entries: IndexEntry[];
  lineCount: number;
  /** Lines that look like entries but don't parse — surfaced to the model. */
  malformed: string[];
}

// Id charset is deliberately wider than what `mintMemoryId` produces (hex):
// the consolidator model mints ids itself and "hex-looking" ids like m-g8d7e9
// are common. Ids are opaque keys — uniqueness matters, the alphabet doesn't,
// and rejecting them sends the model into pointless rewrite loops.
const ENTRY_RE = /^\s*-\s*\[(m-[0-9a-z]{4,8})\]\s*\(([^)]*)\)\s*(.*)$/;
const PROVENANCES = new Set(["user-said", "tool-derived", "user-requested", "mixed"]);

export function parseIndex(text: string): ParsedIndex {
  const lines = text.split("\n");
  const entries: IndexEntry[] = [];
  const malformed: string[] = [];
  let archived = false;
  for (const line of lines) {
    if (/^##\s+archive\b/i.test(line.trim())) {
      archived = true;
      continue;
    }
    if (/^##\s+/.test(line.trim()) && !/^##\s+archive\b/i.test(line.trim())) {
      // A new section after Archive would be unusual, but honor it.
      if (archived && !/archive/i.test(line)) archived = false;
      continue;
    }
    const looksLikeEntry = /^\s*-\s*\[m-/.test(line);
    const m = ENTRY_RE.exec(line);
    if (!m) {
      if (looksLikeEntry) malformed.push(line.trim());
      continue;
    }
    const [, id, paren, rest] = m;
    // Parenthetical: `<date>, <provenance>[; superseded <date> by <id>]` — parse
    // leniently; a hand-edited index must not break recall.
    const [head, ...tailParts] = paren.split(";").map((s) => s.trim());
    const headBits = head.split(",").map((s) => s.trim());
    const date = /^\d{4}-\d{2}-\d{2}$/.test(headBits[0] ?? "") ? headBits[0] : undefined;
    const prov = headBits.find((b) => PROVENANCES.has(b)) as Provenance | undefined;
    let superseded: IndexEntry["superseded"];
    const supersededPart = tailParts.find((p) => /^superseded\b/i.test(p));
    if (supersededPart) {
      const sd = /(\d{4}-\d{2}-\d{2})/.exec(supersededPart)?.[1];
      const by = /by\s+(m-[0-9a-z]{4,8})/i.exec(supersededPart)?.[1];
      superseded = { date: sd, by };
    }
    const akaPart = tailParts.find((p) => /^aka\s*:/i.test(p));
    const aliases = akaPart
      ? akaPart
          .replace(/^aka\s*:/i, "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    const unverified = tailParts.some((p) => /^unverified$/i.test(p));
    // The `← sources` tail (allow plain "<-" as a fallback for hand edits).
    const arrowSplit = rest.split(/\s*(?:←|<-)\s*/);
    const text_ = (arrowSplit[0] ?? "").trim();
    const sources =
      arrowSplit.length > 1
        ? arrowSplit
            .slice(1)
            .join(",")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    entries.push({
      id,
      date,
      provenance: prov,
      superseded,
      aliases,
      unverified,
      text: text_,
      sources,
      archived,
      raw: line.trim(),
    });
  }
  return { entries, lineCount: lines.length, malformed };
}

export class IndexValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Index rewrite rejected:\n- ${problems.join("\n- ")}`);
    this.name = "IndexValidationError";
    this.problems = problems;
  }
}

/**
 * Validate a proposed index rewrite against the previous version. Returns the
 * problem list (empty = valid). Rules:
 * - hard line cap (`INDEX_LINE_HARD_CAP`);
 * - no duplicate entry ids;
 * - every previously ACTIVE id must still be present (active or archived) —
 *   supersede/expire is a MOVE to `## Archive`, never a silent delete;
 * - previously ARCHIVED ids MAY be dropped: every rewrite snapshots the full
 *   prior index first, so archived history stays recoverable while the cap
 *   stays satisfiable (otherwise Archive would grow past the cap forever);
 * - entry-shaped lines must parse.
 */
export function validateIndexRewrite(prev: string | undefined, next: string): string[] {
  const problems: string[] = [];
  const parsed = parseIndex(next);
  if (parsed.lineCount > INDEX_LINE_HARD_CAP) {
    problems.push(
      `index is ${parsed.lineCount} lines — the hard cap is ${INDEX_LINE_HARD_CAP} ` +
        `(target ≤ ${INDEX_LINE_CAP}). Merge or archive entries instead of growing the index.`,
    );
  }
  for (const line of parsed.malformed) {
    problems.push(
      `malformed entry line (expected \`- [m-<4-8 lowercase letters/digits>] ` +
        `(<YYYY-MM-DD>, <provenance>) <fact> ← <sources>\`): "${line}"`,
    );
  }
  const seen = new Set<string>();
  for (const e of parsed.entries) {
    if (seen.has(e.id)) problems.push(`duplicate entry id: ${e.id}`);
    seen.add(e.id);
  }
  if (prev) {
    const prevActive = parseIndex(prev)
      .entries.filter((e) => !e.archived)
      .map((e) => e.id);
    const missing = prevActive.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      problems.push(
        `active entries silently deleted: ${missing.join(", ")} — move superseded/expired ` +
          `entries under "## Archive" instead of removing them.`,
      );
    }
  }
  return problems;
}

/** Mint a new entry id not already taken (6 hex chars, `m-` prefixed). */
export function mintMemoryId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `m-${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}

/** All `[m-…]` ids referenced in a blob of text (for usage tracking). */
export function memoryIdsIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[(m-[0-9a-z]{4,8})\]/g), (m) => m[1])));
}
