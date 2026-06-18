import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

const DDL = [
  `CREATE TABLE IF NOT EXISTS latch_chats (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, agent TEXT NOT NULL,
     title TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_chats_org_idx ON latch_chats (org_id)`,
  `CREATE TABLE IF NOT EXISTS latch_messages (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts JSONB NOT NULL, metadata JSONB, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_messages_chat_idx ON latch_messages (chat_id, seq)`,
  `CREATE TABLE IF NOT EXISTS latch_runs (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
     lease_owner TEXT, lease_expires_at BIGINT, fencing_token INTEGER, heartbeat_at BIGINT,
     attempt INTEGER, usage_input_tokens INTEGER,
     usage_output_tokens INTEGER, cost_total DOUBLE PRECISION, error TEXT,
     started_at BIGINT NOT NULL, ended_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_chat_idx ON latch_runs (chat_id)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_reaper_idx ON latch_runs (status, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS latch_usage (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, run_id TEXT NOT NULL,
     model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
     cost DOUBLE PRECISION NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_usage_org_idx ON latch_usage (org_id)`,
];

export async function migratePostgres(db: PgDatabase<any, any, any>): Promise<void> {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
}
