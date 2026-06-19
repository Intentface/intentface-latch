import type { AppMessage } from "./message.js";
import type { Scope } from "./principal.js";

/**
 * The single persistence contract.
 *
 * One adapter interface for every backend — no "SQL-only" tier. Drizzle
 * (Postgres/SQLite) is the first implementation; Mongo etc. are first-class
 * behind the same contract. Reads are scoped by `Scope` so tenant isolation is
 * enforced here, below the routes, where it can't be forgotten.
 *
 * v1 surface = the four tables in the plan: chats, messages, runs, usage.
 * `messages` is the source of truth (content + execution metadata on the row).
 */

export type RunStatus = "active" | "awaiting_input" | "completed" | "errored";

export interface ChatRecord {
  id: string;
  orgId: string;
  userId?: string;
  agent: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  chatId: string;
  agent: string;
  status: RunStatus;
  /** Single-writer lease (T2 durability). Null for T1 / non-durable runs. */
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  /** Monotonic per claim; bumped when reaped/reclaimed. Guards stale-writer writes. */
  fencingToken?: number | null;
  /** Last heartbeat time (observability; the lease expiry is the functional gate). */
  heartbeatAt?: number | null;
  /** How many times this run has been claimed (1 on first claim). */
  attempt?: number | null;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  costTotal?: number;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

/**
 * Proof of single-writer ownership for a run. Pass to guarded writes so a stale
 * worker (whose lease was reaped and reassigned) can't overwrite newer state —
 * the write only lands if `(owner, fencingToken)` still match the row.
 */
export interface RunLease {
  owner: string;
  fencingToken: number;
}

export interface UsageRecord {
  id: string;
  orgId: string;
  userId?: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  createdAt: number;
}

export interface StorageAdapter {
  // chats
  createChat(input: {
    /** Optional explicit id (e.g. a tenant-namespaced client key); generated if omitted. */
    id?: string;
    orgId: string;
    userId?: string;
    agent: string;
    title?: string;
  }): Promise<ChatRecord>;
  /** Scoped: returns null if the chat isn't in the caller's tenant. */
  getChat(scope: Scope, id: string): Promise<ChatRecord | null>;
  /** Scoped list of the tenant's chats, most-recently-updated first. */
  listChats(scope: Scope, opts?: { limit?: number }): Promise<ChatRecord[]>;
  /**
   * UNSCOPED system read — bypasses tenant scoping. Only for privileged
   * operations like resume/reaper that act on behalf of a run's tenant (the
   * tenant is recovered from the returned record). Never call this from a
   * request path; use `getChat(scope, id)` there.
   */
  getChatById(id: string): Promise<ChatRecord | null>;

  // messages (the source of truth)
  /** Scoped read of the conversation, oldest first. */
  loadMessages(scope: Scope, chatId: string): Promise<AppMessage[]>;
  /** Upsert messages by id (incremental per-step persistence is allowed). */
  appendMessages(chatId: string, messages: AppMessage[]): Promise<void>;

  // runs (per-turn execution record)
  /** T1 / non-durable: an unleased run. */
  createRun(input: { chatId: string; agent: string }): Promise<RunRecord>;
  /**
   * T2 durable: create a run already leased to `owner` (fencingToken starts at 1,
   * lease expires at now + ttlMs). The returned record carries the lease to hold.
   */
  claimRun(input: {
    chatId: string;
    agent: string;
    owner: string;
    ttlMs: number;
  }): Promise<RunRecord>;
  /**
   * Extend our lease by `ttlMs`. Returns false if we no longer own the active run
   * (it was reaped/reassigned or already closed) — the caller should stop work.
   */
  heartbeatRun(id: string, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * Re-claim an interrupted run for a new owner (resume). Succeeds only if the
   * run is not completed AND currently unowned or lease-expired — so two nodes
   * racing to resume the same run resolve to exactly one. Bumps the fencing
   * token and attempt, clears the error/end, and re-leases. Returns the
   * re-claimed record, or null if it wasn't resumable.
   */
  reclaimRun(
    id: string,
    owner: string,
    ttlMs: number,
  ): Promise<RunRecord | null>;
  /**
   * Patch a run. With `guard`, the write only applies while `(leaseOwner,
   * fencingToken)` still match — stale-writer protection (fencing). Without it,
   * an unconditional update (T1).
   */
  updateRun(
    id: string,
    patch: Partial<RunRecord>,
    guard?: RunLease,
  ): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Scoped list of the tenant's runs (joined via chats), most-recent first. */
  listRuns(scope: Scope, opts?: { limit?: number }): Promise<RunRecord[]>;
  /**
   * Reaper: mark active runs whose lease has expired (`leaseExpiresAt < now`) as
   * `errored`, clear the owner, and bump the fencing token (invalidating any
   * zombie holder). Returns the reaped runs. Safe to run on many nodes — each
   * row transitions once (the UPDATE is atomic per row).
   */
  reapExpiredRuns(
    now: number,
    opts?: { error?: string },
  ): Promise<RunRecord[]>;

  // usage (billing/quota ledger)
  recordUsage(input: Omit<UsageRecord, "id" | "createdAt">): Promise<void>;
}
