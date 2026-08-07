import { tool, jsonSchema } from "ai";
import type { MemoryScope } from "@intentface/latch-core";
import type { EpisodeMeta, MemoryStore, Provenance, ScopeRef } from "./types.js";
import { IndexValidationError, MEMORY_INDEX_FILENAME, parseIndex } from "./index-file.js";
import type { IndexEntry } from "./index-file.js";
import { isUnderScopeRoot } from "./scope.js";
import { schemaSectionWarnings } from "./schema.js";
import { createSafetyOf, entryEvidence, EVIDENCE_RANK } from "./search-evidence.js";
import type { MatchEvidence } from "./search-evidence.js";
import { sanitizeMemoryText } from "./sanitize.js";

/**
 * Tool factories. Two families:
 *
 * - Agent-facing (`memory_search`, `memory_save`): merged into a memory-enabled
 *   agent's turn by the provider.
 * - Job-facing (`memory_read_index`, `memory_write_episode`,
 *   `memory_read_episodes`, `memory_write_index`): given to the built-in
 *   extractor/consolidator agents.
 *
 * Every factory binds `store + principal + scope` at construction — the model
 * never chooses paths, so it cannot read or write outside its scope.
 */

export interface BoundScope<P> {
  store: MemoryStore<P>;
  principal: P;
  scope: ScopeRef;
}

/**
 * One participating memory level and its bound scope. Multi-level tools
 * (`memory_search` fan-out, level-routed `memory_write_episode`,
 * `memory_read_index` across levels) take an array of these; a single-element
 * array behaves exactly like the classic single-scope binding.
 */
export interface LevelBoundScope<P> {
  level: MemoryScope;
  bound: BoundScope<P>;
}

/**
 * Explicit (portable) shape for the authored tools — declaration emit cannot
 * name the AI SDK's inferred `Tool<…>` type across package boundaries
 * (TS2742), and agent configs only need `Record<string, unknown>` anyway.
 */
export interface MemoryTool {
  description?: unknown;
  inputSchema: unknown;
  execute?: (input: never, options: never) => unknown;
}

/** One scope's search pass: backend hits + index-evidence merge + synthetic hits. */
async function searchOneScope<P>(
  bound: BoundScope<P>,
  query: string,
  limit: number,
): Promise<{
  results: Array<{ path: string; snippet: string; matchedOn: MatchEvidence; unverified?: true }>;
  recalledIds: string[];
}> {
  const hits = await bound.store.search(bound.principal, bound.scope, query, limit);
  // Evidence pass over the compiled index: the backend ranks free text,
  // but create_safety needs EXACT signals (normalized alias equality) the
  // backend can't provide — so match active entries ourselves and merge,
  // strongest signal winning per result. Index unavailability degrades to
  // body-only evidence, never a failed search.
  let entries: IndexEntry[] = [];
  try {
    const index = await bound.store.readIndex(bound.principal, bound.scope);
    if (index) entries = parseIndex(index).entries.filter((e) => !e.archived);
  } catch {
    // body-only evidence
  }
  const evidenceById = new Map<string, MatchEvidence>();
  for (const e of entries) {
    const evidence = entryEvidence(query, e);
    if (evidence) evidenceById.set(e.id, evidence);
  }
  const unverifiedIds = new Set(entries.filter((e) => e.unverified).map((e) => e.id));

  const results = hits.map((h) => {
    let matchedOn: MatchEvidence = "body";
    // Trust mark: label (never hide) hits on unverified entries/episodes.
    let unverified = /^status:\s*unverified\b/m.test(h.snippet);
    for (const id of h.memoryIds) {
      const evidence = evidenceById.get(id);
      if (evidence && EVIDENCE_RANK[evidence] > EVIDENCE_RANK[matchedOn]) {
        matchedOn = evidence;
      }
      if (unverifiedIds.has(id)) unverified = true;
    }
    return {
      path: h.path,
      snippet: sanitizeMemoryText(h.snippet),
      matchedOn,
      ...(unverified ? ({ unverified: true } as const) : {}),
    };
  });
  // Index entries with evidence the backend didn't surface (e.g. an alias
  // spelled differently than the stored text ranks): synthesize a hit from
  // the entry line itself so the exact match is never lost.
  const surfacedIds = new Set(hits.flatMap((h) => h.memoryIds));
  const syntheticIds: string[] = [];
  for (const e of entries) {
    const evidence = evidenceById.get(e.id);
    if (!evidence || surfacedIds.has(e.id)) continue;
    syntheticIds.push(e.id);
    results.push({
      path: `${bound.scope.root}/${MEMORY_INDEX_FILENAME}`,
      snippet: sanitizeMemoryText(e.raw),
      matchedOn: evidence,
      ...(e.unverified ? ({ unverified: true } as const) : {}),
    });
  }
  const recalledIds = Array.from(new Set([...hits.flatMap((h) => h.memoryIds), ...syntheticIds]));
  return { results, recalledIds };
}

