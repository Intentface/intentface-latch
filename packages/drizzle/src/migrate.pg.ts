import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

const DDL = [
  `CREATE TABLE IF NOT EXISTS latch_chats (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
     title TEXT, kind TEXT NOT NULL DEFAULT 'user', parent_agent TEXT, params JSONB,
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_chats_owner_idx ON latch_chats (owner)`,
  // NOTE: composite PK — message ids are only unique within a chat, and the
  // UNIQUE (chat_id, seq) guards concurrent appenders. Databases created by an
  // older version of this DDL (global `id` PK, non-unique index) are NOT
  // upgraded by migratePostgres (it only creates missing tables / adds
  // columns) — they need a one-off constraint swap / table rebuild.
  `CREATE TABLE IF NOT EXISTS latch_messages (
     id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts JSONB NOT NULL, metadata JSONB, created_at BIGINT NOT NULL,
     PRIMARY KEY (chat_id, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_messages_chat_seq_idx ON latch_messages (chat_id, seq)`,
  `CREATE TABLE IF NOT EXISTS latch_runs (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
     identity JSONB,
     lease_owner TEXT, lease_expires_at BIGINT, fencing_token INTEGER, heartbeat_at BIGINT,
     attempt INTEGER, usage_input_tokens INTEGER,
     usage_output_tokens INTEGER, usage_cache_read_tokens INTEGER, usage_cache_write_tokens INTEGER,
     cost_total DOUBLE PRECISION, kind TEXT, tools_hash TEXT, error TEXT,
     started_at BIGINT NOT NULL, ended_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_chat_idx ON latch_runs (chat_id)`,
  `CREATE INDEX IF NOT EXISTS latch_runs_reaper_idx ON latch_runs (status, lease_expires_at)`,
  // One active run per chat (see ChatBusyError). Existing DBs may hold several
  // active rows for one chat (pre-invariant concurrent turns, never-reaped T1
  // crashes): keep the newest, mark the rest errored — then the index can exist.
  `UPDATE latch_runs SET status = 'errored', error = 'superseded: duplicate active run',
     lease_owner = NULL, fencing_token = COALESCE(fencing_token, 0) + 1
   WHERE status = 'active' AND EXISTS (
     SELECT 1 FROM latch_runs n
     WHERE n.chat_id = latch_runs.chat_id AND n.status = 'active'
       AND (n.started_at > latch_runs.started_at
            OR (n.started_at = latch_runs.started_at AND n.id > latch_runs.id)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_runs_one_active_per_chat ON latch_runs (chat_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS latch_usage (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
     model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER, cache_write_tokens INTEGER,
     cost DOUBLE PRECISION NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_usage_owner_idx ON latch_usage (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_secrets (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL,
     ciphertext TEXT NOT NULL, iv TEXT NOT NULL, wrapped_dek TEXT NOT NULL, dek_iv TEXT NOT NULL,
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_secrets_owner_idx ON latch_secrets (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_agents (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
     title TEXT, description TEXT, model_id TEXT NOT NULL, instructions TEXT NOT NULL,
     connections JSONB NOT NULL, tools JSONB, exec JSONB, subagents JSONB, attached_evals JSONB,
     max_steps INTEGER,
     scope TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_agents_owner_name ON latch_agents (owner, name)`,
  // Append-only publish history for `latch_agents`. The live row is always a
  // copy of the version its `published_version` names; rollback appends a NEW
  // version carrying an old record, so history is never rewritten.
  `CREATE TABLE IF NOT EXISTS latch_agent_versions (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
     record JSONB NOT NULL, author TEXT, source TEXT,
     changed_fields JSONB, change_message TEXT, created_at BIGINT NOT NULL)`,
  // Backstops the max(version)+1 race: a losing concurrent publish retries.
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_agent_versions_owner_name_version
     ON latch_agent_versions (owner, name, version)`,
  `CREATE INDEX IF NOT EXISTS latch_agent_versions_owner_name_idx
     ON latch_agent_versions (owner, name)`,
  // Who made which version live, and when. Activating an existing version
  // appends no version, so without this a rollback leaves no trace.
  `CREATE TABLE IF NOT EXISTS latch_agent_activations (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
     actor TEXT, source TEXT, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_agent_activations_owner_name_idx
     ON latch_agent_activations (owner, name, created_at)`,
  // One unpublished working copy per (agent, editor) — per PERSON, so two org
  // admins can't overwrite each other's half-written prompt.
  `CREATE TABLE IF NOT EXISTS latch_agent_drafts (
     owner TEXT NOT NULL, name TEXT NOT NULL, editor TEXT NOT NULL,
     record JSONB NOT NULL, base_version INTEGER, updated_at BIGINT NOT NULL,
     PRIMARY KEY (owner, name, editor))`,
  `CREATE INDEX IF NOT EXISTS latch_agent_drafts_owner_idx ON latch_agent_drafts (owner)`,
  // Named, shared, unpublished configurations of an agent (`name@c_<id>`).
  `CREATE TABLE IF NOT EXISTS latch_agent_candidates (
     owner TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
     record JSONB NOT NULL, base_version INTEGER, author TEXT, published_as INTEGER,
     closed_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
     PRIMARY KEY (owner, name, id))`,
  `CREATE TABLE IF NOT EXISTS latch_schedules (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, identity JSONB,
     cron TEXT, timezone TEXT, prompt TEXT NOT NULL, delivery JSONB,
     next_run_at BIGINT NOT NULL, last_run_at BIGINT,
     on_parked TEXT, last_chat_id TEXT, params JSONB,
     enabled INTEGER NOT NULL, lease_owner TEXT, lease_expires_at BIGINT,
     created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_owner_idx ON latch_schedules (owner)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_due_idx ON latch_schedules (enabled, next_run_at)`,
  // Memory sweep state (see @intentface/latch-memory). Lease columns mirror
  // latch_schedules; next_eligible_at always advances so nothing hot-loops.
  // (The sweep index on latch_chats lives in ALTERS: it references the `kind`
  // column, which pre-existing DBs only gain from the ALTER below.)
  `CREATE TABLE IF NOT EXISTS latch_memory_chat_state (
     chat_id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, scope_key TEXT NOT NULL,
     last_extracted_seq INTEGER NOT NULL DEFAULT -1, last_extracted_key TEXT,
     next_eligible_at BIGINT NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
     lease_owner TEXT, lease_expires_at BIGINT,
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_memory_chat_state_scope_idx ON latch_memory_chat_state (scope_key)`,
  `CREATE TABLE IF NOT EXISTS latch_memory_scope_state (
     scope_key TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, connection TEXT NOT NULL,
     identity JSONB, has_new INTEGER NOT NULL DEFAULT 0, pending_episodes JSONB,
     consolidation_watermark TEXT, last_consolidated_at BIGINT,
     next_eligible_at BIGINT NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
     lease_owner TEXT, lease_expires_at BIGINT,
     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_memory_scope_due_idx ON latch_memory_scope_state (has_new, next_eligible_at)`,
  `CREATE TABLE IF NOT EXISTS latch_memory_usage (
     scope_key TEXT NOT NULL, memory_id TEXT NOT NULL,
     usage_count INTEGER NOT NULL DEFAULT 0, last_used_at BIGINT, created_at BIGINT NOT NULL,
     PRIMARY KEY (scope_key, memory_id))`,
  `CREATE TABLE IF NOT EXISTS latch_limit_counters (
     key TEXT NOT NULL, window_start BIGINT NOT NULL, window_ms BIGINT NOT NULL,
     turns INTEGER NOT NULL DEFAULT 0, tokens BIGINT NOT NULL DEFAULT 0, cost DOUBLE PRECISION NOT NULL DEFAULT 0,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (key, window_start, window_ms))`,
  `CREATE INDEX IF NOT EXISTS idx_limit_counters_end ON latch_limit_counters ((window_start + window_ms))`,
];

/** Idempotent column adds for DBs created before a column existed. */
const ALTERS = [
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS timezone TEXT`,
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS delivery JSONB`,
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS on_parked TEXT`,
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS last_chat_id TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS usage_cache_read_tokens INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS usage_cache_write_tokens INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS kind TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS tools_hash TEXT`,
  `ALTER TABLE latch_usage ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER`,
  `ALTER TABLE latch_usage ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER`,
  `ALTER TABLE latch_chats ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user'`,
  `ALTER TABLE latch_chats ADD COLUMN IF NOT EXISTS parent_agent TEXT`,
  `ALTER TABLE latch_memory_chat_state ADD COLUMN IF NOT EXISTS last_extracted_key TEXT`,
  // attached_evals: unused since 0.22 (evals left latch). Kept so existing
  // databases and the version backfill below stay valid.
  `ALTER TABLE latch_agents ADD COLUMN IF NOT EXISTS attached_evals JSONB`,
  `ALTER TABLE latch_agents ADD COLUMN IF NOT EXISTS published_version INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS agent_version INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS settings JSONB`,
  `ALTER TABLE latch_agent_versions ADD COLUMN IF NOT EXISTS changed_fields JSONB`,
  `ALTER TABLE latch_agent_versions ADD COLUMN IF NOT EXISTS change_message TEXT`,
  `ALTER TABLE latch_chats ADD COLUMN IF NOT EXISTS params JSONB`,
  `ALTER TABLE latch_schedules ADD COLUMN IF NOT EXISTS params JSONB`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS owner_key TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN IF NOT EXISTS stop_requested_at BIGINT`,
  // AFTER the kind ALTER above — a pre-kind DB can't index the column earlier.
  `CREATE INDEX IF NOT EXISTS latch_chats_sweep_idx ON latch_chats (kind, updated_at)`,
];

/**
 * Data backfills. Run AFTER `ALTERS` (they reference columns the ALTERs add)
 * and written to be idempotent, so every migrate can re-run them safely.
 */
const BACKFILL = [
  // Runs gained their chat's owner key (RunRecord.ownerKey). Only ACTIVE runs
  // need it filled: crash recovery starts from them. Finished runs fall back to
  // their chat's owner when read. The reaper index keeps this cheap on boot.
  `UPDATE latch_runs SET owner_key = (SELECT c.owner FROM latch_chats c WHERE c.id = latch_runs.chat_id)
   WHERE status = 'active' AND owner_key IS NULL`,
  // Every pre-existing agent becomes v1, so the prompt that was already live is
  // a rollback target. Without this the FIRST publish would create v1 from the
  // NEW content and the running prompt would be lost for good — the exact
  // failure version history exists to prevent. `WHERE NOT EXISTS` makes it a
  // no-op once an agent has any version.
  //
  // `max_steps` is stored column-encoded (NULL=default, 0=unlimited, N=cap) and
  // is decoded here to its `AgentRecord` form. `to_jsonb` on the integer keeps
  // the numeric case a JSON number rather than a string.
  `INSERT INTO latch_agent_versions (id, owner, name, version, record, author, source, created_at)
     SELECT 'agv_' || replace(gen_random_uuid()::text, '-', ''), a.owner, a.name, 1,
            jsonb_build_object(
              'name', a.name,
              'title', a.title,
              'description', a.description,
              'modelId', a.model_id,
              'instructions', a.instructions,
              'connections', a.connections,
              'tools', a.tools,
              'exec', a.exec,
              'subagents', a.subagents,
              'attachedEvals', a.attached_evals,
              'maxSteps', CASE WHEN a.max_steps IS NULL THEN NULL
                               WHEN a.max_steps = 0 THEN to_jsonb('unlimited'::text)
                               ELSE to_jsonb(a.max_steps) END,
              'scope', a.scope),
            NULL, 'backfill', a.created_at
       FROM latch_agents a
      WHERE NOT EXISTS (SELECT 1 FROM latch_agent_versions v
                         WHERE v.owner = a.owner AND v.name = a.name)`,
  // Point every live row at its version. Only fills NULLs, so a row that has
  // published since the backfill keeps its real version.
  `UPDATE latch_agents SET published_version = (
     SELECT MAX(v.version) FROM latch_agent_versions v
      WHERE v.owner = latch_agents.owner AND v.name = latch_agents.name)
   WHERE published_version IS NULL`,
  // ...and record that activation, so the publish timeline is complete from the
  // first row rather than starting at whenever this feature shipped.
  `INSERT INTO latch_agent_activations (id, owner, name, version, actor, source, created_at)
     SELECT 'aga_' || replace(gen_random_uuid()::text, '-', ''), a.owner, a.name,
            a.published_version, NULL, 'backfill', a.created_at
       FROM latch_agents a
      WHERE a.published_version IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM latch_agent_activations x
                         WHERE x.owner = a.owner AND x.name = a.name)`,
];

export async function migratePostgres(db: PgDatabase<any, any, any>): Promise<void> {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
  for (const stmt of ALTERS) await db.execute(sql.raw(stmt));
  for (const stmt of BACKFILL) await db.execute(sql.raw(stmt));
}
