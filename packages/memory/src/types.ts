import type { MemoryConfig } from "@intentface/latch-core";

/**
 * Where a memory came from. Tool-derived facts are less trustworthy than
 * things the user said directly (a prompt-injection persistence vector), so
 * every stored fact carries its origin and the consolidator preserves it.
 */
export type Provenance = "user-said" | "tool-derived" | "user-requested" | "mixed";

/**
 * A resolved memory scope: WHERE one memory store lives.
 *
 * - `key` is the canonical scope identity used everywhere outside the store
 *   (DB rows, caches, leases): `${connection}:${root}`.
 * - `root` is the folder inside the connection's workspace, e.g.
 *   `_memory/running-coach/u-usr123`.
 */
export interface ScopeRef {
  key: string;
  connection: string;
  root: string;
}

/** Frontmatter of one episode file. */
export interface EpisodeMeta {
  /** Source chat id (absent for `memory_save` episodes). */
  chat?: string;
  agent: string;
  /** ISO timestamp; also drives the episode's filename stamp. */
  extractedAt: string;
  provenance: Provenance;
}

export interface MemorySearchHit {
  path: string;
  snippet: string;
  /**
   * Memory identities this hit touches, for usage/retention tracking: `[m-…]`
   * entry ids found in the snippet plus the file path itself.
   */
  memoryIds: string[];
}

/**
 * The storage seam. One implementation per backing (Loredex first); everything
 * above it (provider, tools, jobs) is backend-agnostic.
 *
 * Contract: operations NEVER throw for "store unreachable" (unauthorized
 * connection, missing workspace) — they return `undefined`/empty so a memory
 * failure degrades gracefully. They MAY throw for contract violations (e.g. an
 * index rewrite that fails validation), which tool wrappers surface to the
 * model as structured errors.
 */
export interface MemoryStore<P> {
  /** Cheap probe: is the scope's backing reachable for this principal? */
  available(principal: P, scope: ScopeRef): Promise<boolean>;
  /** The compiled index (MEMORY.md) text, or undefined if absent/unreachable. */
  readIndex(principal: P, scope: ScopeRef): Promise<string | undefined>;
  /**
   * Replace the compiled index. Snapshots the previous version to
   * `archive/index-snapshots/` first and validates the rewrite via
   * `validateIndexRewrite` (throws `IndexValidationError` on violation).
   */
  writeIndex(principal: P, scope: ScopeRef, text: string): Promise<void>;
  /**
   * Write one immutable episode file under `episodes/`. Returns its path, or
   * undefined when the store is unreachable.
   */
  writeEpisode(
    principal: P,
    scope: ScopeRef,
    episode: { slug: string; meta: EpisodeMeta; summary: string; body: string },
  ): Promise<{ path: string; name: string } | undefined>;
  /** Batch-read episode files by path (missing files are skipped). */
  readEpisodes(
    principal: P,
    scope: ScopeRef,
    paths: string[],
  ): Promise<Array<{ path: string; text: string }>>;
  /** Hybrid search scoped to this memory folder. */
  search(
    principal: P,
    scope: ScopeRef,
    query: string,
    limit?: number,
  ): Promise<MemorySearchHit[]>;
}

/** Re-exported for convenience so platform code can import from one place. */
export type { MemoryConfig };
