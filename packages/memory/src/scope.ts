import type { MemoryConfig, MemoryScope } from "@intentface/latch-core";
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
 * Loredex's per-user private root folder (`is_root=1`, `visibility='private'`,
 * owner-only ACL). Every workspace member has exactly one; the server creates
 * it on join (`ensureUserPrivateRoot`), so it always exists and is never
 * created by us. Folders created under it inherit `private` visibility, which
 * is what makes per-user memory scopes actually private — unlike the shared
 * `_memory/**` tree, where per-user separation is only a folder convention.
 *
 * The path segment is caller-relative: the same literal resolves to a
 * DIFFERENT physical folder per authenticated user. Scope roots under it keep
 * their `u-<id>` leaf anyway — see `scopeRefOf` for why.
 */
export const LOREDEX_PRIVATE_ROOT = "__private_root";

/**
 * Loredex's workspace-shared root folder (`is_root=1`, `visibility='shared'`,
 * unowned). Exactly one per workspace, provisioned by the server, rendered as
 * "Shared" in the UI — never created by us.
 *
 * Shared memory paths MUST anchor here. Loredex resolves bare path heads
 * caller-relatively (any accessible folder of that name, oldest first), so an
 * unanchored `_memory/...` can silently resolve to the CALLER'S OWN
 * `__private_root/_memory` — fragmenting "org" memory into per-user private
 * copies with no visible error (each user reads their own copy back
 * consistently). Found live 2026-08-13; anchoring the head is the fix on our
 * side of the seam.
 */
export const LOREDEX_SHARED_ROOT = "__shared_root";

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
  // Per-user scopes are stored under the caller's PRIVATE root so only that
  // user (and connections acting as them) can read them. The layout mirrors
  // the shared tree (`<agent>` per agent, the literal `_user` for the
  // cross-agent scope) so subtrees stay disjoint (hard boundary). The
  // `u-<id>` leaf is kept even though the private root is already per-user:
  // it makes the root globally unique (the key stays `${connection}:${root}`)
  // and, on a workspace-SHARED connection — where every caller resolves the
  // connection identity's one private root — it keeps users' stores from
  // merging into a single MEMORY.md.
  const root =
    memory.scope === "agent-user"
      ? `${LOREDEX_PRIVATE_ROOT}/${MEMORY_ROOT_PREFIX}/${seg(agent)}/u-${seg(userId!)}`
      : memory.scope === "agent-org"
        ? // Anchored at the shared root — an unanchored `_memory/...` head
          // resolves caller-relatively and can land in the caller's private
          // tree (see LOREDEX_SHARED_ROOT).
          `${LOREDEX_SHARED_ROOT}/${MEMORY_ROOT_PREFIX}/${seg(agent)}/org`
        : `${LOREDEX_PRIVATE_ROOT}/${MEMORY_ROOT_PREFIX}/_user/u-${seg(userId!)}`;
  return { key: `${memory.connection}:${root}`, connection: memory.connection, root };
}

/**
 * The levels this agent's memory participates in: `extractTo` normalized —
 * deduplicated, primary scope first, and always containing the primary scope
 * whether or not the stored config lists it. Every multi-level reader
 * (provider injection/search, sweep extraction) derives its level set here so
 * a denormalized stored config can't split behavior.
 */
export function extractionLevelsOf(memory: MemoryConfig): MemoryScope[] {
  const out: MemoryScope[] = [memory.scope];
  for (const level of memory.extractTo ?? []) {
    if (!out.includes(level)) out.push(level);
  }
  return out;
}

/**
 * The per-level view of a memory config: same connection and tuning, `scope`
 * swapped to `level` — so `scopeRefOf`/`scopeLabelOf` work per level for free.
 */
export function levelConfigOf(memory: MemoryConfig, level: MemoryScope): MemoryConfig {
  return level === memory.scope ? memory : { ...memory, scope: level };
}

/** Human-readable scope label for prompts and UI. */
export function scopeLabelOf(memory: MemoryConfig): string {
  switch (memory.scope) {
    case "agent-user":
      return "this agent's private memory of this user";
    case "agent-org":
      return "this agent's shared memory for the whole organization";
    case "user":
      return "this user's private memory, shared across their agents";
  }
}
