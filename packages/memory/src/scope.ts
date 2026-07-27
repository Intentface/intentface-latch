import type { MemoryConfig } from "@intentface/latch-core";
import type { ScopeRef } from "./types.js";

/**
 * Scope derivation: pure functions from (agent, memory config, caller
 * identity) to the folder a store lives in. Consolidation and search never
 * cross a scope boundary, so everything downstream keys off `ScopeRef.key`.
 */

/** FNV-1a 32-bit, hex — a short stable fingerprint (no crypto dependency). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Keep path segments filesystem/URL-safe and boundary-proof (no `/` or `..`).
 * Sanitization is many-to-one ("a/b" and "a-b" would collapse), and `key` is
 * the storage boundary — so whenever cleaning changed ANYTHING, a short hash
 * of the raw id is appended to keep distinct ids distinct. Already-clean ids
 * (the normal case: kebab agent names, alphanumeric user ids) pass through
 * untouched, so existing scope roots are stable.
 */
function seg(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === raw && cleaned) return cleaned;
  return `${cleaned || "x"}-${fnv1a(raw)}`;
}

export const MEMORY_ROOT_PREFIX = "_memory";

/**
 * Boundary-aware containment check for workspace paths: `path` must sit
 * strictly under `root`, segment-by-segment, with no `.`/`..`/empty segments —
 * so `root/../elsewhere` can't escape and `${root}-evil/x` can't prefix-match.
 */
export function isUnderScopeRoot(root: string, path: string): boolean {
  const rootParts = root.split("/").filter(Boolean);
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (parts.length <= rootParts.length) return false;
  return rootParts.every((p, i) => parts[i] === p);
}

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
