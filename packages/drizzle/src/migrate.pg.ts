import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

const DDL = [
  `CREATE TABLE IF NOT EXISTS latch_chats (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
     title TEXT, kind TEXT NOT NULL DEFAULT 'user',
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_chats_owner_idx ON latch_chats (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_messages (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts JSONB NOT NULL, metadata JSONB, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_messages_chat_idx ON latch_messages (chat_id, seq)`,
  `CREATE TABLE IF NOT EXISTS latch_runs (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
     identity JSONB,
     lease_owner TEXT, lease_expires_at BIGINT, fencing_token INTEGER, heartbeat_at BIGINT,
     attempt INTEGER, usage_input_tokens INTEGER,
     usage_output_tokens INTEGER, usage_cache_read_tokens INTEGER, usage_cache_write_tokens INTEGER,
     cost_total DOUBLE PRECISION, error TEXT,
     started_at BIGINT NOT NULL, ended_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_chat_idx ON latch_runs (chat_id)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_reaper_idx ON latch_runs (status, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS latch_usage (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
     model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
     cost DOUBLE PRECISION NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_usage_owner_idx ON latch_usage (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_secrets (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL,
     ciphertext TEXT NOT NULL, iv TEXT NOT NULL, wrapped_dek TEXT NOT NULL, dek_iv TEXT NOT NULL,
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_secrets_owner_idx ON latch_secrets (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_schedules (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, identity JSONB,
     cron TEXT, timezone TEXT, prompt TEXT NOT NULL, next_run_at BIGINT NOT NULL, last_run_at BIGINT,
     enabled INTEGER NOT NULL, lease_owner TEXT, lease_expires_at BIGINT,
     created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_owner_idx ON latch_schedules (owner)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_due_idx ON latch_schedules (enabled, next_run_at)`,
];

/** Idempotent column adds for DBs created before a column existed. */
const ALTERS = [
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS timezone TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS usage_cache_read_tokens INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS usage_cache_write_tokens INTEGER`,
  `ALTER TABLE latch_chats ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user'`,
];

export async function migratePostgres(db: PgDatabase<any, any, any>): Promise<void> {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
  for (const stmt of ALTERS) await db.execute(sql.raw(stmt));
}
