import type { AppMessage } from "./message.js";

/**
 * The single persistence contract.
 *
 * One adapter interface for every backend — no "SQL-only" tier. Drizzle
 * (Postgres/SQLite) is the first implementation; Mongo etc. are first-class
 * behind the same contract.
 *
 * Isolation lives HERE, not in the framework. Per-principal methods receive the
 * opaque customer `Principal` (`P`); the adapter scopes by it however it wants
 * (the default adapter derives an `owner` key; a custom one can use RLS / its
 * own schema). The framework never reads a field of `P`. System ops (the reaper
 * / resume) act by id without a principal and recover identity from the run.
 *
 * CONTRACT — the owner key is derived ONCE, at root-resource creation; child
 * rows inherit their parent's stamped owner (messages → chat, usage → run,
 * OAuth tokens → the flow that started them). Never re-derive an owner from a
 * live principal in a DIFFERENT request context than the one that created the
 * root — callbacks, webhooks, and cron arrive with degraded or absent
 * sessions, and a re-derived key silently lands data in the wrong bucket.
 * Identity that must cross requests is pinned as data (a run's identity blob,
 * the OAuth flow state) and rebuilt via `reconstructPrincipal`.
 *
 * v1 surface = the four tables in the plan: chats, messages, runs, usage.
 * `messages` is the source of truth (content + execution metadata on the row).
 */

export type RunStatus = "active" | "awaiting_input" | "completed" | "errored";

/**
 * Thrown by `createChat` when the requested chat id already exists (typically a
 * client-supplied id colliding with a chat the caller doesn't own — the scoped
 * `getChat` missed, so the create raced into the PK). Carries a stable `code`
 * so the server layer can map it to a 409 instead of a 500.
 */
export class ChatConflictError extends Error {
  readonly code = "chat_conflict";
  constructor(chatId: string) {
    super(`Chat id is not available: ${chatId}`);
    this.name = "ChatConflictError";
  }
}

/**
 * Thrown by `createRun` / `claimRun` when the chat already has a LIVE active
 * run — one turn per conversation is a storage-level invariant (a partial
 * unique index in the shipped adapters), so two tabs, a webhook retry racing a
 * reply, or a schedule firing mid-conversation can never interleave one
 * history. `retryAfterMs` is the live run's remaining lease (or the stale
 * timeout for a non-durable run). Stable `code` → the server maps it to 409.
 */
