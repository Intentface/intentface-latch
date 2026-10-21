import type { SqlClient } from "./db.js";

/**
 * The tables, created if missing; safe to run on every start. Needs the
 * `pg_trgm` extension (on PGlite, pass it: `new PGlite({ extensions: { pg_trgm } })`).
 *
 * Paths are plain text relative to their space (`playbooks/refunds/SKILL.md`),
 * folders are implied by the files under them, and a grant on a folder covers
 * everything beneath it.
 */
export const MIGRATIONS: readonly string[] = [
  `create extension if not exists pg_trgm`,
  `create table if not exists kb_spaces (
     id          text primary key,
     owner       text not null,               -- Latch owner key: "acme", "acme/u7"
     kind        text not null check (kind in ('shared', 'org', 'user')),
     name        text not null,
     created_at  timestamptz not null default now()
   )`,
  `create index if not exists kb_spaces_owner on kb_spaces (owner)`,
  `create table if not exists kb_files (
     id          uuid primary key default gen_random_uuid(),
     space_id    text not null references kb_spaces (id) on delete cascade,
     path        text not null,
     version     int not null,
     body        text not null,
     size        int not null,
     updated_at  timestamptz not null default now(),
     updated_by  text not null
   )`,
  `create unique index if not exists kb_files_path on kb_files (space_id, path)`,
  `create index if not exists kb_files_trgm on kb_files using gin (body gin_trgm_ops)`,
  `create index if not exists kb_files_fts on kb_files using gin (to_tsvector('simple', body))`,
  `create table if not exists kb_versions (
     file_id     uuid not null references kb_files (id) on delete cascade,
     version     int not null,
     body        text not null,
     author      text not null,
     run_id      text,
     created_at  timestamptz not null default now(),
     primary key (file_id, version)
   )`,
  `create table if not exists kb_grants (
     id          uuid primary key default gen_random_uuid(),
     space_id    text not null references kb_spaces (id) on delete cascade,
     path        text not null default '',    -- '' = the whole space
     subject     text not null,               -- "everyone", "org:acme", "user:acme/u7", "group:staff"
     role        text not null check (role in ('viewer', 'editor')),
     expires_at  timestamptz,
     granted_by  text not null,
     reason      text,
     created_at  timestamptz not null default now()
   )`,
  `create index if not exists kb_grants_space on kb_grants (space_id, subject)`,
];

export async function migrate(db: SqlClient): Promise<void> {
  for (const sql of MIGRATIONS) await db.query(sql);
}
