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
 * Whose record an id-only call acts on: the owner key the adapter itself put
 * on the record (`ChatRecord.owner`, `RunRecord.ownerKey`,
 * `ScheduleRecord.owner`), handed back by the runtime. Calls such as
 * `updateRun(id)` otherwise carry only an id.
 *
 * An adapter may use it two ways, or ignore it:
 *  - **Check:** refuse a call whose key doesn't match the row's owner by
 *    throwing `OwnerKeyMismatchError`, so a bug can't write into another
 *    owner's run or chat.
 *  - **Route:** an adapter that keeps each tenant apart (a schema or a
 *    database each) reads the tenant from the key (`decodeOwnerKey`) and goes
 *    straight to it, with no global index of ids.
 *
 * The runtime passes it on every id-only call whenever the record it acts on
 * carries a key (and the principal instead where it holds no record yet). The two cross-owner sweeps (`reapExpiredRuns`,
 * `claimDueSchedules`) have no owner to start from: a per-tenant adapter keeps
 * a global table of active leases and due schedules for them, and returns the
 * key on each record so the calls that follow carry it.
 */
export interface OwnerScope<P = unknown> {
  ownerKey?: string;
  /**
   * The person the call is made for, on the one call the runtime makes with no
   * record in hand yet: `runtime.getRun({ principal, runId })`. Derive the key
   * from it the way your principal-scoped methods do.
   */
  principal?: P;
}

/**
 * Thrown by an adapter when an id-only call's `OwnerScope.ownerKey` doesn't
 * match the owner of the row it names. The runtime never retries it: a
 * mismatch is a bug or tampering, not a transient failure. Recovery and
 * schedule sweeps report it through `onOwnerKeyMismatch` and leave the row
 * alone.
 */
export class OwnerKeyMismatchError extends Error {
  readonly code = "owner_key_mismatch";
  constructor(
    /** What the call named: `run <id>`, `chat <id>`, `schedule <id>`. */
    readonly target: string,
  ) {
    super(`${target} doesn't belong to the owner key the call carried`);
    this.name = "OwnerKeyMismatchError";
  }
}

