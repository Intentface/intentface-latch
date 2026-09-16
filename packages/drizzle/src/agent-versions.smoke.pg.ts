import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratePostgres } from "./migrate.pg.js";
import { createPostgresAgentBuilderStore } from "./agent-store.js";
import * as schema from "./schema.pg.js";
import { agentVersionsSmoke, type AgentVersionsEnv } from "./agent-versions.smoke.shared.js";

/**
 * The same checks against in-memory Postgres (PGlite, WASM). Worth its own run:
 * the backfill is hand-written per dialect (`jsonb_build_object` here,
 * `json_object` + `json(col)` on sqlite), so only this catches a Postgres-only
 * mistake in the one statement that rescues already-running prompts.
 */
type P = { orgId: string; userId: string };

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

const p: P = { orgId: "o1", userId: "u1" };

async function newEnv(): Promise<AgentVersionsEnv<P>> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migratePostgres(db);
  return {
    store: createPostgresAgentBuilderStore<P>(db, {
      owner: (pr, scope) => (scope === "org" ? [pr.orgId] : [pr.orgId, pr.userId]),
      modelFor: (id) => ({ modelId: id }) as never,
    }),
    async insertLegacyAgent(row) {
      // Straight to the table: no version row, published_version left NULL.
      await db.insert(schema.agents).values({
        id: "agt_legacy",
        owner: row.owner,
        name: row.name,
        title: row.title,
        description: null,
        modelId: row.modelId,
        instructions: row.instructions,
        connections: row.connections,
        tools: null,
        exec: row.exec,
        subagents: null,
        attachedEvals: null,
        maxSteps: row.maxSteps,
        scope: "user",
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
    },
    remigrate: () => migratePostgres(db),
  };
}

async function main() {
  await agentVersionsSmoke<P>({ newEnv, p, ownerKey: "o1/u1", assert });
  console.log("agent-versions smoke (postgres): ALL PASS");
}

main().catch((e) => {
  console.error("❌ agent-versions pg smoke failed:", e);
  throw e; // unhandled rejection → non-zero exit (no @types/node dep here)
});
