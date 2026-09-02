import type { PgDatabase } from "drizzle-orm/pg-core";
import type { LimitStore } from "@intentface/latch-core";
import * as schema from "./schema.pg.js";
import { makeLimitStore } from "./limit-store.shared.js";

/** LimitStore (per org/user/agent budgets) on a Drizzle Postgres database. */
export function createPostgresLimitStore(db: PgDatabase<any, any, any>): LimitStore {
  return makeLimitStore(db, schema);
}
