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
    error: text("error"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
  },
  (t) => [
    index("latch_runs_chat_idx").on(t.chatId),
    index("latch_runs_reaper_idx").on(t.status, t.leaseExpiresAt),
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
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("latch_agents_owner_name").on(t.owner, t.name)],
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
