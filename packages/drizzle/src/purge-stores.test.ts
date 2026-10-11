import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { createRuntime } from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { createSqliteAgentBuilderStore } from "./agent-store.js";
import { createMemoryJobStore } from "./memory-job-store.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";
import { createSqliteSecretStore } from "./secret-store.js";

/**
 * `runtime.purgeOwner` across every store Latch ships: chats (the storage
 * adapter), secrets, stored agents and the memory job state. Rows are written
 * straight into the tables, as each store would have, under three owners: a
 * tenant (`t1`), a person in it (`t1/u7`) and a tenant whose id merely starts
 * the same (`t10`).
 */

type P = { tenantId: string; userId?: string };
const owner = (p: P) => (p.userId ? [p.tenantId, p.userId] : [p.tenantId]);
const OWNERS = ["t1", "t1/u7", "t10"];

async function seed(client: Client) {
  const now = Date.now();
  for (const [i, o] of OWNERS.entries()) {
    await client.execute({
      sql: "INSERT INTO latch_secrets (id, owner, key, ciphertext, iv, wrapped_dek, dek_iv, created_at, updated_at) VALUES (?, ?, 'k', 'c', 'i', 'w', 'd', ?, ?)",
      args: [`${o}:k`, o, now, now],
    });
    await client.execute({
      sql: "INSERT INTO latch_agents (id, owner, name, model_id, instructions, connections, scope, created_at, updated_at) VALUES (?, ?, 'helper', 'm', 'x', '[]', 'org', ?, ?)",
      args: [`agt_${i}`, o, now, now],
    });
    await client.execute({ sql: "INSERT INTO latch_agent_versions (id, owner, name, version, record, created_at) VALUES (?, ?, 'helper', 1, '{}', ?)", args: [`agv_${i}`, o, now] });
    await client.execute({ sql: "INSERT INTO latch_agent_activations (id, owner, name, version, created_at) VALUES (?, ?, 'helper', 1, ?)", args: [`aga_${i}`, o, now] });
    await client.execute({ sql: "INSERT INTO latch_agent_candidates (owner, name, id, title, record, created_at, updated_at) VALUES (?, 'helper', ?, 't', '{}', ?, ?)", args: [o, `c_${i}`, now, now] });
    await client.execute({ sql: "INSERT INTO latch_memory_chat_state (chat_id, owner, agent, scope_key, created_at, updated_at) VALUES (?, ?, 'a', ?, ?, ?)", args: [`chat_${i}`, o, `scope_${i}`, now, now] });
    await client.execute({ sql: "INSERT INTO latch_memory_scope_state (scope_key, owner, agent, connection, created_at, updated_at) VALUES (?, ?, 'a', 'c', ?, ?)", args: [`scope_${i}`, o, now, now] });
    await client.execute({ sql: "INSERT INTO latch_memory_usage (scope_key, memory_id, created_at) VALUES (?, 'm1', ?)", args: [`scope_${i}`, now] });
  }
  // u7 is writing a draft of the TENANT's agent: the draft is theirs.
  await client.execute({ sql: "INSERT INTO latch_agent_drafts (owner, name, editor, record, updated_at) VALUES ('t1', 'helper', 't1/u7', '{}', ?)", args: [now] });
  await client.execute({ sql: "INSERT INTO latch_agent_drafts (owner, name, editor, record, updated_at) VALUES ('t10', 'helper', 't10/u1', '{}', ?)", args: [now] });
}

const owners = async (client: Client, table: string, column = "owner") =>
  (await client.execute(`SELECT ${column} AS o FROM ${table} ORDER BY ${column}`)).rows.map((r) => String(r.o));

describe("runtime.purgeOwner across the shipped stores", () => {
  it("removes a person, then a tenant, from every store, and nothing of another tenant", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await seed(client);
    const db = drizzle(client, { schema });
    const rt = createRuntime<P>({ storage: createSqliteAdapter<P>(db, { owner }), agents: {} });
    const also = {
      secrets: createSqliteSecretStore<P>(db, { owner }),
      agents: createSqliteAgentBuilderStore<P>(db, { owner, modelFor: () => ({}) as never }),
      memory: createMemoryJobStore(db),
    };

    const person = await rt.purgeOwner(["t1", "u7"], { also });
    expect(person.removed.secrets).toEqual({ secrets: 1 });
    expect(person.removed.agents).toMatchObject({ agents: 1, versions: 1, activations: 1, candidates: 1, drafts: 1 });
    expect(person.removed.memory).toEqual({ chatState: 1, scopes: 1, usage: 1 });
    expect(await owners(client, "latch_secrets")).toEqual(["t1", "t10"]);
    expect(await owners(client, "latch_agent_drafts", "editor")).toEqual(["t10/u1"]);

    await rt.purgeOwner(["t1"], { also });
    for (const table of ["latch_secrets", "latch_agents", "latch_agent_versions", "latch_agent_activations", "latch_agent_candidates", "latch_memory_chat_state", "latch_memory_scope_state"]) {
      expect(await owners(client, table), table).toEqual(["t10"]);
    }
    expect(await owners(client, "latch_memory_usage", "scope_key")).toEqual(["scope_2"]);
    expect(await owners(client, "latch_agent_drafts", "editor")).toEqual(["t10/u1"]);
  });
});
