import { createClient } from "@libsql/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { describe, it } from "vitest";
import { registerStorageConformance } from "@intentface/latch-core/testing";
import { createSqliteAdapter } from "./adapter.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migrate.pg.js";
import * as schema from "./schema.js";
import * as schemaPg from "./schema.pg.js";

type P = { org: string };
const owner = (p: P) => [p.org];
const principals: [P, P] = [{ org: "org_a" }, { org: "org_b" }];

registerStorageConformance<P>({ describe, it }, "SQLite (libsql)", async () => {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return { store: createSqliteAdapter<P>(drizzle(client, { schema }), { owner }), principals, close: () => client.close(), checksOwnerKey: true };
});

registerStorageConformance<P>({ describe, it }, "Postgres (PGlite)", async () => {
  const pg = new PGlite();
  const db = drizzlePg(pg, { schema: schemaPg });
  await migratePostgres(db);
  return { store: createPostgresAdapter<P>(db, { owner }), principals, close: () => pg.close(), checksOwnerKey: true };
});
