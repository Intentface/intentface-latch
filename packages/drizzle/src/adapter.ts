import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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
    // No explicit transaction: this adapter also serves synchronous drivers
    // (better-sqlite3), whose native transaction API rejects the async
    // callback async drivers (libsql) need. Each INSERT computes its own seq
    // atomically and the UNIQUE (chat_id, seq) index backstops a true race.
    withTx: (fn) => fn(db),
  });
}
