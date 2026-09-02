/**
 * @intentface/latch-drizzle
 *
 * The StorageAdapter on Drizzle, in two dialects behind the same
 * `StorageAdapter` contract: SQLite (libsql / better-sqlite3 / Turso) and
 * Postgres (node-postgres / postgres-js / PGlite).
 */
export { createSqliteAdapter, isUniqueViolation } from "./adapter.js";
export type { SqliteAdapterOptions } from "./adapter.js";
export { createSqliteSecretStore } from "./secret-store.js";
export type { SqliteSecretStoreOptions } from "./secret-store.js";
export { createSqliteAgentBuilderStore, createPostgresAgentBuilderStore } from "./agent-store.js";
export type { AgentStoreOptions } from "./agent-store.js";
export { migrate, migrateWith } from "./migrate.js";
export * as schema from "./schema.js";
export { createMemoryJobStore } from "./memory-job-store.js";

// Postgres dialect (node-postgres / postgres-js in prod, PGlite for tests).
export { createPostgresAdapter } from "./adapter.pg.js";
export { createPostgresSecretStore } from "./secret-store.pg.js";
export { migratePostgres } from "./migrate.pg.js";
export * as pgSchema from "./schema.pg.js";
export { createPostgresMemoryJobStore } from "./memory-job-store.pg.js";
