import type { PgDatabase } from "drizzle-orm/pg-core";
import type { SecretStore } from "@intentface/latch-core";
import * as schema from "./schema.pg.js";
import { makeSecretStore } from "./secret-store.shared.js";
import type { SqliteSecretStoreOptions } from "./secret-store.js";

/** A `SecretStore` on Postgres — same contract + logic as the SQLite store. */
export function createPostgresSecretStore<P>(
  db: PgDatabase<any, any, any>,
  opts: SqliteSecretStoreOptions<P>,
): SecretStore<P> {
  return makeSecretStore<P>(db, schema, opts);
}
