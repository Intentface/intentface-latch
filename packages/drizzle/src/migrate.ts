import type { Client } from "@libsql/client";

/** Create the v1 tables. No migration tooling needed to get running. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS latch_chats (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
     title TEXT, kind TEXT NOT NULL DEFAULT 'user',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_chats_owner_idx ON latch_chats (owner)`,
  // NOTE: composite PK — message ids are only unique within a chat, and the
  // UNIQUE (chat_id, seq) guards concurrent appenders. Databases created by an
  // older version of this DDL (global `id` PK, non-unique index) can't take the
  // UNIQUE index in place (the old writer restarted `seq` per turn, so a chat
  // may hold duplicate seqs). `migrate(client)` heals them first via
  // `healLegacyMessages` (rebuild + re-sequence); the exec-only `migrateWith`
  // path (no query seam) still needs that one-off rebuild done by the host.
  `CREATE TABLE IF NOT EXISTS latch_messages (
     id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL,
     PRIMARY KEY (chat_id, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_messages_chat_seq_idx ON latch_messages (chat_id, seq)`,
  `CREATE TABLE IF NOT EXISTS latch_runs (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
     identity TEXT,
     lease_owner TEXT, lease_expires_at INTEGER, fencing_token INTEGER, heartbeat_at INTEGER,
     attempt INTEGER, usage_input_tokens INTEGER,
     usage_output_tokens INTEGER, usage_cache_read_tokens INTEGER, usage_cache_write_tokens INTEGER,
     cost_total REAL, kind TEXT, tools_hash TEXT, error TEXT,
     started_at INTEGER NOT NULL, ended_at INTEGER)`,
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
     cost REAL NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_usage_owner_idx ON latch_usage (owner)`,
  `CREATE TABLE IF NOT EXISTS latch_secrets (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL,
     ciphertext TEXT NOT NULL, iv TEXT NOT NULL, wrapped_dek TEXT NOT NULL, dek_iv TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_secrets_owner_idx ON latch_secrets (owner)`,
  // Same shape latch-platform's libsql agent store creates (base table +
  // idempotent ALTERs), so either writer can own an existing DB.
  `CREATE TABLE IF NOT EXISTS latch_agents (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
     title TEXT, description TEXT, model_id TEXT NOT NULL, instructions TEXT NOT NULL,
     connections TEXT NOT NULL, tools TEXT, exec TEXT, subagents TEXT, attached_evals TEXT,
     max_steps INTEGER,
     scope TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_agents_owner_name ON latch_agents (owner, name)`,
  // Append-only publish history for `latch_agents`. The live row is always a
  // copy of the version its `published_version` names; rollback appends a NEW
  // version carrying an old record, so history is never rewritten.
  `CREATE TABLE IF NOT EXISTS latch_agent_versions (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
     record TEXT NOT NULL, author TEXT, source TEXT,
     changed_fields TEXT, change_message TEXT, created_at INTEGER NOT NULL)`,
  // Backstops the max(version)+1 race: a losing concurrent publish retries.
  `CREATE UNIQUE INDEX IF NOT EXISTS latch_agent_versions_owner_name_version
     ON latch_agent_versions (owner, name, version)`,
  `CREATE INDEX IF NOT EXISTS latch_agent_versions_owner_name_idx
     ON latch_agent_versions (owner, name)`,
  // Who made which version live, and when. Activating an existing version
  // appends no version, so without this a rollback leaves no trace.
  `CREATE TABLE IF NOT EXISTS latch_agent_activations (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
     actor TEXT, source TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_agent_activations_owner_name_idx
     ON latch_agent_activations (owner, name, created_at)`,
  // One unpublished working copy per (agent, editor) — per PERSON, so two org
  // admins can't overwrite each other's half-written prompt.
  `CREATE TABLE IF NOT EXISTS latch_agent_drafts (
     owner TEXT NOT NULL, name TEXT NOT NULL, editor TEXT NOT NULL,
     record TEXT NOT NULL, base_version INTEGER, updated_at INTEGER NOT NULL,
     PRIMARY KEY (owner, name, editor))`,
  `CREATE INDEX IF NOT EXISTS latch_agent_drafts_owner_idx ON latch_agent_drafts (owner)`,
  // Named, shared, unpublished configurations of an agent (`name@c_<id>`).
  `CREATE TABLE IF NOT EXISTS latch_agent_candidates (
     owner TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
     record TEXT NOT NULL, base_version INTEGER, author TEXT, published_as INTEGER,
     closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (owner, name, id))`,
  `CREATE TABLE IF NOT EXISTS latch_schedules (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, identity TEXT,
     cron TEXT, timezone TEXT, prompt TEXT NOT NULL, delivery TEXT,
     next_run_at INTEGER NOT NULL, last_run_at INTEGER,
     on_parked TEXT, last_chat_id TEXT,
     enabled INTEGER NOT NULL, lease_owner TEXT, lease_expires_at INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_owner_idx ON latch_schedules (owner)`,
  `CREATE INDEX IF NOT EXISTS latch_schedules_due_idx ON latch_schedules (enabled, next_run_at)`,
  // Memory sweep state (see @intentface/latch-memory). Lease columns mirror
  // latch_schedules; next_eligible_at always advances so nothing hot-loops.
  // (The sweep index on latch_chats lives in ALTERS: it references the `kind`
  // column, which pre-existing DBs only gain from the ALTER below.)
  `CREATE TABLE IF NOT EXISTS latch_memory_chat_state (
     chat_id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, scope_key TEXT NOT NULL,
     last_extracted_seq INTEGER NOT NULL DEFAULT -1, last_extracted_key TEXT,
     next_eligible_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
     lease_owner TEXT, lease_expires_at INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_memory_chat_state_scope_idx ON latch_memory_chat_state (scope_key)`,
  `CREATE TABLE IF NOT EXISTS latch_memory_scope_state (
     scope_key TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, connection TEXT NOT NULL,
     identity TEXT, has_new INTEGER NOT NULL DEFAULT 0, pending_episodes TEXT,
     consolidation_watermark TEXT, last_consolidated_at INTEGER,
     next_eligible_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
     lease_owner TEXT, lease_expires_at INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS latch_memory_scope_due_idx ON latch_memory_scope_state (has_new, next_eligible_at)`,
  `CREATE TABLE IF NOT EXISTS latch_memory_usage (
     scope_key TEXT NOT NULL, memory_id TEXT NOT NULL,
     usage_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL,
     PRIMARY KEY (scope_key, memory_id))`,
  `CREATE TABLE IF NOT EXISTS latch_limit_counters (
     key TEXT NOT NULL, window_start INTEGER NOT NULL, window_ms INTEGER NOT NULL,
     turns INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (key, window_start, window_ms))`,
  // The prune predicate (`window_start + window_ms < ?`) as an expression index.
  `CREATE INDEX IF NOT EXISTS idx_limit_counters_end ON latch_limit_counters (window_start + window_ms)`,
];

/** Idempotent column adds for DBs created before a column existed. */
const ALTERS = [
  `ALTER TABLE latch_schedules ADD COLUMN timezone TEXT`,
  `ALTER TABLE latch_schedules ADD COLUMN delivery TEXT`,
  `ALTER TABLE latch_schedules ADD COLUMN on_parked TEXT`,
  `ALTER TABLE latch_schedules ADD COLUMN last_chat_id TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN usage_cache_read_tokens INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN usage_cache_write_tokens INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN kind TEXT`,
  `ALTER TABLE latch_runs ADD COLUMN tools_hash TEXT`,
  `ALTER TABLE latch_usage ADD COLUMN cache_read_tokens INTEGER`,
  `ALTER TABLE latch_usage ADD COLUMN cache_write_tokens INTEGER`,
  `ALTER TABLE latch_chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`,
  `ALTER TABLE latch_memory_chat_state ADD COLUMN last_extracted_key TEXT`,
  `ALTER TABLE latch_agents ADD COLUMN attached_evals TEXT`,
  `ALTER TABLE latch_agents ADD COLUMN published_version INTEGER`,
  `ALTER TABLE latch_runs ADD COLUMN agent_version INTEGER`,
  `ALTER TABLE latch_agent_versions ADD COLUMN changed_fields TEXT`,
  `ALTER TABLE latch_agent_versions ADD COLUMN change_message TEXT`,
  // AFTER the kind ALTER above — a pre-kind DB can't index the column earlier.
  `CREATE INDEX IF NOT EXISTS latch_chats_sweep_idx ON latch_chats (kind, updated_at)`,
];

