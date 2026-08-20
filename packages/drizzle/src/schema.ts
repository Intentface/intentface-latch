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
    /** sha256 of the sorted tool names this turn sent — detects toolset churn. */
    toolsHash: text("tools_hash"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("latch_runs_chat_idx").on(t.chatId),
    index("latch_runs_reaper_idx").on(t.status, t.leaseExpiresAt),
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
 * Same table shape latch-platform's libsql store uses, so hosts can share DBs.
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("latch_agents_owner_name").on(t.owner, t.name)],
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
