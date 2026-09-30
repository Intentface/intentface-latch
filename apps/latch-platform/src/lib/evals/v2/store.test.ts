import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createEvalsStore, migrateEvalsV2 } from "./store";

const set = (owner: string) => ({ owner, id: "ds_weather", agentName: "a", name: "Weather", kind: "inputs" as const, createdAt: 0, updatedAt: 0 });

describe("inputs, members and views belong to their set's owner", () => {
  it("two owners with the same set id never see or overwrite each other's", async () => {
    const client = createClient({ url: ":memory:" });
    await migrateEvalsV2(client);
    const store = createEvalsStore(client);
    for (const o of ["orgA", "orgB"]) await store.saveDataset(set(o));
    await store.setInputs("orgA", "ds_weather", [{ id: "1", prompt: "A's question" }]);
    await store.setInputs("orgB", "ds_weather", [{ id: "1", prompt: "B's question" }]);
    expect((await store.listInputs("orgA", "ds_weather")).map((i) => i.prompt)).toEqual(["A's question"]);
    expect((await store.listInputs("orgB", "ds_weather")).map((i) => i.prompt)).toEqual(["B's question"]);
    // Knowing another owner's set id is not enough to read it.
    expect(await store.listInputs("orgC", "ds_weather")).toEqual([]);

    await store.saveView("orgA", { datasetId: "ds_weather", id: "v1", name: "A", tags: [], createdAt: 0 });
    expect(await store.listViews("orgB", "ds_weather")).toEqual([]);
    await store.removeView("orgB", "ds_weather", "v1");
    expect(await store.listViews("orgA", "ds_weather")).toHaveLength(1);

    await store.setMembers("orgA", "ds_weather", ["t1"]);
    await store.setMembers("orgB", "ds_weather", ["t2"]);
    expect(await store.listMembers("orgA", "ds_weather")).toEqual(["t1"]);
  });

  it("tables from before owner scoping are rebuilt once, each row taking its set's owner", async () => {
    const client = createClient({ url: ":memory:" });
    await client.batch(
      [
        `CREATE TABLE latch_eval_datasets (owner TEXT NOT NULL, id TEXT NOT NULL, agent_name TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, audience TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, id))`,
        `INSERT INTO latch_eval_datasets VALUES ('orgA', 'ds_x', 'a', 'X', 'inputs', NULL, NULL, 0, 0)`,
        `CREATE TABLE latch_eval_inputs (dataset_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, prompt TEXT NOT NULL, follow_ups TEXT, facts TEXT, PRIMARY KEY (dataset_id, id))`,
        `INSERT INTO latch_eval_inputs VALUES ('ds_x', '1', 0, 'old question', NULL, NULL)`,
        `CREATE TABLE latch_eval_views (dataset_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (dataset_id, id))`,
        `INSERT INTO latch_eval_views VALUES ('ds_x', 'v', 'View', '[]', 0)`,
      ],
      "write",
    );
    await migrateEvalsV2(client);
    await migrateEvalsV2(client); // and again: a no-op
    const store = createEvalsStore(client);
    expect((await store.listInputs("orgA", "ds_x")).map((i) => i.prompt)).toEqual(["old question"]);
    expect((await store.listViews("orgA", "ds_x")).map((v) => v.name)).toEqual(["View"]);
  });
});