export function memorySearchTool<P>(
  targets: LevelBoundScope<P>[],
  opts?: { recordUsage?: (scopeKey: string, memoryIds: string[]) => void | Promise<void> },
): MemoryTool {
  const multi = targets.length > 1;
  return tool({
    description:
      "Search your long-term episodic memory (notes from past sessions plus archived facts). " +
      "Use it when the conversation touches something you may already know — a preference, " +
      "an earlier decision, an ongoing issue — before asking the user to repeat themselves. " +
      (multi
        ? "It searches every one of your memory levels at once; each hit is tagged with its level. "
        : "") +
      "Search is keyword-based: prefer the vocabulary of your memory index (in your " +
      "instructions) — its exact terms and aliases match best — and when no index line " +
      "obviously matches, keep the user's key words in the query too. " +
      "Each hit carries matchedOn evidence (alias-exact | description | body) and the response " +
      "carries create_safety — consult it before creating anything with memory_save.",
    inputSchema: jsonSchema<{ query: string; limit?: number }>({
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for (topic, name, event)." },
        limit: { type: "number", description: multi ? "Max results per level (default 6)." : "Max results (default 6)." },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query, limit }) => {
      // Fan out across levels; a single-target search returns exactly the
      // classic shape (no level tags). Per-level failures degrade to empty
      // results rather than failing the whole search.
      const perScope = await Promise.all(
        targets.map(async (t) => {
          try {
            return { t, ...(await searchOneScope(t.bound, query, limit ?? 6)) };
          } catch {
            return { t, results: [], recalledIds: [] };
          }
        }),
      );
      const merged = perScope.flatMap(({ t, results }) =>
        results.map((r) => (multi ? { level: t.level, ...r } : r)),
      );
      // create_safety spans ALL levels: an exact match anywhere means the
      // memory exists — the safe signal for memory_save dedup.
      const create_safety = createSafetyOf(merged.map((r) => r.matchedOn));
      if (opts?.recordUsage) {
        for (const { t, recalledIds } of perScope) {
          if (recalledIds.length === 0) continue;
          // Fire-and-forget: retention bookkeeping must never fail or slow recall.
          void Promise.resolve(opts.recordUsage(t.bound.scope.key, recalledIds)).catch(() => {});
        }
      }
      return merged.length > 0
        ? { hits: merged, create_safety }
        : { hits: [], create_safety, note: "no matching memories" };
    },
  });
}

export function memorySaveTool<P>(
  bound: BoundScope<P>,
  opts: {
    agent: string;
    onEpisodeWritten?: (args: { path: string; name: string }) => void | Promise<void>;
    /** Invalidate the provider's cached index block for this scope. */
    invalidate?: () => void;
  },
): MemoryTool {
  return tool({
    description:
      "Save a durable note to your long-term memory NOW — use when the user explicitly asks " +
      "you to remember something, or states a lasting fact, preference, or decision. " +
      "Search first: call memory_search and only save something NEW when its create_safety " +
      'is not "exists". When it IS "exists", update the existing memory instead — save a ' +
      "correction/update note that names it (quote its [m-…] id) rather than restating the " +
      "fact as if new. Not for transient task details.",
    inputSchema: jsonSchema<{ note: string; slug?: string }>({
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "The durable fact(s) to remember, stated plainly (1-5 sentences).",
        },
        slug: {
          type: "string",
          description: "Short kebab-case topic for the note's filename (e.g. 'race-goal').",
        },
      },
      required: ["note"],
      additionalProperties: false,
    }),
    execute: async ({ note, slug }) => {
      const meta: EpisodeMeta = {
        agent: opts.agent,
        extractedAt: new Date().toISOString(),
        provenance: "user-requested",
      };
      const written = await bound.store.writeEpisode(bound.principal, bound.scope, {
        slug: slug ?? "remember",
        meta,
        summary: note.slice(0, 120),
        body: `## Facts\n- (user-requested) ${note.replace(/\n+/g, " ").trim()}`,
      });
      if (!written) return { saved: false, error: "memory store unreachable" };
      opts.invalidate?.();
      if (opts.onEpisodeWritten) {
        void Promise.resolve(opts.onEpisodeWritten(written)).catch(() => {});
      }
      return { saved: true, path: written.path };
    },
  });
}

