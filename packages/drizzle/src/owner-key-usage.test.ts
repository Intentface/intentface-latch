import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { createSqliteAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";

/**
 * Usage takes its run's owner ("derive once, inherit"), not the principal it
 * happens to be recorded with: a resumed answer re-checks its principal, and a
 * re-checked principal must not move the run's usage to another owner.
 */

type P = { orgId: string; userId: string };
const owner = (p: P) => [p.orgId, p.userId];

describe("recordUsage", () => {
  it("files usage under the run's owner, whatever principal it's called with", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const storage = createSqliteAdapter<P>(drizzle(client, { schema }), { owner });
    const me = { orgId: "o1", userId: "u1" };
    const chat = await storage.createChat(me, { agent: "a" });
    const run = await storage.createRun(me, { chatId: chat.id, agent: "a" });

    await storage.recordUsage({ orgId: "o1", userId: "someone-else" }, { runId: run.id, model: "m", inputTokens: 1, outputTokens: 1, cost: 0 });

    const rows = await client.execute("SELECT owner FROM latch_usage");
    expect(rows.rows.map((r) => r.owner)).toEqual([chat.owner]);
  });
});
