import { tool, jsonSchema } from "ai";
import type { EpisodeMeta, MemoryStore, Provenance, ScopeRef } from "./types.js";
import { IndexValidationError } from "./index-file.js";
import { isUnderScopeRoot } from "./scope.js";

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
 * Explicit (portable) shape for the authored tools — declaration emit cannot
 * name the AI SDK's inferred `Tool<…>` type across package boundaries
 * (TS2742), and agent configs only need `Record<string, unknown>` anyway.
 */
export interface MemoryTool {
  description?: unknown;
  inputSchema: unknown;
  execute?: (input: never, options: never) => unknown;
}

export function memorySearchTool<P>(
  bound: BoundScope<P>,
  opts?: { recordUsage?: (scopeKey: string, memoryIds: string[]) => void | Promise<void> },
): MemoryTool {
  return tool({
    description:
      "Search your long-term episodic memory (notes from past sessions plus archived facts). " +
      "Use it when the conversation touches something you may already know — a preference, " +
      "an earlier decision, an ongoing issue — before asking the user to repeat themselves.",
    inputSchema: jsonSchema<{ query: string; limit?: number }>({
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for (topic, name, event)." },
        limit: { type: "number", description: "Max results (default 6)." },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query, limit }) => {
      const hits = await bound.store.search(bound.principal, bound.scope, query, limit ?? 6);
      if (hits.length > 0 && opts?.recordUsage) {
        const ids = Array.from(new Set(hits.flatMap((h) => h.memoryIds)));
        // Fire-and-forget: retention bookkeeping must never fail or slow recall.
        void Promise.resolve(opts.recordUsage(bound.scope.key, ids)).catch(() => {});
      }
      return hits.length > 0
        ? { hits: hits.map((h) => ({ path: h.path, snippet: h.snippet })) }
        : { hits: [], note: "no matching memories" };
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
      "Not for transient task details.",
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

export function memoryWriteEpisodeTool<P>(
  bound: BoundScope<P>,
  opts: {
    agent: string;
    chatId?: string;
    onEpisodeWritten?: (args: { path: string; name: string }) => void | Promise<void>;
  },
): MemoryTool {
  return tool({
    description:
      "Write ONE immutable episode file capturing the durable memories from this transcript. " +
      "Call at most once per run, and only when there is something durable to store.",
    inputSchema: jsonSchema<{
      slug: string;
      summary: string;
      happened?: string;
      facts: Array<{ text: string; provenance: "user-said" | "tool-derived" }>;
    }>({
      type: "object",
      properties: {
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
      },
      required: ["slug", "summary", "facts"],
      additionalProperties: false,
    }),
    execute: async ({ slug, summary, happened, facts }) => {
      if (facts.length === 0) return { saved: false, error: "no facts provided" };
      const provs = new Set(facts.map((f) => f.provenance));
      const provenance: Provenance = provs.size === 1 ? [...provs][0] : "mixed";
      const meta: EpisodeMeta = {
        chat: opts.chatId,
        agent: opts.agent,
        extractedAt: new Date().toISOString(),
        provenance,
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
      if (!written) return { saved: false, error: "memory store unreachable" };
      if (opts.onEpisodeWritten) {
        void Promise.resolve(opts.onEpisodeWritten(written)).catch(() => {});
      }
      return { saved: true, path: written.path };
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
  opts?: { invalidate?: () => void },
): MemoryTool {
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
      try {
        await bound.store.writeIndex(bound.principal, bound.scope, content);
        opts?.invalidate?.();
        return { ok: true };
      } catch (error) {
        if (error instanceof IndexValidationError) {
          return { ok: false, problems: error.problems };
        }
        return { ok: false, error: String(error) };
      }
    },
  });
}