// ---------------------------------------------------------------------------
// Job-facing tools (extractor / consolidator)
// ---------------------------------------------------------------------------

export function memoryReadIndexTool<P>(bound: BoundScope<P>): MemoryTool {
  return tool({
    description:
      "Read the current compiled memory index (MEMORY.md) for this scope. " +
      "Returns null when no index exists yet.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const index = await bound.store.readIndex(bound.principal, bound.scope);
      return { index: index ?? null };
    },
  });
}

/**
 * The extractor's cross-level index read: every participating level's compiled
 * index in one call, so "what is already known" covers each level it may
 * write to.
 */
export function memoryReadIndexesTool<P>(targets: LevelBoundScope<P>[]): MemoryTool {
  return tool({
    description:
      "Read the current compiled memory index (MEMORY.md) of every memory level in your task. " +
      "Returns null for levels with no index yet.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const indexes = await Promise.all(
        targets.map(async (t) => {
          const index = await t.bound.store.readIndex(t.bound.principal, t.bound.scope);
          return { level: t.level, index: index ?? null };
        }),
      );
      return { indexes };
    },
  });
}

export function memoryWriteEpisodeTool<P>(
  targets: LevelBoundScope<P>[],
  opts: {
    agent: string;
    chatId?: string;
    onEpisodeWritten?: (args: {
      level: MemoryScope;
      scope: ScopeRef;
      path: string;
      name: string;
    }) => void | Promise<void>;
    /**
     * Outcome of each write attempt — the same three-way distinction
     * `memoryWriteIndexTool` needs: episode written, nothing durable to write
     * (never called), or the store refused. Only the last may tombstone the
     * transcript window, and the run's answer can't tell them apart.
     */
    onWriteAttempt?: (ok: boolean) => void;
  },
): MemoryTool {
  const multi = targets.length > 1;
  const levels = targets.map((t) => t.level);
  return tool({
    description:
      "Write ONE immutable episode file capturing the durable memories from this transcript" +
      (multi
        ? " for ONE memory level. Call at most once per level, and only for levels with something durable to store."
        : ". Call at most once per run, and only when there is something durable to store."),
    inputSchema: jsonSchema<{
      level?: MemoryScope;
      slug: string;
      summary: string;
      happened?: string;
      facts: Array<{ text: string; provenance: "user-said" | "tool-derived" }>;
      aliases?: string[];
    }>({
      type: "object",
      properties: {
        ...(multi
          ? {
              level: {
                type: "string",
                enum: levels,
                description: "The memory level this episode belongs to (see your task).",
              },
            }
          : {}),
        slug: {
          type: "string",
          description: "Short kebab-case topic for the filename (e.g. 'calf-strain-week2').",
        },
        summary: { type: "string", description: "One-line summary of the episode." },
        happened: {
          type: "string",
          description: "2-4 sentences of session context (optional).",
        },
        facts: {
          type: "array",
          description: "The durable facts, each tagged with its origin.",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              provenance: { type: "string", enum: ["user-said", "tool-derived"] },
            },
            required: ["text", "provenance"],
            additionalProperties: false,
          },
        },
        aliases: {
          type: "array",
          items: { type: "string" },
          description:
            "Alternate lookup terms for the facts: names/spellings/nicknames of entities " +
            "(e.g. ['Robert Smith', 'Bob']) plus everyday recall keys when a fact's own " +
            "wording is technical or unusual (e.g. 'coffee' for a caffeine rule) — so " +
            "later keyword recall matches any form.",
        },
      },
      required: [...(multi ? ["level"] : []), "slug", "summary", "facts"],
      additionalProperties: false,
    }),
    execute: async ({ level, slug, summary, happened, facts, aliases }) => {
      // Route to the requested level; a single-target binding ignores the
      // param (there is nowhere else to go).
      const target = multi ? targets.find((t) => t.level === level) : targets[0];
      if (!target) {
        return {
          saved: false,
          error: `unknown level ${JSON.stringify(level)} — this run's levels are: ${levels.join(", ")}`,
        };
      }
      const bound = target.bound;
      // An empty facts list is not a store failure — the model chose to write
      // nothing. Left unreported so it stays a normal zero-yield run rather
      // than forcing a retry.
      if (facts.length === 0) return { saved: false, error: "no facts provided" };
      const provs = new Set(facts.map((f) => f.provenance));
      const provenance: Provenance = provs.size === 1 ? [...provs][0] : "mixed";
      const meta: EpisodeMeta = {
        chat: opts.chatId,
        agent: opts.agent,
        extractedAt: new Date().toISOString(),
        provenance,
        ...(aliases?.length ? { aliases } : {}),
        // Trust mark: everything the background extractor writes is
        // machine-inferred until the consolidator sees corroboration —
        // explicit memory_save episodes carry no status.
        status: "unverified",
      };
      const body = [
        ...(happened ? ["## What happened", happened.trim(), ""] : []),
        "## Facts",
        ...facts.map((f) => `- (${f.provenance}) ${f.text.replace(/\n+/g, " ").trim()}`),
      ].join("\n");
      const written = await bound.store.writeEpisode(bound.principal, bound.scope, {
        slug,
        meta,
        summary,
        body,
      });
      if (!written) {
        opts.onWriteAttempt?.(false);
        return { saved: false, error: "memory store unreachable" };
      }
      opts.onWriteAttempt?.(true);
      if (opts.onEpisodeWritten) {
        void Promise.resolve(
          opts.onEpisodeWritten({ level: target.level, scope: bound.scope, ...written }),
        ).catch(() => {});
      }
      return { saved: true, ...(multi ? { level: target.level } : {}), path: written.path };
    },
  });
}

