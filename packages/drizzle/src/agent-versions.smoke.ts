import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "./migrate.js";
import { createSqliteAgentBuilderStore } from "./agent-store.js";
import * as schema from "./schema.js";
import { agentVersionsSmoke, type AgentVersionsEnv } from "./agent-versions.smoke.shared.js";

/** Agent publish history against an in-memory libsql DB. */
type P = { orgId: string; userId: string };

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

const p: P = { orgId: "o1", userId: "u1" };

async function newEnv(): Promise<AgentVersionsEnv<P>> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const db = drizzle(client);
  return {
    store: createSqliteAgentBuilderStore<P>(db, {
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
        maxSteps: row.maxSteps,
        scope: "user",
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
    },
    remigrate: () => migrate(client),
  };
}

async function main() {
  await agentVersionsSmoke<P>({ newEnv, p, ownerKey: "o1/u1", assert });
  console.log("agent-versions smoke (sqlite): ALL PASS");
}

main().catch((e) => {
  console.error("❌ agent-versions smoke failed:", e);
  throw e; // unhandled rejection → non-zero exit (no @types/node dep here)
});
