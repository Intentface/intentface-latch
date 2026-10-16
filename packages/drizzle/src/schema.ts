import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** The v1 tables. `messages` is the source of truth; parts + metadata are JSON. */

export const chats = sqliteTable(
  "latch_chats",
  {
    id: text("id").primaryKey(),
    /** Opaque ownership key derived from the principal (e.g. `tenant/user`). */
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    title: text("title"),
    /** Chat kind: 'user' (default) vs 'internal' sub-threads (ChatRecord.kind). */
    kind: text("kind").notNull().default("user"),
    /** Spawning agent of a sub-thread (ChatRecord.parentAgent); null at top level. */
    parentAgent: text("parent_agent"),
    /** What the chat is about, fixed when it starts (ChatRecord.params). */
    params: text("params", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("latch_chats_owner_idx").on(t.owner),
    // The memory sweep enumerates idle chats system-wide (no owner filter).
    index("latch_chats_sweep_idx").on(t.kind, t.updatedAt),
  ],
);

export const messages = sqliteTable(
  "latch_messages",
  {
    id: text("id").notNull(),
    chatId: text("chat_id").notNull(),
    runId: text("run_id"),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    /** UIMessagePart[] */
    parts: text("parts", { mode: "json" }).notNull(),
    /** AppMetadata */
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Message ids are client/stream-generated, so they're only unique WITHIN a
    // chat — a global PK on `id` would let an upsert in one chat overwrite a
    // same-id row in another owner's chat. Scope the identity to the chat.
    primaryKey({ columns: [t.chatId, t.id] }),
    // One row per (chat, seq): guards concurrent appenders computing the same
    // next seq. Doubles as the (chat_id, seq) read-ordering index.
    uniqueIndex("latch_messages_chat_seq_idx").on(t.chatId, t.seq),
  ],
);

export const runs = sqliteTable(
  "latch_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    agent: text("agent").notNull(),
    status: text("status").notNull(),
    /** The chat's owner key, stamped at open (RunRecord.ownerKey). NULL on runs from before it existed. */
    ownerKey: text("owner_key"),
    /** Serialized Principal blob — rebuilt on resume/cron (no request). */
    identity: text("identity", { mode: "json" }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    fencingToken: integer("fencing_token"),
    heartbeatAt: integer("heartbeat_at"),
    attempt: integer("attempt"),
    usageInputTokens: integer("usage_input_tokens"),
    usageOutputTokens: integer("usage_output_tokens"),
    usageCacheReadTokens: integer("usage_cache_read_tokens"),
    usageCacheWriteTokens: integer("usage_cache_write_tokens"),
    costTotal: real("cost_total"),
    /** Run kind: 'turn' (default) vs 'compaction' — keeps cache/hit-rate stats clean. */
    kind: text("kind"),
    /** Opaque fingerprint of the sorted tool names this turn sent (see
     * `toolsetHash`) — detects toolset churn. */
    toolsHash: text("tools_hash"),
    /** The agent-record version (`latch_agent_versions.version`) this turn ran.
     * NULL for code-declared agents, which have no stored record. */
    agentVersion: integer("agent_version"),
    /** How the turn was asked to run (RunRecord.settings), so recovery resumes it the same way. */
    settings: text("settings", { mode: "json" }),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("latch_runs_chat_idx").on(t.chatId),
    index("latch_runs_reaper_idx").on(t.status, t.leaseExpiresAt),
    // One ACTIVE run per chat — the concurrency invariant (see ChatBusyError).
    uniqueIndex("latch_runs_one_active_per_chat").on(t.chatId).where(sql`status = 'active'`),
  ],
);

/** Envelope-encrypted connection credentials. No plaintext is ever stored. */
export const secrets = sqliteTable(
  "latch_secrets",
  {
    /** `${ownerKey}:${key}` — stable composite id. */
    id: text("id").primaryKey(),
    /** Opaque ownership key derived from the principal. */
    owner: text("owner").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    dekIv: text("dek_iv").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("latch_secrets_owner_idx").on(t.owner)],
);

export const usage = sqliteTable(
  "latch_usage",
  {
    id: text("id").primaryKey(),
    /** Opaque ownership key derived from the principal. */
    owner: text("owner").notNull(),
    runId: text("run_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cost: real("cost").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("latch_usage_owner_idx").on(t.owner)],
);

/**
 * Builder/editor-created agents (see `@intentface/latch-agent-builder`'s
 * `AgentRecord`). Owner-keyed for org/personal scope; config isn't secret.
 * One table shape for every host's agent store, so hosts can share DBs.
 */
export const agents = sqliteTable(
  "latch_agents",
  {
    id: text("id").primaryKey(),
    /** Opaque ownership key derived from (principal, scope). */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    description: text("description"),
    modelId: text("model_id").notNull(),
    instructions: text("instructions").notNull(),
    /** string[] — connection names. */
    connections: text("connections", { mode: "json" }).notNull(),
    /** AgentRecord["tools"] — per-tool selection/approval overrides. */
    tools: text("tools", { mode: "json" }),
    /** AgentRecord["exec"] — code-execution capabilities. */
    exec: text("exec", { mode: "json" }),
    /** string[] — delegate agent names. */
    subagents: text("subagents", { mode: "json" }),
    /** NULL=default, 0=unlimited, N=cap (AgentRecord["maxSteps"]). */
    maxSteps: integer("max_steps"),
    scope: text("scope").notNull(),
    /** Which `latch_agent_versions.version` this live row is a copy of. */
    publishedVersion: integer("published_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("latch_agents_owner_name").on(t.owner, t.name)],
);

/**
 * Append-only history of published agent records — the set of distinct
 * CONFIGURATIONS this agent has had. One row per publish, and none for a
 * publish whose content is unchanged, so history stays a list of real changes
 * rather than of save events.
 *
 * The `latch_agents` row is always a copy of the version its `published_version`
 * names. Rolling back (`activateVersion`) moves that pointer and appends NO
 * version, so flipping between two configurations cannot inflate history —
 * which is why WHEN each version was live is recorded separately, in
 * `latch_agent_activations`.
 *
 * Deleting an agent deletes its versions (the store's `remove` cascades).
 */
export const agentVersions = sqliteTable(
  "latch_agent_versions",
  {
    id: text("id").primaryKey(),
    /** Same opaque ownership key as `latch_agents.owner`. */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** Monotonic per (owner, name), from 1. */
    version: integer("version").notNull(),
    /** The full normalized `AgentRecord` as published. */
    record: text("record", { mode: "json" }).notNull(),
    /** Host-supplied publisher id; NULL for the migration backfill. */
    author: text("author"),
    /** 'editor' | 'builder-agent' | 'api' | 'backfill'. */
    source: text("source"),
    /**
     * string[] — top-level record fields that differ from the PREVIOUS version,
     * computed at write time. NULL for v1 (nothing to differ from). Denormalized
     * so a history list can say "instructions, model" without loading two
     * snapshots and diffing them.
     */
    changedFields: text("changed_fields", { mode: "json" }),
    /** Optional one-line note from whoever published. */
    changeMessage: text("change_message"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Backstops the max(version)+1 race: a losing concurrent publish retries.
    uniqueIndex("latch_agent_versions_owner_name_version").on(t.owner, t.name, t.version),
    index("latch_agent_versions_owner_name_idx").on(t.owner, t.name),
  ],
);

/**
 * Who made which version live, and when — the publish timeline.
 *
 * `latch_agent_versions` is the set of distinct CONFIGURATIONS; activating an
 * existing version moves a pointer and appends no version, so without this table
 * a rollback would leave no trace of itself. One row per publish AND per
 * activation, so the two together answer both "what did this agent look like"
 * and "what was it running on Tuesday".
 */
export const agentActivations = sqliteTable(
  "latch_agent_activations",
  {
    id: text("id").primaryKey(),
    /** Same opaque ownership key as `latch_agents.owner`. */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** The version that became live. */
    version: integer("version").notNull(),
    /** Host-supplied actor id; NULL for the migration backfill. */
    actor: text("actor"),
    /** 'publish' (new content) | 'activate' (rollback) | 'backfill'. */
    source: text("source"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("latch_agent_activations_owner_name_idx").on(t.owner, t.name, t.createdAt)],
);

/**
 * One unpublished working copy per (agent, editor).
 *
 * Deliberately PER EDITOR, not per agent: `owner` is an isolation boundary a
 * whole org shares, so a single draft would let two admins silently overwrite
 * each other's half-written prompt. Drafts never affect a running agent — the
 * live record is `latch_agents`, and a draft becomes live only by being
 * published, which is what `base_version` guards.
 */
export const agentDrafts = sqliteTable(
  "latch_agent_drafts",
  {
    /** Same opaque ownership key as `latch_agents.owner`. */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** The PERSON editing (see `AgentStoreOptions.editorKey`). */
    editor: text("editor").notNull(),
    /** The full in-progress `AgentRecord`. */
    record: text("record", { mode: "json" }).notNull(),
    /**
     * The version this draft was started from. Compared against the live
     * `published_version` at publish time: if they differ, someone else has
     * published since, and publishing blind would silently revert them.
     */
    baseVersion: integer("base_version"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.name, t.editor] }),
    index("latch_agent_drafts_owner_idx").on(t.owner),
  ],
);

/**
 * Candidates: named, unpublished configurations of an agent — "haiku with
 * shorter instructions", "new tools". Unlike a draft, a candidate belongs to
 * the AGENT, not to one person: everyone who can edit the agent sees it, runs
 * it (`name@c_<id>`) and can publish it. Closing one — discarded, or published
 * as a version — keeps the row, so results filed under it keep their name
 * and can still be answered again.
 */
export const agentCandidates = sqliteTable(
  "latch_agent_candidates",
  {
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** `c_…` — the ref suffix, stable across renames. */
    id: text("id").notNull(),
    /** What people call it; renamable. */
    title: text("title").notNull(),
    record: text("record", { mode: "json" }).notNull(),
    /** The version it was started from — the same publish guard as a draft's. */
    baseVersion: integer("base_version"),
    author: text("author"),
    /** Set when it was published: the version it became. */
    publishedAs: integer("published_as"),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.name, t.id] })],
);

/**
 * Memory-sweep state, per chat: which messages have been extracted into
 * episodic memory. Lease columns mirror `latch_schedules` (claim/complete,
 * fenced by lease owner). `next_eligible_at` ALWAYS advances on completion —
 * success or failure — so a broken chat can't hot-loop the sweep.
 */
export const memoryChatState = sqliteTable(
  "latch_memory_chat_state",
  {
    chatId: text("chat_id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    scopeKey: text("scope_key").notNull(),
    /** Last message seq folded into an episode (-1 = never). */
    lastExtractedSeq: integer("last_extracted_seq").notNull().default(-1),
    /** Idempotency key of the last COMPLETED run (content hash + prompt version). */
    lastExtractedKey: text("last_extracted_key"),
    nextEligibleAt: integer("next_eligible_at").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("latch_memory_chat_state_scope_idx").on(t.scopeKey)],
);

/**
 * Memory-sweep state, per scope: consolidation cooldown/watermark/lease plus
 * the pending episode paths written since the last successful consolidation.
 * `identity` is the serialized principal captured at the last episode write —
 * consolidation runs under the scope's own reconstructed caller.
 */
export const memoryScopeState = sqliteTable(
  "latch_memory_scope_state",
  {
    /** `${connection}:${root}` (see `@intentface/latch-memory` ScopeRef). */
    scopeKey: text("scope_key").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    connection: text("connection").notNull(),
    identity: text("identity", { mode: "json" }),
    hasNew: integer("has_new").notNull().default(0),
    /** JSON string[] of episode paths awaiting consolidation (bounded). */
    pendingEpisodes: text("pending_episodes", { mode: "json" }),
    /** Last episode NAME folded in — names sort chronologically. */
    consolidationWatermark: text("consolidation_watermark"),
    lastConsolidatedAt: integer("last_consolidated_at"),
    nextEligibleAt: integer("next_eligible_at").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("latch_memory_scope_due_idx").on(t.hasNew, t.nextEligibleAt)],
);

/**
 * Recall tracking: bumped whenever `memory_search` surfaces an entry/episode.
 * Retention signal — entries unrecalled for N days become expiry candidates.
 */
export const memoryUsage = sqliteTable(
  "latch_memory_usage",
  {
    scopeKey: text("scope_key").notNull(),
    /** `[m-…]` entry id or an episode path. */
    memoryId: text("memory_id").notNull(),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scopeKey, t.memoryId] })],
);