export function memoryReadEpisodesTool<P>(bound: BoundScope<P>): MemoryTool {
  return tool({
    description: "Read episode files by path (the paths listed in your task).",
    inputSchema: jsonSchema<{ paths: string[] }>({
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
      additionalProperties: false,
    }),
    execute: async ({ paths }) => {
      // Scope lock: only paths strictly under this scope's root are readable
      // (segment-wise — a bare startsWith would pass `root-evil/x` and `..`).
      const inScope = paths.filter((p) => isUnderScopeRoot(bound.scope.root, p));
      const episodes = await bound.store.readEpisodes(bound.principal, bound.scope, inScope);
      return { episodes };
    },
  });
}

export function memoryWriteIndexTool<P>(
  bound: BoundScope<P>,
  opts?: {
    invalidate?: () => void;
    /** This level's index-schema outline — advisory, see below. */
    schema?: string;
    /**
     * Outcome of each write attempt. The caller needs it to tell three cases
     * apart that all look identical from the run's answer: the index was
     * rewritten, nothing needed changing (never called), and every attempt
     * failed. Only the last one must keep the episodes pending for a retry —
     * a model that gives up after a failed write still answers with a tidy
     * summary, so the answer alone cannot be trusted as proof of a write.
     */
    onWriteAttempt?: (ok: boolean) => void;
  },
): MemoryTool {
  // Schema adherence is ADVISORY: the first off-schema rewrite gets bounced
  // once through the problems loop so the model can self-correct; after that
  // the write always proceeds (with warnings) — a sweep must never wedge on
  // schema drift, unlike the hard rules validateIndexRewrite enforces.
  let schemaNudged = false;
  return tool({
    description:
      "Replace the compiled memory index (MEMORY.md) with a new version. The previous " +
      "version is snapshotted automatically. The rewrite is validated: hard line cap, no " +
      "duplicate ids, and no previously-active entry may disappear (move superseded/expired " +
      "entries under '## Archive'). On rejection you get the problems back — fix and retry.",
    inputSchema: jsonSchema<{ content: string }>({
      type: "object",
      properties: {
        content: { type: "string", description: "The complete new MEMORY.md content." },
      },
      required: ["content"],
      additionalProperties: false,
    }),
    execute: async ({ content }) => {
      const warnings = opts?.schema ? schemaSectionWarnings(opts.schema, content) : [];
      if (warnings.length > 0 && !schemaNudged) {
        schemaNudged = true;
        return {
          ok: false,
          problems: warnings.map((w) => `${w} (schema advisory — fix, or resubmit as-is to override)`),
        };
      }
      try {
        await bound.store.writeIndex(bound.principal, bound.scope, content);
        opts?.invalidate?.();
        opts?.onWriteAttempt?.(true);
        return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
      } catch (error) {
        opts?.onWriteAttempt?.(false);
        if (error instanceof IndexValidationError) {
          return { ok: false, problems: error.problems };
        }
        return {
          ok: false,
          error: String(error),
          // The model's own instructions say to re-read and retry once; say it
          // here too, where it lands next to the failure it applies to.
          retry:
            "Call memory_read_index, rebuild the rewrite on what it returns now, and retry once.",
        };
      }
    },
  });
}
