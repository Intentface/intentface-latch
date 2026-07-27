import type { MemoryConfig } from "@intentface/latch-core";
import type { ScopeRef } from "./types.js";

/**
 * Scope derivation: pure functions from (agent, memory config, caller
 * identity) to the folder a store lives in. Consolidation and search never
 * cross a scope boundary, so everything downstream keys off `ScopeRef.key`.
 */

/** Keep path segments filesystem/URL-safe and boundary-proof (no `/` or `..`). */
function seg(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-");
  return cleaned.replace(/^-+|-+$/g, "") || "x";
}

export const MEMORY_ROOT_PREFIX = "_memory";

/**
 * Resolve the scope folder for a caller, or undefined when the scope needs a
 * user but the principal carries none (e.g. an org-only principal hitting a
 * per-user scope) — memory is simply unavailable for that turn.
 */
export function scopeRefOf(args: {
  agent: string;
  memory: MemoryConfig;
  userId?: string;
}): ScopeRef | undefined {
  const { agent, memory, userId } = args;
  const needsUser = memory.scope === "agent-user" || memory.scope === "user";
  if (needsUser && !userId) return undefined;
  const root =
    memory.scope === "agent-user"
      ? `${MEMORY_ROOT_PREFIX}/${seg(agent)}/u-${seg(userId!)}`
      : memory.scope === "agent-org"
        ? `${MEMORY_ROOT_PREFIX}/${seg(agent)}/org`
        : // `user`: shared across the user's agents — the agent segment is the
          // literal `_user` so every agent resolves the same folder.
          `${MEMORY_ROOT_PREFIX}/_user/u-${seg(userId!)}`;
  return { key: `${memory.connection}:${root}`, connection: memory.connection, root };
}

/** Human-readable scope label for prompts and UI. */
export function scopeLabelOf(memory: MemoryConfig): string {
  switch (memory.scope) {
    case "agent-user":
      return "this agent's memory of this user";
    case "agent-org":
      return "this agent's shared memory for the whole organization";
    case "user":
      return "this user's memory, shared across their agents";
  }
}