export function isOwnerKeyMismatchError(e: unknown): e is OwnerKeyMismatchError {
  return e instanceof OwnerKeyMismatchError || (e as { code?: unknown } | null)?.code === "owner_key_mismatch";
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
   * For a runtime-created sub-thread: the agent that spawned it (the parent's
   * registry name at `spawn_agent` time). Persisted so every later resolve of
   * this chat — approval resume, crash recovery, continuation — can hand the
   * same `parentAgent` to `DynamicAgentStore.resolve`, letting a host shape a
   * subagent per parent (e.g. which of a connector's tools this parent may
   * use). Absent on top-level chats.
   */
  parentAgent?: string;
  /**
   * What the chat is about, as its first message set it: the agent's `params`
   * (see `defineAgent`), validated against the agent's schema. Fixed for the
   * chat's life, and handed to the agent on every turn, including resumed
   * ones and approvals. Absent for an agent that declares no params.
   */
  params?: unknown;
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
   * The owner key of the run's chat, stamped when the run is created: a run
   * inherits its chat's owner. Optional, but an adapter that returns it on
   * every run record (reaped and reclaimed ones included) gives the runtime
   * the key to pass back on id-only calls about this run, crash recovery
   * included. See `OwnerScope`.
   */
  ownerKey?: string;
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
  /**
   * How the turn was asked to run, when that differs from an attended chat
   * turn (`runAgent`, cron, an autonomous delegation). Kept on the row so
   * crash recovery resumes it the SAME way — an unattended eval resumed as
   * attended would park on a gate nobody will answer; one resumed without
   * its `blockGated` would run its gated tools for real. Null/absent = an
   * attended turn's defaults.
   */
  settings?: RunSettings | null;
  /**
   * When someone asked the run to stop (`runtime.stopRun`), epoch ms; null
   * or absent when nobody did. The running instance reads it and stops the
   * answer, and crash recovery never resumes a run that has it.
   */
  stopRequestedAt?: number | null;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

/** A turn's execution settings, as stored on its run (see `RunRecord.settings`). */
export interface RunSettings {
  autoApprove?: boolean;
  blockGated?: boolean | "simulate-success";
  /** `false` = the turn ran with memory off. */
  memory?: boolean;
  /** `false` = the turn ran with prompt caching off. */
  promptCaching?: boolean;
  /**
   * The id of a per-turn model override, when the turn ran on one. The model
   * object itself can't be stored, so recovery refuses such a run rather than
   * silently finishing it on the agent's own model.
   */
  modelOverride?: string;
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

/**
 * A {@link RunLease} on a named run: what a durable turn passes to
 * `appendMessages` so its message writes are fenced like its run updates.
 */
export interface RunFence extends RunLease {
  runId: string;
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
  /**
   * The params every chat this schedule fires starts with (see
   * `ChatRecord.params`), validated against the agent's schema when the
   * schedule was created.
   */
  params?: unknown;
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
      /** Spawning agent of a sub-thread (see `ChatRecord.parentAgent`). */
      parentAgent?: string;
      /** What the chat is about (see `ChatRecord.params`). JSON; store it as given. */
      params?: unknown;
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
  /**
   * Upsert messages by id (incremental per-step persistence is allowed).
   *
   * With `fence`, the write is part of a durable turn and must be fenced like
   * `updateRun`'s guard: it lands only while run `fence.runId` still holds
   * `(leaseOwner, fencingToken)`, checked atomically WITH the write — a worker
   * whose lease was reaped and re-claimed elsewhere must not write into a chat
   * the new owner is running. A refused write persists nothing and returns
   * `false`. Without `fence`, the write is unconditional (return value unused).
   *
   * An adapter that ignores `fence` still works, but a zombie worker can then
   * write for up to one lease TTL after losing its run.
   */
  appendMessages(
    chatId: string,
    messages: AppMessage[],
    fence?: RunFence,
    scope?: OwnerScope<P>,
  ): Promise<void | boolean>;

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
    input: { chatId: string; agent: string; kind?: string; agentVersion?: number | null; settings?: RunSettings | null },
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
    settings?: RunSettings | null;
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
      settings?: RunSettings | null;
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
    scope?: OwnerScope<P>,
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
    scope?: OwnerScope<P>,
  ): Promise<RunRecord | null>;
  // ↑ Also null when the chat has since started a NEWER active run (the crashed
  //   turn was superseded by a fresh message) — resuming it would interleave.
  //   And null for a run with `stopRequestedAt`: someone stopped it.
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
    scope?: OwnerScope<P>,
  ): Promise<boolean>;
  getRun(id: string, scope?: OwnerScope<P>): Promise<RunRecord | null>;
  /**
   * Ask the chat's active run to stop: stamp `stopRequestedAt` on it, only if
   * the chat is the caller's. Returns the run's id, or null when the chat has
   * no active run. The instance running it notices on its next check (see
   * `RuntimeConfig.stopCheckMs`) by reading `getRun`.
   *
   * Optional: without it, `runtime.stopRun` reaches only runs on the instance
   * that receives the stop. A run on another server then finishes its answer.
   * Implement it with `reclaimRun` refusing a run that has `stopRequestedAt`.
   */
  requestStop?(principal: P, chatId: string): Promise<string | null>;
  /** Scoped list of the caller's runs (joined via chats), most-recent first. */
  listRuns(principal: P, opts?: { limit?: number }): Promise<RunRecord[]>;
  /**
   * Reaper: mark active runs whose lease has expired (`leaseExpiresAt < now`) as
   * `errored`, clear the owner, and bump the fencing token (invalidating any
   * zombie holder). Returns the reaped runs. Safe to run on many nodes — each
   * row transitions once (the UPDATE is atomic per row).
   *
   * `now` omitted → the adapter's own clock. Lease times should come from ONE
   * clock shared by every node (the shipped adapters use the database's), or
   * skew between app servers lets one reap a run another is still renewing.
   * Pass `now` only to simulate time (tests).
   */
  reapExpiredRuns(
    now?: number,
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
      /** Params each fired chat starts with (see `ScheduleRecord.params`). JSON; store it as given. */
      params?: unknown;
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
   * Return `false` when the fence rejected the write (a newer claim holds the
   * row — another node's, or a later pass on this one): the runtime then does
   * NOT fire, since the new holder owns the occurrence and firing too would be a duplicate paid turn. `true` or
   * `void` means applied — `void` keeps adapters written before this signal
   * existed working, at the cost of that protection.
   *
   * `claim` identifies WHICH claim is completing: the `leaseExpiresAt` the
   * claim stamped. `owner` alone can't tell two claims by the same instance
   * apart — two `runDue` passes sharing an `instanceId` (an interval tick plus
   * a manual `/cron/run`) where the first outlives its lease and the second
   * re-claims — so fence on both when given. Every claim stamps a strictly
   * later expiry than the lapsed one it replaces, so the value is unique per
   * claim with no extra column. Adapters that ignore it keep the owner-only
   * fence.
   */
  completeSchedule(
    id: string,
    patch: { nextRunAt: number; lastRunAt: number; enabled: boolean },
    owner: string,
    claim?: { leaseExpiresAt: number },
    scope?: OwnerScope<P>,
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
    scope?: OwnerScope<P>,
  ): Promise<void>;

  // deletion
  /**
   * OPTIONAL. Delete some of the caller's chats with everything stored under
   * them: messages and runs. Their usage rows stay: the usage ledger records
   * what was spent, and deleting a conversation doesn't change that (it holds
   * no content, only owner, model, tokens and cost). All or nothing: if any of them has
   * a live run (an answer in progress), none is deleted and it throws
   * `ChatBusyError`. Ids that aren't the caller's are skipped. Returns the ids
   * deleted. A run, message or usage row written for a chat (or its run)
   * after it's gone must fail, not land as an orphan. Without it,
   * `runtime.deleteChat` refuses.
   */
  deleteChats?(principal: P, ids: string[]): Promise<string[]>;
  /**
   * OPTIONAL system op (no principal): delete everything stored for an owner
   * path. That's every row whose owner key is `encodeOwnerKey(segments)` or
   * starts with it plus `/` (see `isUnderOwner`): `["t1"]` covers `t1` and
   * `t1/u7`, never `t10`. Chats with their messages and runs, and schedules.
   * Usage follows `opts.usage` (see `PurgeOptions`). Live runs are settled first with their fencing token bumped,
   * so a server still running one can't write into what's being deleted.
   *
   * Works in passes of at most `batchSize` rows per table (default 500), so a
   * large tenant can't time out: call until `done`. Idempotent: another call
   * after `done` removes only stragglers (a turn that was in flight). Compare
   * prefixes as plain strings, never with SQL `LIKE`: encoded keys contain
   * `%` and `_`. Without it, `runtime.purgeOwner` refuses.
   */
  purgeOwner?(segments: string[], opts?: PurgeOptions): Promise<PurgeResult>;
}

/**
 * How a purge treats the usage ledger: the rows saying what was spent (owner,
 * model, tokens, cost, time; no content). Billing records often have to be
 * kept even when the person's data is erased, so the choice is the host's.
 */
export interface PurgeOptions {
  /** Rows per table per pass. Default 500. */
  batchSize?: number;
  /**
   * - `"refile"` (default): keep the rows, moved to `refileTo`, with their run
   *   id cleared. The totals stay right; nothing points at the person any
   *   more. It's pseudonymous rather than anonymous (a one-person
   *   organization, or timestamps matched against your own logs, can still
   *   point back), which is what keeping billing records usually means.
   * - `"keep"`: leave the rows as they are, under the purged owner.
   * - `"delete"`: delete them, for a customer who has left entirely.
   */
  usage?: "refile" | "keep" | "delete";
  /**
   * Where `"refile"` moves usage: an owner path outside the purged one.
   * Default: the purged path minus its last segment (`["t1", "u7"]` →
   * `["t1"]`). A one-segment path has nothing above it, so `"refile"` needs
   * this or refuses: pass `usage: "delete"` to remove a whole tenant.
   */
  refileTo?: string[];
}

/** Where a purge of `segments` re-files usage, or why it can't. */
export function refileTarget(segments: readonly string[], opts?: PurgeOptions): string[] | undefined {
  if ((opts?.usage ?? "refile") !== "refile") return undefined;
  const target = opts?.refileTo ?? segments.slice(0, -1);
  if (target.length === 0) {
    throw new Error(`purgeOwner: nowhere to re-file usage above [${segments.join(", ")}]; pass refileTo, or usage: "delete" or "keep"`);
  }
  if (isUnderOwner(encodeOwnerKey(target), segments)) {
    throw new Error("purgeOwner: refileTo is inside the path being purged");
  }
  return target;
}

/** One pass of a purge: rows removed, by table, and whether anything is left. */
export interface PurgeResult {
  /** Rows removed in this pass, by what they were: `chats`, `messages`, `runs`, `usage`, `schedules`, … */
  removed: Record<string, number>;
  /** `false` when the pass stopped at its batch size: call again to continue. */
  done: boolean;
}

/**
 * Whether an owner key falls under an owner path: it IS the path's key, or
 * starts with it plus `/`. `isUnderOwner("t1/u7", ["t1"])` is true;
 * `isUnderOwner("t10", ["t1"])` is false. Segments are escaped by
 * `encodeOwnerKey`, so a `/` inside an id can't fake a boundary.
 */
export function isUnderOwner(ownerKey: string, segments: readonly string[]): boolean {
  const key = encodeOwnerKey(segments);
  return ownerKey === key || ownerKey.startsWith(`${key}/`);
}

/**
 * Thrown when the runtime is asked for something the storage adapter (or
 * another store) doesn't implement, such as `deleteChat` or `purgeOwner`.
 * Nothing was changed. The server answers `501`.
 */
export class UnsupportedOperationError extends Error {
  readonly code = "unsupported";
  constructor(readonly operation: string) {
    super(`${operation} isn't supported by the configured storage`);
    this.name = "UnsupportedOperationError";
  }
}

export function isUnsupportedOperationError(e: unknown): e is UnsupportedOperationError {
  return e instanceof UnsupportedOperationError || (e as { code?: unknown } | null)?.code === "unsupported";
}

/**
 * Joins an owner path (what a storage adapter's `owner` option returns) into
 * one key, each segment escaped so a `/` or `%` inside an id can't forge a
 * boundary. Use it in your own adapter or store too.
 *
 * Throws on a missing or empty segment, and on an empty path. Unchecked,
 * `[orgId, undefined]` becomes the key `orgId/undefined`: one bucket every
 * principal missing a `userId` would share, so their chats or secrets would
 * mix without an error.
 */
export function encodeOwnerKey(segments: readonly unknown[]): string {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("owner returned no segments: return at least one id, such as [orgId]");
  }
  const bad = segments.findIndex((s) => typeof s !== "string" || s === "");
  if (bad !== -1) {
    const shown = segments.map((s) => (typeof s === "string" ? JSON.stringify(s) : String(s))).join(", ");
    throw new Error(
      `owner returned an empty segment at position ${bad}: [${shown}]. Every principal missing that id ` +
        "would share one key. Return a complete path, or throw for a principal that can't have one.",
    );
  }
  return (segments as string[]).map(encodeURIComponent).join("/");
}

/**
 * The segments of an owner key made by `encodeOwnerKey`, unescaped:
 * `decodeOwnerKey("t1/u%2F7")` is `["t1", "u/7"]`. For an adapter that routes
 * by the first segment (the tenant) or checks a prefix.
 */
export function decodeOwnerKey(key: string): string[] {
  if (typeof key !== "string" || key === "") throw new Error("decodeOwnerKey: empty key");
  return key.split("/").map(decodeURIComponent);
}
