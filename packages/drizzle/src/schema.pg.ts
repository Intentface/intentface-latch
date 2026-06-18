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
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    agent: text("agent").notNull(),
    title: text("title"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_chats_org_idx").on(t.orgId)],
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

export const usage = pgTable(
  "latch_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cost: doublePrecision("cost").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("latch_usage_org_idx").on(t.orgId)],
);
