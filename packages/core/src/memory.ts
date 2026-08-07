/**
 * Memory seam.
 *
 * An agent that declares `memory` (see `AgentConfig.memory`) gets persistent
 * cross-session memory when the runtime is composed with a `MemoryProvider`
 * (`RuntimeConfig.memory`). Core knows nothing about where memories live — the
 * provider (e.g. `@intentface/latch-memory`) owns storage, retrieval, and the
 * background extraction/consolidation jobs. Core's only job is the per-turn
 * wiring: append the provider's compiled-index block to the agent's
 * instructions and merge its scope-bound tools into the toolset.
 */

/**
 * Who one memory store is about — and who can see it.
 *
 * - `agent-user`: one store per (agent, user). The default fit for personal
 *   agents (a coach's memory of *you*).
 * - `agent-org`: one store per (agent, org) — all org users share it.
 * - `user`: one store per user, shared across every agent that declares the
 *   same scope AND the same `connection` (a different connection silently
 *   splits the store — validate at the surface, not here).
 *
 * Search and consolidation never cross a scope boundary.
 */
export type MemoryScope = "agent-user" | "agent-org" | "user";

/** An agent's memory declaration (`AgentConfig.memory`). */
export interface MemoryConfig {
  scope: MemoryScope;
  /**
   * The connection (runtime connection-registry name, e.g. `"loredex"`) whose
   * workspace holds this agent's memory files. The provider opens it itself,
   * per operation — memory does not require the agent to also list it in
   * `connections` (though agents typically do).
   */
  connection: string;
  /** Background extraction tuning (used by the provider's job sweep, not core). */
  extraction?: {
    /** Chat idle time before a transcript is eligible for extraction (default 60). */
    idleMinutes?: number;
  };
  /** Background consolidation tuning (used by the provider's job sweep, not core). */
  consolidation?: {
    /** Minimum time between consolidations of one scope (default 6). */
    cooldownHours?: number;
  };
}

/**
 * The runtime's memory seam (`RuntimeConfig.memory`). Both methods are called
 * once per turn, only for agents that declare `memory`.
 */
export interface MemoryProvider<P> {
  /**
   * The always-loaded system block for this scope: the compiled memory index
   * plus standing usage instructions, or `undefined` when the store is empty
   * or unreachable. MUST resolve fast (provider-side cache) and MUST NOT
   * throw — a memory failure degrades to a turn without memory, never a dead
   * turn (the runtime also guards with a `.catch`).
   */
  instructionsFor(args: {
    principal: P;
    agent: string;
    memory: MemoryConfig;
  }): Promise<string | undefined>;
  /**
   * The scope-bound memory tools for this turn (e.g. `memory_search`,
   * `memory_save`). Returned synchronously — tool `execute` opens connections
   * lazily. Merged as capability tools, so an agent's `enabledTools`
   * restriction never hides them.
   */
  toolsFor(args: {
    principal: P;
    agent: string;
    memory: MemoryConfig;
  }): Record<string, unknown>;
}