/**
 * "Column already exists", wherever a driver put the message (top level or the
 * `cause` chain). Matches only the duplicate-COLUMN forms — sqlite/libsql
 * "duplicate column name", Postgres `column "x" of relation "y" already exists`
 * — so an unrelated schema failure that merely says "already exists" is still
 * propagated.
 */
function isColumnExists(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const message = e instanceof Error ? e.message : String(e);
    if (/duplicate column|column .*already exists/i.test(message)) return true;
    e = e instanceof Error ? e.cause : undefined;
  }
  return false;
}

/**
 * Data backfills. Run AFTER `ALTERS` (they reference columns the ALTERs add)
 * and written to be idempotent, so every `migrate()` can re-run them safely.
 */
const BACKFILL = [
  // Every pre-existing agent becomes v1, so the prompt that was already live is
  // a rollback target. Without this the FIRST publish would create v1 from the
  // NEW content and the running prompt would be lost for good — the exact
  // failure version history exists to prevent. `WHERE NOT EXISTS` makes it a
  // no-op once an agent has any version.
  //
  // `json(col)` embeds the JSON columns as JSON rather than as a quoted string.
  // `max_steps` is stored column-encoded (NULL=default, 0=unlimited, N=cap) and
  // is decoded here to its `AgentRecord` form.
  `INSERT INTO latch_agent_versions (id, owner, name, version, record, author, source, created_at)
     SELECT 'agv_' || lower(hex(randomblob(10))), a.owner, a.name, 1,
            json_object(
              'name', a.name,
              'title', a.title,
              'description', a.description,
              'modelId', a.model_id,
              'instructions', a.instructions,
              'connections', json(a.connections),
              'tools', json(a.tools),
              'exec', json(a.exec),
              'subagents', json(a.subagents),
              'attachedEvals', json(a.attached_evals),
              'maxSteps', CASE WHEN a.max_steps IS NULL THEN NULL
                               WHEN a.max_steps = 0 THEN 'unlimited'
                               ELSE a.max_steps END,
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
     SELECT 'aga_' || lower(hex(randomblob(10))), a.owner, a.name, a.published_version,
            NULL, 'backfill', a.created_at
       FROM latch_agents a
      WHERE a.published_version IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM latch_agent_activations x
                         WHERE x.owner = a.owner AND x.name = a.name)`,
];

