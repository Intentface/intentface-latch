import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  doublePrecision,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The v1 tables, Postgres dialect. Same shape as SQLite; jsonb for parts/metadata,
 *  bigint (epoch ms) for timestamps, double precision for cost. */

export const chats = pgTable(
  "latch_chats",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    title: text("title"),
    /** Chat kind: 'user' (default) vs 'internal' sub-threads (ChatRecord.kind). */
    kind: text("kind").notNull().default("user"),
    /** Spawning agent of a sub-thread (ChatRecord.parentAgent); null at top level. */
    parentAgent: text("parent_agent"),
    /** What the chat is about, fixed when it starts (ChatRecord.params). */
    params: jsonb("params"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("latch_chats_owner_idx").on(t.owner),
    // The memory sweep enumerates idle chats system-wide (no owner filter).
    index("latch_chats_sweep_idx").on(t.kind, t.updatedAt),
  ],
);

export const messages = pgTable(
  "latch_messages",
  {
    id: text("id").notNull(),
    chatId: text("chat_id").notNull(),
    runId: text("run_id"),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
    metadata: jsonb("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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

export const runs = pgTable(
  "latch_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    agent: text("agent").notNull(),
    status: text("status").notNull(),
    /** The chat's owner key, stamped at open (RunRecord.ownerKey). NULL on runs from before it existed. */
    ownerKey: text("owner_key"),
    identity: jsonb("identity"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    fencingToken: integer("fencing_token"),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }),
    attempt: integer("attempt"),
    usageInputTokens: integer("usage_input_tokens"),
    usageOutputTokens: integer("usage_output_tokens"),
    usageCacheReadTokens: integer("usage_cache_read_tokens"),
    usageCacheWriteTokens: integer("usage_cache_write_tokens"),
    costTotal: doublePrecision("cost_total"),
    /** Run kind: 'turn' (default) vs 'compaction' — keeps cache/hit-rate stats clean. */
    kind: text("kind"),
    /** Opaque fingerprint of the sorted tool names this turn sent (see
     * `toolsetHash`) — detects toolset churn. */
    toolsHash: text("tools_hash"),
    /** The agent-record version (`latch_agent_versions.version`) this turn ran.
     * NULL for code-declared agents, which have no stored record. */
    agentVersion: integer("agent_version"),
    /** How the turn was asked to run (RunRecord.settings), so recovery resumes it the same way. */
    settings: jsonb("settings"),
    error: text("error"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
  },
  (t) => [
    index("latch_runs_chat_idx").on(t.chatId),
    index("latch_runs_reaper_idx").on(t.status, t.leaseExpiresAt),
    // One ACTIVE run per chat — the concurrency invariant (see ChatBusyError).
    uniqueIndex("latch_runs_one_active_per_chat").on(t.chatId).where(sql`status = 'active'`),
  ],
);

/** Envelope-encrypted connection credentials. No plaintext is ever stored. */
export const secrets = pgTable(
  "latch_secrets",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    dekIv: text("dek_iv").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_secrets_owner_idx").on(t.owner)],
);

export const usage = pgTable(
  "latch_usage",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    runId: text("run_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cost: doublePrecision("cost").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_usage_owner_idx").on(t.owner)],
);

/**
 * Builder/editor-created agents (see `@intentface/latch-agent-builder`'s
 * `AgentRecord`). Owner-keyed for org/personal scope; config isn't secret.
 */
export const agents = pgTable(
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
    connections: jsonb("connections").notNull(),
    /** AgentRecord["tools"] — per-tool selection/approval overrides. */
    tools: jsonb("tools"),
    /** AgentRecord["exec"] — code-execution capabilities. */
    exec: jsonb("exec"),
    /** string[] — delegate agent names. */
    subagents: jsonb("subagents"),
    /** NULL=default, 0=unlimited, N=cap (AgentRecord["maxSteps"]). */
    maxSteps: integer("max_steps"),
    scope: text("scope").notNull(),
    /** Which `latch_agent_versions.version` this live row is a copy of. */
    publishedVersion: integer("published_version"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
export const agentVersions = pgTable(
  "latch_agent_versions",
  {
    id: text("id").primaryKey(),
    /** Same opaque ownership key as `latch_agents.owner`. */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** Monotonic per (owner, name), from 1. */
    version: integer("version").notNull(),
    /** The full normalized `AgentRecord` as published. */
    record: jsonb("record").notNull(),
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
    changedFields: jsonb("changed_fields"),
    /** Optional one-line note from whoever published. */
    changeMessage: text("change_message"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
export const agentActivations = pgTable(
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
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
export const agentDrafts = pgTable(
  "latch_agent_drafts",
  {
    /** Same opaque ownership key as `latch_agents.owner`. */
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /** The PERSON editing (see `AgentStoreOptions.editorKey`). */
    editor: text("editor").notNull(),
    /** The full in-progress `AgentRecord`. */
    record: jsonb("record").notNull(),
    /**
     * The version this draft was started from. Compared against the live
     * `published_version` at publish time: if they differ, someone else has
     * published since, and publishing blind would silently revert them.
     */
    baseVersion: integer("base_version"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.name, t.editor] }),
    index("latch_agent_drafts_owner_idx").on(t.owner),
  ],
);

/** Named, shared, unpublished configurations — see the SQLite schema for semantics. */
export const agentCandidates = pgTable(
  "latch_agent_candidates",
  {
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    id: text("id").notNull(),
    title: text("title").notNull(),
    record: jsonb("record").notNull(),
    baseVersion: integer("base_version"),
    author: text("author"),
    publishedAs: integer("published_as"),
    closedAt: bigint("closed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.name, t.id] })],
);

/** Memory-sweep state per chat — see the SQLite schema for semantics. */
export const memoryChatState = pgTable(
  "latch_memory_chat_state",
  {
    chatId: text("chat_id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    scopeKey: text("scope_key").notNull(),
    lastExtractedSeq: integer("last_extracted_seq").notNull().default(-1),
    /** Idempotency key of the last COMPLETED run (content hash + prompt version). */
    lastExtractedKey: text("last_extracted_key"),
    nextEligibleAt: bigint("next_eligible_at", { mode: "number" }).notNull().default(0),
    failures: integer("failures").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_memory_chat_state_scope_idx").on(t.scopeKey)],
);

/** Memory-sweep state per scope — see the SQLite schema for semantics. */
export const memoryScopeState = pgTable(
  "latch_memory_scope_state",
  {
    scopeKey: text("scope_key").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    connection: text("connection").notNull(),
    identity: jsonb("identity"),
    hasNew: integer("has_new").notNull().default(0),
    pendingEpisodes: jsonb("pending_episodes"),
    consolidationWatermark: text("consolidation_watermark"),
    lastConsolidatedAt: bigint("last_consolidated_at", { mode: "number" }),
    nextEligibleAt: bigint("next_eligible_at", { mode: "number" }).notNull().default(0),
    failures: integer("failures").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_memory_scope_due_idx").on(t.hasNew, t.nextEligibleAt)],
);

/** Recall tracking — see the SQLite schema for semantics. */
export const memoryUsage = pgTable(
  "latch_memory_usage",
  {
    scopeKey: text("scope_key").notNull(),
    memoryId: text("memory_id").notNull(),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scopeKey, t.memoryId] })],
);

/** Limit counters: one row per (key, fixed window) — see `limits.ts` in core. */
export const limitCounters = pgTable(
  "latch_limit_counters",
  {
    key: text("key").notNull(),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    windowMs: bigint("window_ms", { mode: "number" }).notNull(),
    turns: integer("turns").notNull().default(0),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
    cost: doublePrecision("cost").notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart, t.windowMs] })],
);

/** Cron-driven agent runs. Carries the identity blob so a tick can rebuild the caller. */
export const schedules = pgTable(
  "latch_schedules",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    identity: jsonb("identity"),
    cron: text("cron"),
    timezone: text("timezone"),
    prompt: text("prompt").notNull(),
    /** Host-interpreted delivery target (e.g. a channel), opaque to core. */
    delivery: jsonb("delivery"),
    nextRunAt: bigint("next_run_at", { mode: "number" }).notNull(),
    lastRunAt: bigint("last_run_at", { mode: "number" }),
    /** Parked-predecessor policy ('skip' | 'fire'); null = the default ('skip'). */
    onParked: text("on_parked"),
    /** Chat of the last default-path fire (see StorageAdapter.noteScheduleFire). */
    lastChatId: text("last_chat_id"),
    /** Params each fired chat starts with (ScheduleRecord.params). */
    params: jsonb("params"),
    enabled: integer("enabled").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("latch_schedules_owner_idx").on(t.owner),
    index("latch_schedules_due_idx").on(t.enabled, t.nextRunAt),
  ],
);
