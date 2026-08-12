import type { MemoryConfig, MemoryProvider, MemoryScope } from "@intentface/latch-core";
import type { MemoryStore, ScopeRef } from "./types.js";
import { extractionLevelsOf, levelConfigOf, scopeLabelOf } from "./scope.js";
import { buildMemoryInstructionBlock } from "./prompts/inject.js";
import { memorySearchTool, memorySaveTool } from "./tools.js";
import type { LevelBoundScope } from "./tools.js";

export interface MemoryProviderOptions<P> {
  store: MemoryStore<P>;
  /**
   * Resolve the caller's scope (platform supplies user/org extraction from its
   * Principal — see `scopeRefOf`). Return undefined when the scope can't be
   * resolved (e.g. per-user scope, org-only principal) → memory is off for
   * that turn. Called once per participating level (with the level's config
   * view), so per-user levels drop out individually for userId-less callers.
   */
  scopeOf: (args: {
    principal: P;
    agent: string;
    memory: MemoryConfig;
  }) => ScopeRef | undefined;
  /** Retention signal: called when memory_search recalls entries. */
  recordUsage?: (scopeKey: string, memoryIds: string[]) => void | Promise<void>;
  /**
   * Job-store hook: called when a `memory_save` episode lands, so the scope is
   * marked dirty for the next consolidation pass.
   */
  onEpisodeWritten?: (args: {
    scopeKey: string;
    connection: string;
    agent: string;
    principal: P;
    path: string;
    name: string;
  }) => void | Promise<void>;
  /** Index cache TTL (default 60s). */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const CACHE_SWEEP_SIZE = 1_000;

/**
 * The runtime-facing MemoryProvider: compiles the always-loaded block — one
 * labeled index envelope per participating level (`extractTo`) — and binds
 * the agent-facing tools: `memory_search` fanning out across every level,
 * `memory_save` bound to the primary scope only. Never throws — a memory
 * failure degrades to a turn without memory.
 *
 * The TTL cache holds each scope's RAW index text (keyed by scope.key, shared
 * across agents that read the same level); the composed block is a cheap join
 * per call. Multi-level `memory_search` costs one backend search per level
 * per call — bounded by the level count (≤3).
 */
export function createMemoryProvider<P>(opts: MemoryProviderOptions<P>): MemoryProvider<P> {
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; index: string | undefined }>();

  function invalidate(scopeKey: string): void {
    cache.delete(scopeKey);
  }

  async function cachedIndex(principal: P, scope: ScopeRef): Promise<string | undefined> {
    const now = Date.now();
    const hit = cache.get(scope.key);
    if (hit && now - hit.at < ttl) return hit.index;
    const index = await opts.store.readIndex(principal, scope);
    if (cache.size >= CACHE_SWEEP_SIZE) {
      for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
    }
    cache.set(scope.key, { at: now, index });
    return index;
  }

  /** The turn's participating levels, each resolved to a scope (unresolvable ones drop). */
  function levelScopes(args: {
    principal: P;
    agent: string;
    memory: MemoryConfig;
  }): Array<{ level: MemoryScope; scope: ScopeRef; label: string }> {
    const out: Array<{ level: MemoryScope; scope: ScopeRef; label: string }> = [];
    for (const level of extractionLevelsOf(args.memory)) {
      const cfg = levelConfigOf(args.memory, level);
      const scope = opts.scopeOf({ principal: args.principal, agent: args.agent, memory: cfg });
      if (!scope) continue;
      out.push({ level, scope, label: scopeLabelOf(cfg) });
    }
    return out;
  }

  return {
    async instructionsFor({ principal, agent, memory }) {
      try {
        const levels = levelScopes({ principal, agent, memory });
        if (levels.length === 0) return undefined;
        const parts = await Promise.all(
          levels.map(async ({ level, scope, label }) => ({
            level,
            scopeLabel: label,
            index: await cachedIndex(principal, scope),
          })),
        );
        // The primary level always resolves first in extractionLevelsOf order
        // when resolvable; if it dropped (shouldn't happen — the runtime gates
        // memory on the primary scope), fall back to the first label.
        const primary = levels.find((l) => l.level === memory.scope) ?? levels[0];
        return buildMemoryInstructionBlock(parts, { primaryLabel: primary.label });
      } catch {
        return undefined;
      }
    },

    toolsFor({ principal, agent, memory }) {
      const levels = levelScopes({ principal, agent, memory });
      const primary = levels.find((l) => l.level === memory.scope);
      if (!primary) return {};
      const searchTargets: LevelBoundScope<P>[] = levels.map(({ level, scope }) => ({
        level,
        bound: { store: opts.store, principal, scope },
      }));
      const bound = { store: opts.store, principal, scope: primary.scope };
      return {
        memory_search: memorySearchTool(searchTargets, { recordUsage: opts.recordUsage }),
        memory_save: memorySaveTool(bound, {
          agent,
          invalidate: () => invalidate(primary.scope.key),
          onEpisodeWritten: opts.onEpisodeWritten
            ? ({ path, name }) =>
                opts.onEpisodeWritten!({
                  scopeKey: primary.scope.key,
                  connection: primary.scope.connection,
                  agent,
                  principal,
                  path,
                  name,
                })
            : undefined,
        }),
      };
    },
  };
}
