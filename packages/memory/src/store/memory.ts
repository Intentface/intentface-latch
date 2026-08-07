import type { EpisodeMeta, MemorySearchHit, MemoryStore, ScopeRef } from "../types.js";
import { isUnderScopeRoot } from "../scope.js";
import {
  IndexValidationError,
  MEMORY_INDEX_FILENAME,
  memoryIdsIn,
  validateIndexRewrite,
} from "../index-file.js";

/**
 * In-memory `MemoryStore`: a `Map<path, text>` behind the store seam, with a
 * deterministic keyword (BM25-style, NO embeddings) search. Two consumers:
 *
 * - tests that need a real store without a Loredex connection;
 * - the offline retrieval evals (`evals/`), which measure the real
 *   `memory_search` tool over this store.
 *
 * Determinism is a hard requirement (the evals byte-compare reports across
 * runs): no `Date.now()`, no `Math.random()` — episode filenames come from
 * `meta.extractedAt`, snapshot names from a monotonic counter, and search
 * ties break on lexicographic path order.
 */

export interface InMemoryStoreHandle extends MemoryStore<unknown> {
  /** The backing file map (path → text), exposed for seeding and assertions. */
  readonly files: Map<string, string>;
}

export function createInMemoryStore(opts?: {
  /** Seed files (workspace-relative path → markdown text). */
  files?: Record<string, string> | Map<string, string>;
}): InMemoryStoreHandle {
  const files = new Map<string, string>(
    opts?.files instanceof Map ? opts.files : Object.entries(opts?.files ?? {}),
  );
  let snapshotSeq = 0;

  const indexPath = (scope: ScopeRef) => `${scope.root}/${MEMORY_INDEX_FILENAME}`;

  return {
    files,

    async available() {
      return true;
    },

    async readIndex(_principal, scope) {
      return files.get(indexPath(scope));
    },

    async writeIndex(_principal, scope, text) {
      const prev = files.get(indexPath(scope));
      const problems = validateIndexRewrite(prev, text);
      if (problems.length > 0) throw new IndexValidationError(problems);
      if (prev !== undefined && prev.trim().length > 0) {
        snapshotSeq += 1;
        files.set(
          `${scope.root}/archive/index-snapshots/MEMORY-${String(snapshotSeq).padStart(4, "0")}.md`,
          prev,
        );
      }
      files.set(indexPath(scope), text);
    },

    async writeEpisode(_principal, scope, episode) {
      const dir = `${scope.root}/episodes`;
      const stamp = episode.meta.extractedAt.slice(0, 16).replace("T", "-").replace(":", "-");
      const slug =
        episode.slug
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .replace(/-{2,}/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "note";
      let name = `${stamp}-${slug}.md`;
      // Same minute + same slug: disambiguate deterministically.
      for (let n = 2; files.has(`${dir}/${name}`); n++) name = `${stamp}-${slug}-${n}.md`;
      const content = `${episodeFrontmatter(episode.meta)}\n\n${episode.body.trim()}\n`;
      files.set(`${dir}/${name}`, content);
      return { path: `${dir}/${name}`, name };
    },

    async readEpisodes(_principal, scope, paths) {
      const out: Array<{ path: string; text: string }> = [];
      for (const path of paths) {
        if (!isUnderScopeRoot(scope.root, path)) continue;
        const text = files.get(path);
        if (text !== undefined) out.push({ path, text });
      }
      return out;
    },

    async search(_principal, scope, query, limit = 6) {
      const docs = Array.from(files.entries())
        .filter(([path]) => isUnderScopeRoot(scope.root, path))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return keywordSearch(docs, query, limit);
    },
  };
}

function episodeFrontmatter(meta: EpisodeMeta): string {
  return [
    "---",
    ...(meta.chat ? [`chat: ${meta.chat}`] : []),
    `agent: ${meta.agent}`,
    `extracted_at: ${meta.extractedAt}`,
    `provenance: ${meta.provenance}`,
    "---",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic keyword search (grep-style BM25-lite, no embeddings)
// ---------------------------------------------------------------------------

/** Minimal english stopword list — enough to keep filler words from scoring. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "for",
  "from", "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "me", "my", "no", "not", "of", "on", "or", "our", "she", "so", "that",
  "the", "their", "them", "they", "this", "to", "up", "was", "we", "what",
  "when", "where", "which", "who", "will", "with", "you", "your",
]);

/** Lowercase word tokens (len ≥ 2), stopwords removed. Exported for the evals. */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * BM25-lite over (path, text) docs. The filename contributes tokens twice
 * (title weight, mirroring how Loredex indexes file names alongside content).
 * Fully deterministic: score desc, then path asc.
 */
export function keywordSearch(
  docs: Array<[path: string, text: string]>,
  query: string,
  limit: number,
): MemorySearchHit[] {
  const queryTokens = Array.from(new Set(contentTokens(query)));
  if (queryTokens.length === 0) return [];

  const indexed = docs.map(([path, text]) => {
    const nameTokens = contentTokens(path.split("/").pop() ?? "");
    const tokens = [...contentTokens(text), ...nameTokens, ...nameTokens];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { path, text, tf, length: tokens.length };
  });

  const n = indexed.length;
  if (n === 0) return [];
  const avgLen = indexed.reduce((sum, d) => sum + d.length, 0) / n || 1;

  const scored = indexed
    .map((doc) => {
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;
        const df = indexed.reduce((c, d) => c + (d.tf.has(term) ? 1 : 0), 0);
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        // k1 = 1.2, b = 0.75 — the standard BM25 saturation curve.
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (doc.length / avgLen))));
      }
      return { doc, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.doc.path < b.doc.path ? -1 : 1));

  return scored.slice(0, limit).map(({ doc }) => {
    const snippet = bestSnippet(doc.text, queryTokens);
    const memoryIds = memoryIdsIn(snippet);
    if (/\/episodes\//.test(doc.path)) memoryIds.push(doc.path);
    return { path: doc.path, snippet, memoryIds: Array.from(new Set(memoryIds)) };
  });
}

/** The line matching the most query tokens (first on ties), capped at 240 chars. */
function bestSnippet(text: string, queryTokens: string[]): string {
  let best = "";
  let bestCount = 0;
  for (const line of text.split("\n")) {
    const lineTokens = new Set(contentTokens(line));
    const count = queryTokens.reduce((c, t) => c + (lineTokens.has(t) ? 1 : 0), 0);
    if (count > bestCount) {
      best = line.trim();
      bestCount = count;
    }
  }
  if (!best) best = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return best.length > 240 ? `${best.slice(0, 237)}…` : best;
}