/** Limit counters: one row per (key, fixed window) — see `limits.ts` in core. */
export const limitCounters = sqliteTable(
  "latch_limit_counters",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    windowMs: integer("window_ms").notNull(),
    turns: integer("turns").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  // `windowMs` is part of the identity: the same key may carry a per-minute and
  // a per-day policy, whose aligned windows share a start on the hour.
  (t) => [primaryKey({ columns: [t.key, t.windowStart, t.windowMs] })],
);

/** Cron-driven agent runs. Carries the identity blob so a tick can rebuild the caller. */
export const schedules = sqliteTable(
  "latch_schedules",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    identity: text("identity", { mode: "json" }),
    cron: text("cron"),
    timezone: text("timezone"),
    prompt: text("prompt").notNull(),
    /** Host-interpreted delivery target (e.g. a channel), opaque to core. */
    delivery: text("delivery", { mode: "json" }),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    /** Parked-predecessor policy ('skip' | 'fire'); null = the default ('skip'). */
    onParked: text("on_parked"),
    /** Chat of the last default-path fire (see StorageAdapter.noteScheduleFire). */
    lastChatId: text("last_chat_id"),
    /** Params each fired chat starts with (ScheduleRecord.params). */
    params: text("params", { mode: "json" }),
    enabled: integer("enabled").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("latch_schedules_owner_idx").on(t.owner),
    index("latch_schedules_due_idx").on(t.enabled, t.nextRunAt),
  ],
);
