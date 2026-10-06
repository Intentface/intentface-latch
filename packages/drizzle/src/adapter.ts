import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { StorageAdapter } from "@intentface/latch-core";
import * as schema from "./schema.js";
import { makeStorageAdapter } from "./adapter.shared.js";

export { isUniqueViolation } from "./adapter.shared.js";

export interface SqliteAdapterOptions<P> {
  /**
   * Derive the ownership key for a principal — the isolation boundary. Coarser
   * (fewer segments) = more sharing; finer = more isolation. Must be
   * server-derived from the authenticated principal, never client input.
   */
  owner: (principal: P) => string[];
}

/**
 * A `StorageAdapter` on a Drizzle SQLite database (libsql / better-sqlite3 /
 * Turso). The caller owns the connection — pass a `drizzle(...)` instance — so
 * the adapter never opens or dialect-binds one itself.
 */
export function createSqliteAdapter<P>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
  opts: SqliteAdapterOptions<P>,
): StorageAdapter<P> {
  return makeStorageAdapter<P>(db, schema, {
    owner: opts.owner,
    // Lease times from the database's clock. `julianday` rather than
    // `unixepoch('subsec')` so older SQLite builds work too.
    nowMs: sql`cast(round((julianday('now') - 2440587.5) * 86400000) as integer)`,
    // No interactive transaction: this adapter also serves synchronous drivers
    // (better-sqlite3), whose transaction API rejects an async callback — and
    // libsql opens a transaction on a NEW connection, which for an in-memory
    // database is a new, empty database. Each INSERT computes its own seq
    // atomically and the UNIQUE (chat_id, seq) index backstops a true race.
    withTx: (fn) => fn(db),
    // Atomicity where it matters (`openTurn`): drizzle's `batch` runs a list of
    // independent statements in one transaction on libsql/Turso (local, memory
    // and remote alike). better-sqlite3 has no batch → sequential fallback.
    ...(typeof (db as unknown as { batch?: unknown }).batch === "function"
      ? {
          batch: (stmts: unknown[]) =>
            (db as unknown as { batch: (s: never) => Promise<unknown[]> }).batch(stmts as never),
        }
      : {
          // Synchronous driver (better-sqlite3, bun:sqlite): drizzle's sync
          // `transaction` with the builders' `.run()` / `.get()` is a real
          // transaction — `openTurn` uses it, so it is atomic here too.
          syncTx: <T,>(fn: (tx: unknown) => T) =>
            (db as unknown as { transaction: (f: (tx: unknown) => T) => T }).transaction(fn),
        }),
  });
}
