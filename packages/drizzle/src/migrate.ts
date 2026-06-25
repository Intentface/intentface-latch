import type { Client } from "@libsql/client";

/** Create the v1 tables. No migration tooling needed to get running. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS latch_chats (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
     title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_chats_owner_idx ON latch_chats (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_messages (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_messages_chat_idx ON latch_messages (chat_id, seq)`,
  `CREATE TABLE IF NOT EXISTS latch_runs (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
     identity TEXT,
     lease_owner TEXT, lease_expires_at INTEGER, fencing_token INTEGER, heartbeat_at INTEGER,
     attempt INTEGER, usage_input_tokens INTEGER,
     usage_output_tokens INTEGER, cost_total REAL, error TEXT,
     started_at INTEGER NOT NULL, ended_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_chat_idx ON latch_runs (chat_id)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_reaper_idx ON latch_runs (status, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS latch_usage (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
     model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
     cost REAL NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_usage_owner_idx ON latch_usage (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_secrets (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL,
     ciphertext TEXT NOT NULL, iv TEXT NOT NULL, wrapped_dek TEXT NOT NULL, dek_iv TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_secrets_owner_idx ON latch_secrets (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_schedules (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, identity TEXT,
     cron TEXT, timezone TEXT, prompt TEXT NOT NULL, next_run_at INTEGER NOT NULL, last_run_at INTEGER,
     enabled INTEGER NOT NULL, lease_owner TEXT, lease_expires_at INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_owner_idx ON latch_schedules (owner)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_due_idx ON latch_schedules (enabled, next_run_at)`,
];

/** Idempotent column adds for DBs created before a column existed. */
const ALTERS = [`ALTER TABLE latch_schedules ADD COLUMN timezone TEXT`];

export async function migrate(client: Client): Promise<void> {
  for (const stmt of DDL) await client.execute(stmt);
  for (const stmt of ALTERS) {
    try {
      await client.execute(stmt);
    } catch {
      /* column already exists */
    }
  }
}
