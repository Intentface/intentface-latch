import type { PgDatabase } from "drizzle-orm/pg-core";
import type { MemoryJobStore } from "@intentface/latch-memory";
import * as schema from "./schema.pg.js";
import { makeMemoryJobStore } from "./memory-job-store.shared.js";

/** MemoryJobStore on a Drizzle Postgres database (node-postgres / postgres-js / PGlite). */
export function createPostgresMemoryJobStore(db: PgDatabase<any, any, any>): MemoryJobStore {
  return makeMemoryJobStore(db, schema);
}
