import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { MemoryJobStore } from "@intentface/latch-memory";
import * as schema from "./schema.js";
import { makeMemoryJobStore } from "./memory-job-store.shared.js";

/** MemoryJobStore on a Drizzle SQLite database (libsql / better-sqlite3 / Turso). */
export function createMemoryJobStore<_P = unknown>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
): MemoryJobStore {
  return makeMemoryJobStore(db, schema);
}
