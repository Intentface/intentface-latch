/**
 * The job-state seam for the background sweep. Implemented by
 * `@intentface/latch-drizzle` (`createMemoryJobStore`) over three tables that
 * mirror the `latch_schedules` lease pattern.
 *
 * SECURITY: `listExtractionCandidates`, `latestRunIdentity`, and
 * `messagesAfter` are SYSTEM ops — principal-free, cross-tenant (the
 * `claimDueSchedules` precedent). Their results must only ever feed runs
 * executed under the chat's own reconstructed principal.
 */

export interface ExtractionCandidate {
  chatId: string;
  owner: string;
  agent: string;
  /** Chat last-activity (epoch ms). */
  updatedAt: number;
  /** Last message seq already extracted (-1 = never). */
  lastExtractedSeq: number;
  /** Highest message seq currently in the chat. */
  maxSeq: number;
}

export interface ScopeStateRow {
  scopeKey: string;
  owner: string;
  agent: string;
  connection: string;
  /** Serialized principal captured at the last episode write (for job runs). */
  identity: unknown;
  hasNew: boolean;
  /** Episode paths written since the last successful consolidation (bounded). */
  pendingEpisodes: string[];
  /** Last episode NAME folded in (names sort chronologically). */
  consolidationWatermark?: string;
  lastConsolidatedAt?: number;
  nextEligibleAt: number;
  failures: number;
}

export interface MemoryUsageRow {
  memoryId: string;
  usageCount: number;
  lastUsedAt?: number;
  createdAt: number;
}

export interface MemoryJobStore {
  // ---- extraction (per chat) ----
  /** Idle, unextracted user-kind chats of the given agents (cross-tenant system op). */
  listExtractionCandidates(args: {
    now: number;
    idleMs: number;
    agents: string[];
    limit: number;
  }): Promise<ExtractionCandidate[]>;
  /** The newest run's serialized principal for a chat (system op). */
  latestRunIdentity(chatId: string): Promise<unknown | undefined>;
  /** Plain-text message excerpts after a seq, capped by total characters (system op). */
  messagesAfter(
    chatId: string,
    afterSeq: number,
    maxChars: number,
  ): Promise<Array<{ seq: number; role: string; text: string }>>;
  /** Claim a chat for extraction (lease). False = lost the race. */
  claimChatExtraction(
    chatId: string,
    meta: { owner: string; agent: string; scopeKey: string },
    leaseOwner: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;
  /**
   * Finish an extraction attempt. `nextEligibleAt` must ALWAYS advance (the
   * anti-hot-loop invariant); `lastExtractedSeq` advances only on success.
   */
  completeChatExtraction(
    chatId: string,
    patch: { lastExtractedSeq?: number; ok: boolean; nextEligibleAt: number },
    leaseOwner: string,
  ): Promise<void>;

  // ---- consolidation (per scope) ----
  /**
   * Mark a scope dirty after an episode write: upsert the row, set `hasNew`,
   * append the episode path to `pendingEpisodes` (bounded), stamp the identity,
   * and set `nextEligibleAt` to at least `lastConsolidatedAt + cooldownMs`.
   */
  touchScope(
    args: {
      scopeKey: string;
      owner: string;
      agent: string;
      connection: string;
      identity: unknown;
      episodePath?: string;
    },
    opts: { cooldownMs: number; now: number },
  ): Promise<void>;
  /** Scopes with `hasNew` past their cooldown, lease-free (system op). */
  listConsolidationCandidates(args: { now: number; limit: number }): Promise<ScopeStateRow[]>;
  /** One scope's state (for status surfaces), or undefined if never touched. */
  scopeState(scopeKey: string): Promise<ScopeStateRow | undefined>;
  claimScopeConsolidation(
    scopeKey: string,
    leaseOwner: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;
  /**
   * Finish a consolidation attempt. On success, removes `consumedEpisodes`
   * from `pendingEpisodes` (ONLY those — an episode written mid-consolidation
   * must survive for the next pass), clears `hasNew` when nothing is left, and
   * advances the watermark. `nextEligibleAt` always advances.
   */
  completeScopeConsolidation(
    scopeKey: string,
    patch: {
      watermark?: string;
      ok: boolean;
      nextEligibleAt: number;
      consumedEpisodes?: string[];
    },
    leaseOwner: string,
  ): Promise<void>;

  // ---- retention ----
  recordUsage(scopeKey: string, memoryIds: string[], at: number): Promise<void>;
  usageFor(scopeKey: string): Promise<MemoryUsageRow[]>;
}