/**
 * Run the schema against any executor — a driver-agnostic seam so a consumer on
 * a non-libsql driver (e.g. better-sqlite3's `db.run`) can create the tables
 * without pulling in a libsql `Client`. `exec` runs one statement; ALTERs that
 * fail because the column already exists are swallowed.
 */
export async function migrateWith(
  exec: (sql: string) => unknown | Promise<unknown>,
): Promise<void> {
  for (const stmt of DDL) await exec(stmt);
  for (const stmt of ALTERS) {
    try {
      await exec(stmt);
    } catch (error) {
      // Idempotency only: swallow "column already exists" (sqlite/libsql say
      // "duplicate column name"), propagate everything else (locked DB, failed
      // write) so callers don't proceed against an outdated schema. Some
      // drivers surface the message on a wrapped cause (drizzle's better-sqlite3
      // binding throws a DrizzleError whose `cause` is the SqliteError), so
      // look down the cause chain, not just at the top-level message.
      if (!isColumnExists(error)) throw error;
    }
  }
  for (const stmt of BACKFILL) await exec(stmt);
}

/**
 * One-off upgrade for DBs created before `latch_messages` moved to a composite
 * `(chat_id, id)` PK + `UNIQUE (chat_id, seq)`. The old DDL used a global `id`
 * PK and a NON-unique `(chat_id, seq)` index, and the old writer restarted
 * `seq` per turn — so an existing chat can hold duplicate `(chat_id, seq)` rows,
 * which makes the new UNIQUE index fail to create. Rebuild once into the correct
 * shape, re-sequencing `seq` densely per chat (order preserved: by old seq, then
 * time), then swap. No-op on a fresh DB (table absent → the DDL builds it right)
 * or an already-migrated DB (composite PK present). Columns are unchanged, so
 * the copy is loss-free. libsql-only (needs a query to detect the legacy shape);
 * the exec-only `migrateWith` path can't run it.
 */
async function healLegacyMessages(client: Client): Promise<void> {
  const existing = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='latch_messages'",
  );
  const ddl = existing.rows[0]?.sql as string | undefined;
  if (!ddl) return; // fresh DB — the create DDL builds the right shape
  if (/PRIMARY\s+KEY\s*\(\s*chat_id\s*,\s*id\s*\)/i.test(ddl)) return; // already upgraded
  // Atomic rebuild: correct-shape table, densely re-sequenced seq per chat.
  await client.batch(
    [
      `CREATE TABLE latch_messages_v2 (
         id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
         role TEXT NOT NULL, parts TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL,
         PRIMARY KEY (chat_id, id))`,
      // Re-sequence by true chronology — `created_at`, then insertion order
      // (`rowid`). NOT by old `seq`: the legacy writer restarted `seq` per turn,
      // so ordering by seq would interleave turns (all seq=0s, then all seq=1s).
      `INSERT INTO latch_messages_v2 (id, chat_id, run_id, seq, role, parts, metadata, created_at)
         SELECT id, chat_id, run_id,
                ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at, rowid) - 1,
                role, parts, metadata, created_at
         FROM latch_messages`,
      `DROP TABLE latch_messages`,
      `ALTER TABLE latch_messages_v2 RENAME TO latch_messages`,
    ],
    "write",
  );
}

export async function migrate(client: Client): Promise<void> {
  await healLegacyMessages(client);
  await migrateWith((s) => client.execute(s));
}
