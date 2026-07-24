import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  doublePrecision,
  index,
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
  (t) => [index("latch_chats_owner_idx").on(t.owner)],
);

export const messages = pgTable(
  "latch_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    runId: text("run_id"),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
    metadata: jsonb("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_messages_chat_idx").on(t.chatId, t.seq)],
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

/** Cron-driven agent runs. Carries the identity blob so a tick can rebuild the caller. */
export const schedules = pgTable(
  "latch_schedules",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    identity: jsonb("identity"),
    cron: text("cron"),
    prompt: text("prompt").notNull(),
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
