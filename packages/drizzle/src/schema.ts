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
  (t) => [index("latch_chats_owner_idx").on(t.owner)],
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
