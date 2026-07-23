import {
  sqliteTable,
  text,
  integer,
  real,
  index,
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
    id: text("id").primaryKey(),
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
  (t) => [index("latch_messages_chat_idx").on(t.chatId, t.seq)],
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
