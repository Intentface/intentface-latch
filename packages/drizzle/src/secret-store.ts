import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SecretStore } from "@intentface/latch-core";
import * as schema from "./schema.js";
import { makeSecretStore } from "./secret-store.shared.js";
import type { SharedSecretStoreOptions } from "./secret-store.shared.js";

export type SqliteSecretStoreOptions<P> = SharedSecretStoreOptions<P>;

/**
 * A `SecretStore` on a Drizzle SQLite database — persists the Vault's opaque
 * encrypted records. It never sees plaintext; encryption/decryption happens in
 * `createVault`. The caller owns the connection (pass a `drizzle(...)`).
 */
export function createSqliteSecretStore<P>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
  opts: SqliteSecretStoreOptions<P>,
): SecretStore<P> {
  return makeSecretStore<P>(db, schema, opts);
}
