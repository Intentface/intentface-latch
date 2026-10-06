import type { PgDatabase } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { StorageAdapter } from "@intentface/latch-core";
import * as schema from "./schema.pg.js";
import { makeStorageAdapter } from "./adapter.shared.js";
import type { SqliteAdapterOptions } from "./adapter.js";

/**
 * A `StorageAdapter` backed by Postgres. Pass a Drizzle pg database built from any
 * driver — node-postgres / postgres-js in production, or PGlite for tests.
 * Same contract + same query logic as the SQLite adapter (different dialect schema).
 */
export function createPostgresAdapter<P>(
  db: PgDatabase<any, any, any>,
  opts: SqliteAdapterOptions<P>,
): StorageAdapter<P> {
  return makeStorageAdapter<P>(db, schema, {
    owner: opts.owner,
    // Lease times from the database's clock: `clock_timestamp()`, not `now()`,
    // which is frozen at transaction start.
    nowMs: sql`(extract(epoch from clock_timestamp()) * 1000)::bigint`,
    lockFencedRun: true,
    // One transaction per message batch: the max(seq) reads and the inserts
    // commit (or roll back) together, so a crash mid-batch can't leave a
    // partial write and a concurrent appender can't interleave into the same
    // seq range.
    withTx: (fn) => db.transaction(fn),
  });
}
