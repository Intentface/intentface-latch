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
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    agent: text("agent").notNull(),
    title: text("title"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("latch_chats_org_idx").on(t.orgId)],
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
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    usageInputTokens: integer("usage_input_tokens"),
    usageOutputTokens: integer("usage_output_tokens"),
    costTotal: real("cost_total"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [index("latch_runs_chat_idx").on(t.chatId)],
);

export const usage = sqliteTable(
  "latch_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cost: real("cost").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("latch_usage_org_idx").on(t.orgId)],
);
