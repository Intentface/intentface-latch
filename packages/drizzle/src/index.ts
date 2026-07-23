/**
 * @intentface/latch-drizzle
 *
 * The StorageAdapter on Drizzle. SQLite/libsql first (local file or Turso);
 * the Postgres dialect lands next behind the same `StorageAdapter` contract.
 */
export { createSqliteAdapter } from "./adapter.js";
export type { SqliteAdapterOptions, MessageStore } from "./adapter.js";
export { createSqliteSecretStore } from "./secret-store.js";
export type { SqliteSecretStoreOptions } from "./secret-store.js";
export { migrate, migrateWith } from "./migrate.js";
export * as schema from "./schema.js";

// Postgres dialect (node-postgres / postgres-js in prod, PGlite for tests).
export { createPostgresAdapter } from "./adapter.pg.js";
export { createPostgresSecretStore } from "./secret-store.pg.js";
export { migratePostgres } from "./migrate.pg.js";
export * as pgSchema from "./schema.pg.js";