export class ChatBusyError extends Error {
  readonly code = "chat_busy";
  constructor(
    readonly chatId: string,
    /** Milliseconds until the live run's lease expires — when a retry can succeed at the latest. */
    readonly retryAfterMs: number,
  ) {
    super(`A turn is already running in this chat; try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = "ChatBusyError";
  }
}

export function isChatBusyError(e: unknown): e is ChatBusyError {
  return (e as { code?: string } | null)?.code === "chat_busy";
}

export interface ChatRecord {
  id: string;
  /** Opaque ownership key the adapter scoped this row by (e.g. `tenant/user`). */
  owner: string;
  agent: string;
  title?: string;
  /**
   * What kind of chat this is. `'user'` (the default) = a user-facing
   * conversation; `'internal'` = a runtime-created sub-thread (the `sub_…`
   * chats `spawn_agent` mints) that should stay out of the main chat list.
   * Open vocabulary — a host may stamp its own kinds via `createChat`.
   */
  kind?: string;
  /**
   * Status of the chat's most recent run, derived at READ time by `listChats`
   * (never stored — the message log stays the source of truth). Lets a list UI
   * flag chats parked on a human (`awaiting_input` = an approval or question is
   * waiting) without loading each chat's messages. "Most recent" makes it
   * self-healing: a continuation opens a new run, so a superseded pause stops
   * showing the moment the conversation moves on. Optional — an adapter MAY
   * omit it, and `getChat`/`createChat` never populate it.
   */
  lastRunStatus?: RunStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  chatId: string;
  agent: string;
  status: RunStatus;
  /**
   * Opaque identity blob (the serialized `Principal`) captured when the run was
   * created, so resume/cron — which have no request — can rebuild the principal
   * via `reconstructPrincipal`. Never interpreted by the framework.
   */
  identity?: unknown;
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
  usageCacheReadTokens?: number;
  usageCacheWriteTokens?: number;
  costTotal?: number;
  /**
   * Run kind: `'turn'` (default when absent) vs `'compaction'` (the runtime's
   * internal summarize-and-mark run) — lets stats/rollups exclude non-turn runs.
   */
  kind?: string | null;
  /**
   * Opaque fingerprint of the turn's sorted tool names — same hash ⇔ same
   * toolset, so churn across a chat's runs (MCP drops, auth-gated `connect_*`
   * toggles) is detectable without storing the full list. Produced by
   * `toolsetHash` (currently 16 hex chars); treat the width as unspecified and
   * store it as variable-length text.
   */
  toolsHash?: string | null;
  /**
   * The stored agent-record version this run STARTED on
   * (`AgentConfig.configVersion`). Null for code-declared agents, which have no
   * stored record.
   *
   * Written when the run is opened, not when it settles — a run that errors or
   * crashes never reaches a terminal update, and "which version produced these
   * failures" is exactly the question worth answering. It stays fixed across a
   * resume, so it remains the anchor for pinning a resumed run to the
   * configuration it began with.
   *
   * Per-execution attribution is a telemetry concern instead: each turn tags its
   * trace with the version it actually resolved, so a run resumed after a
   * publish shows both on one trace.
   */
  agentVersion?: number | null;
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
  /** Opaque ownership key (for per-tenant billing/quota rollups). */
  owner: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache breakdown (subsets of `inputTokens`); absent = none reported. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  createdAt: number;
}

/**
 * A scheduled agent run. Like a run, it carries the opaque `identity` blob so a
 * cron tick (no request) can rebuild the principal and run the turn. `cron` is a
 * customer-evaluated expression (the runtime takes a `cron` evaluator); null =
 * one-shot.
 *
 * The `lease` alone does NOT make an occurrence exactly-once: it is stamped at
 * claim time and never renewed, so it only serializes claimers within one TTL.
 * What prevents a double fire is the runtime consuming the occurrence
 * (advancing `nextRunAt` via `completeSchedule`) immediately after the claim,
 * before the fire — after that write the row is no longer due, whatever the
 * lease says.
 */
export interface ScheduleRecord {
  id: string;
  /** Opaque ownership key derived from the principal. */
  owner: string;
  agent: string;
  /** Serialized Principal blob — rebuilt at fire time via `reconstructPrincipal`. */
  identity?: unknown;
  /** Cron expression (evaluated by the runtime's `cron` fn); null = one-shot. */
  cron: string | null;
  /** IANA timezone the cron is interpreted in (e.g. "Europe/Helsinki"); UTC if unset. */
  timezone?: string;
  /** The user message to send the agent each fire. */
  prompt: string;
  /**
   * Where this schedule's output should go, or undefined for the default
   * (a fresh chat, no push). OPAQUE to core, exactly like `identity`: only the
   * host's `runSchedule` hook interprets it, so core never learns what a
   * "channel" is. Hosts should keep it small and JSON-serializable.
   */
  delivery?: unknown;
  /** Epoch ms of the next due fire. */
  nextRunAt: number;
  lastRunAt?: number | null;
  /**
   * What a fire does when the PREVIOUS fire's chat is still parked waiting on
   * a human (an undecided approval or question). `"skip"` (the default when
   * absent) consumes the occurrence without running — no new parked chat, no
   * paid tokens, and the next occurrence re-checks. `"fire"` always runs
   * (pre-existing behavior): pick it for schedules whose every occurrence
   * matters even while one waits, e.g. a daily digest.
   */
  onParked?: "skip" | "fire";
  /**
   * The chat the LAST default-path fire ran in (stamped via
   * `noteScheduleFire`), so the next occurrence can see a parked predecessor.
   * Null/absent until the first fire, or when the host's `runSchedule` hook
   * handles fires itself.
   */
  lastChatId?: string | null;
  enabled: boolean;
  /** Single-fire lease (exactly-once claim), same shape as runs. */
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  createdAt: number;
}

export interface StorageAdapter<P> {
  // chats
  createChat(
    principal: P,
    input: {
      /** Optional explicit id (e.g. a client-chosen key); generated if omitted. */
      id?: string;
      agent: string;
      title?: string;
      /** Chat kind (see `ChatRecord.kind`). Defaults to `'user'`. */
      kind?: string;
    },
  ): Promise<ChatRecord>;
  /** Scoped: returns null if the chat isn't the caller's. */
  getChat(principal: P, id: string): Promise<ChatRecord | null>;
  /**
   * Scoped list of the caller's chats, most-recently-updated first.
   * `opts.kind` filters to one kind (e.g. `'user'` for a sidebar that must not
   * show internal sub-threads); omitted → ALL kinds (back-compatible default).
   */
  listChats(
    principal: P,
    opts?: { limit?: number; kind?: string },
  ): Promise<ChatRecord[]>;

  // messages (the source of truth)
  /** Scoped read of the conversation, oldest first. */
  loadMessages(principal: P, chatId: string): Promise<AppMessage[]>;
  /** Upsert messages by id (incremental per-step persistence is allowed). */
  appendMessages(chatId: string, messages: AppMessage[]): Promise<void>;

  // runs (per-turn execution record)
  /** T1 / non-durable: an unleased run. Stores the identity blob for resume. */
  /**
   * Open a non-durable run. ONE ACTIVE RUN PER CHAT: throws `ChatBusyError` if
   * the chat already has a live active run. An active run with no lease that is
   * older than the adapter's stale timeout is superseded (marked errored) first,
   * so a crashed non-durable turn can't block its chat forever.
   */
  createRun(
    principal: P,
    input: { chatId: string; agent: string; kind?: string; agentVersion?: number | null },
  ): Promise<RunRecord>;
  /**
   * T2 durable: create a run already leased to `owner` (fencingToken starts at 1,
   * lease expires at now + ttlMs). `owner` here is the LEASE owner (instance id),
   * unrelated to tenancy. Stores the identity blob for resume.
   */
  claimRun(input: {
    principal: P;
    chatId: string;
    agent: string;
    owner: string;
    ttlMs: number;
    agentVersion?: number | null;
  }): Promise<RunRecord>;
  /**
   * Open a turn ATOMICALLY: the run row (the one-active-run-per-chat check) and
   * the messages that start it — a fresh user message, or the assistant message
   * a decision / tool result just changed — in one transaction, so a refused
   * turn persists nothing and a crash can never leave a run without its
   * messages (or vice versa). Messages upsert by (chat, id) like `appendMessages`. With
   * `lease`, the run is claimed durably like `claimRun`; without, like
   * `createRun`. Optional for compatibility: the runtime falls back to run-
   * then-message when an adapter doesn't implement it — but that fallback has a
   * crash window (a run without its message), so a DURABLE adapter should
   * implement `openTurn` atomically. The shipped adapters do, in every driver.
   */
  openTurn?(
    principal: P,
    input: {
      chatId: string;
      agent: string;
      messages: AppMessage[];
      lease?: { owner: string; ttlMs: number };
      agentVersion?: number | null;
    },
  ): Promise<RunRecord>;
  // ↑ Same one-active-run-per-chat rule as `createRun`: a live lease on another
  //   run of this chat → `ChatBusyError`; an EXPIRED lease is superseded (the
  //   new message moves the conversation on — the same rule as a new message
  //   closing a pending approval) and the fencing token bumped so the old
  //   worker's late writes are refused.
  /**
   * Extend our lease by `ttlMs`. Fenced: the extension only applies while
   * `(owner, fencingToken)` still match the row, so a stale holder whose run was
   * reaped and re-claimed (same owner id, bumped token) can't resurrect the
   * lease. Returns false if we no longer own the active run — stop work.
   */
  heartbeatRun(
    id: string,
    owner: string,
    ttlMs: number,
    fencingToken: number,
  ): Promise<boolean>;
  /**
   * Re-claim an interrupted run for a new owner (resume). Succeeds only if the
   * run is not completed AND was leased at some point with the lease now
   * expired (`leaseExpiresAt < now`) — so two nodes racing to resume the same
   * run resolve to exactly one, and a live never-leased (T1) run can never be
   * seized out from under its writer. Bumps the fencing
   * token and attempt, clears the error/end, and re-leases. Returns the
   * re-claimed record (carrying `identity`), or null if it wasn't resumable.
   */
  reclaimRun(
    id: string,
    owner: string,
    ttlMs: number,
  ): Promise<RunRecord | null>;
  // ↑ Also null when the chat has since started a NEWER active run (the crashed
  //   turn was superseded by a fresh message) — resuming it would interleave.
  /**
   * Patch a run. With `guard`, the write only applies while `(leaseOwner,
   * fencingToken)` still match — stale-writer protection (fencing). Without it,
   * an unconditional update (T1). Returns whether the patch was applied — a
   * guarded caller must treat `false` as "I'm a stale writer" and skip any
   * follow-up persistence.
   */
  updateRun(
    id: string,
    patch: Partial<RunRecord>,
    guard?: RunLease,
  ): Promise<boolean>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Scoped list of the caller's runs (joined via chats), most-recent first. */
  listRuns(principal: P, opts?: { limit?: number }): Promise<RunRecord[]>;
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
  recordUsage(
    principal: P,
    input: Omit<UsageRecord, "id" | "createdAt" | "owner">,
  ): Promise<void>;

  // schedules (cron-driven agent runs)
  /** Create a schedule owned by the caller; stores the identity blob for fire-time. */
  createSchedule(
    principal: P,
    input: {
      agent: string;
      cron: string | null;
      timezone?: string;
      prompt: string;
      nextRunAt: number;
      /** Host-defined delivery target, stored verbatim (see `ScheduleRecord.delivery`). */
      delivery?: unknown;
      /** Parked-predecessor policy (see `ScheduleRecord.onParked`); absent = `"skip"`. */
      onParked?: "skip" | "fire";
    },
  ): Promise<ScheduleRecord>;
  /** The caller's schedules, most-recently-created first. */
  listSchedules(principal: P): Promise<ScheduleRecord[]>;
  /** Delete one of the caller's schedules. */
  deleteSchedule(principal: P, id: string): Promise<void>;
  /**
   * Make one of the caller's schedules due immediately ("run now"): set
   * `nextRunAt` to 0 so the next `runDue` claims it through the ordinary path.
   * Owner-fenced like `deleteSchedule`, and enabled-only — a finished one-shot
   * shouldn't be resurrectable by re-arming its clock.
   *
   * Returns whether a schedule was actually armed, so a caller can tell "it's
   * queued" from "unknown, not yours, or already spent" instead of reporting
   * success for a no-op.
   */
  bumpSchedule(principal: P, id: string): Promise<boolean>;
  /**
   * System op (no principal): atomically claim due schedules (`enabled`,
   * `nextRunAt <= now`, lease unset/expired) for `owner`, stamping a lease.
   * Returns the claimed records (with `identity`). Mirrors the run reclaim
   * transition.
   *
   * The lease serializes claimers only within one `ttlMs` window — it is never
   * renewed, and the predicate re-claims (same owner included) the moment it
   * expires. Callers MUST consume the occurrence via `completeSchedule` before
   * doing anything slower than the TTL, or a long fire is re-claimable for its
   * whole duration.
   */
  claimDueSchedules(now: number, ttlMs: number, owner: string): Promise<ScheduleRecord[]>;
  /**
   * Consume a claimed occurrence: advance `nextRunAt`/`enabled`, set
   * `lastRunAt`, clear the lease. The runtime calls this between the claim and
   * the fire — after this write the row is no longer due (or no longer
   * enabled), so the occurrence cannot be claimed twice. Fenced by `owner`:
   * only the node holding the claim lease may apply it, so a node whose lease
   * expired can't clobber a newer claim.
   *
   * Return `false` when the fence rejected the write (another node now holds
   * the claim): the runtime then does NOT fire, since the new holder owns the
   * occurrence and firing too would be a duplicate paid turn. `true` or
   * `void` means applied — `void` keeps adapters written before this signal
   * existed working, at the cost of that protection.
   */
  completeSchedule(
    id: string,
    patch: { nextRunAt: number; lastRunAt: number; enabled: boolean },
    owner: string,
  ): Promise<boolean | void>;
  /**
   * OPTIONAL system op (no principal): remember which chat a fire ran in, so
   * the next occurrence can check `onParked` against it. Best-effort, and
   * fenced by the OCCURRENCE rather than the lease: `firedAt` is the
   * `lastRunAt` this fire's `completeSchedule` just wrote, and the stamp only
   * lands while the row still carries it — a delayed stamp from an older fire
   * no-ops once a newer occurrence has consumed (e.g. a `runScheduleNow` bump
   * overlapping a long turn), so `lastChatId` always names the newest fire's
   * chat. ACCEPTED residual: two occurrences consumed in the SAME millisecond
   * share a fence value — that takes a consume + bump + re-claim + re-consume
   * across independent actors inside 1ms, and the worst outcome is one
   * skipped or one extra fire that self-corrects next occurrence; closing it
   * would mean widening `completeSchedule`'s contract to return a unique
   * revision, which this best-effort field doesn't justify. Adapters that
   * don't implement it simply never skip parked fires (the pre-`onParked`
   * behavior).
   */
  noteScheduleFire?(
    id: string,
    patch: { lastChatId: string; firedAt: number },
  ): Promise<void>;
}
