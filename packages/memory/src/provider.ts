import type { MemoryConfig, MemoryProvider } from "@intentface/latch-core";
import type { MemoryStore, ScopeRef } from "./types.js";
import { scopeLabelOf } from "./scope.js";
import { buildMemoryInstructionBlock } from "./prompts/inject.js";
import { memorySearchTool, memorySaveTool } from "./tools.js";

export interface MemoryProviderOptions<P> {
  store: MemoryStore<P>;
  /**
   * Resolve the caller's scope (platform supplies user/org extraction from its
   * Principal — see `scopeRefOf`). Return undefined when the scope can't be
   * resolved (e.g. per-user scope, org-only principal) → memory is off for
   * that turn.
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
  /** Index-block cache TTL (default 60s). */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const CACHE_SWEEP_SIZE = 1_000;

/**
 * The runtime-facing MemoryProvider: compiles the always-loaded block (TTL
 * cached per scope) and binds the agent-facing tools. Never throws — a memory
 * failure degrades to a turn without memory.
 */
export function createMemoryProvider<P>(opts: MemoryProviderOptions<P>): MemoryProvider<P> {
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; block: string }>();

  function invalidate(scopeKey: string): void {
    cache.delete(scopeKey);
  }

  return {
    async instructionsFor({ principal, agent, memory }) {
      try {
        const scope = opts.scopeOf({ principal, agent, memory });
        if (!scope) return undefined;
        const now = Date.now();
        const hit = cache.get(scope.key);
        if (hit && now - hit.at < ttl) return hit.block;
        const index = await opts.store.readIndex(principal, scope);
        const block = buildMemoryInstructionBlock(index, {
          scopeLabel: scopeLabelOf(memory),
        });
        if (cache.size >= CACHE_SWEEP_SIZE) {
          for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
        }
        cache.set(scope.key, { at: now, block });
        return block;
      } catch {
        return undefined;
      }
    },

    toolsFor({ principal, agent, memory }) {
      const scope = opts.scopeOf({ principal, agent, memory });
      if (!scope) return {};
      const bound = { store: opts.store, principal, scope };
      return {
        memory_search: memorySearchTool(bound, { recordUsage: opts.recordUsage }),
        memory_save: memorySaveTool(bound, {
          agent,
          invalidate: () => invalidate(scope.key),
          onEpisodeWritten: opts.onEpisodeWritten
            ? ({ path, name }) =>
                opts.onEpisodeWritten!({
                  scopeKey: scope.key,
                  connection: scope.connection,
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
