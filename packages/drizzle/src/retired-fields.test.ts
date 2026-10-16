import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { parseAgentRecord, type AgentRecord } from "@intentface/latch-agent-builder";
import { createSqliteAgentBuilderStore } from "./agent-store.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";

type P = { userId: string };
const me: P = { userId: "u1" };

const rec = (): AgentRecord => ({ name: "helper", modelId: "m-1", instructions: "help", connections: [], scope: "user" }) as AgentRecord;

describe("versions saved before a field was retired", () => {
  it("read back without it, restore through the strict schema, and don't republish", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = createSqliteAgentBuilderStore<P>(drizzle(client, { schema }), { owner: (p) => [p.userId], modelFor: () => ({}) as never });
    await store.upsert(me, rec());
    // What 0.21 wrote for an agent with evals attached.
    await client.execute(`UPDATE latch_agent_versions SET record = json_set(record, '$.attachedEvals', json('[{"name":"on-topic","prompt":"Stays on topic."}]'))`);

    const v1 = await store.getVersion(me, "helper", "user", 1);
    expect(v1).not.toHaveProperty("attachedEvals");
    expect(() => parseAgentRecord(v1)).not.toThrow();

    await store.upsert(me, rec());
    expect(await store.listVersions(me, "helper", "user")).toHaveLength(1);
  });
});
