import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { LimitStore } from "@intentface/latch-core";
import * as schema from "./schema.js";
import { makeLimitStore } from "./limit-store.shared.js";

/** LimitStore (per org/user/agent budgets) on a Drizzle SQLite database. */
export function createSqliteLimitStore(db: BaseSQLiteDatabase<"sync" | "async", any, any>): LimitStore {
  return makeLimitStore(db, schema);
}
