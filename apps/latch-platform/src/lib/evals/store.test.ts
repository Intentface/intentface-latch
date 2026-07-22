import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { createEvalStore, migrateEvals, runPassRate } from "./store";
import type { EvalStore } from "./store";

describe("runPassRate", () => {
  it("averages per-case attempt rates; legacy boolean results count 0 or 1", () => {
    expect(runPassRate([])).toBe(0);
    expect(runPassRate([{ pass: true }, { pass: false }])).toBe(0.5);
    // Repeated case: 2/4 attempts = 0.5, plus a legacy pass = 1 → mean 0.75.
    expect(runPassRate([{ pass: true, passes: 2, repeats: 4 }, { pass: true }])).toBe(0.75);
  });
});

const owner = "org/user";

describe("eval store (in-memory libsql)", () => {
  let store: EvalStore;

  beforeAll(async () => {
    const client = createClient({ url: ":memory:" });
    await migrateEvals(client);
    await migrateEvals(client); // idempotent
    store = createEvalStore(client);
  });

  it("saves, upserts, lists, and deletes sets", async () => {
    await store.saveSet({
      owner,
      agentName: "lead-qualifier",
      name: "default",
      cases: [
        { id: "greet", name: "greets", input: "hi", expected: { assertions: { contains: ["hello"] } } },
        { id: "save", name: "saves lead", input: "add acme", expected: { toolCalls: [{ tool: "save_lead" }] } },
      ],
    });
    // Upsert replaces the cases wholesale.
    await store.saveSet({
      owner,
      agentName: "lead-qualifier",
      name: "default",
      cases: [{ id: "greet", name: "greets", input: "hi", expected: { assertions: { contains: ["hello"] } } }],
    });
    const set = await store.getSet(owner, "lead-qualifier", "default");
    expect(set?.cases).toHaveLength(1);
    expect(set?.cases[0].expected.assertions?.contains).toEqual(["hello"]);

    expect(await store.listSets(owner, "lead-qualifier")).toHaveLength(1);
    expect(await store.listSets("other/owner")).toHaveLength(0);

    await store.deleteSet(owner, "lead-qualifier", "default");
    expect(await store.getSet(owner, "lead-qualifier", "default")).toBeNull();
  });

  it("persists runs newest-first with snapshot + results roundtrip", async () => {
    const run1 = await store.saveRun({
      owner,
      agentName: "a",
      setName: "default",
      agentSnapshot: { modelId: "m", instructions: "x" },
      results: [
        { caseId: "c", caseName: "c", pass: false, reasons: ["missing"], threadId: "sub_1", answerPreview: "yo", toolCalls: [] },
      ],
      passCount: 0,
      failCount: 1,
    });
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at for ordering
    const run2 = await store.saveRun({
      owner,
      agentName: "a",
      setName: "default",
      agentSnapshot: null,
      results: [
        { caseId: "c", caseName: "c", pass: true, reasons: [], threadId: "sub_2", answerPreview: "hello", toolCalls: [{ tool: "t" }] },
      ],
      passCount: 1,
      failCount: 0,
    });

    const runs = await store.listRuns(owner, "a", "default");
    expect(runs.map((r) => r.id)).toEqual([run2.id, run1.id]);
    expect(runs[1].agentSnapshot).toEqual({ modelId: "m", instructions: "x" });
    expect(runs[0].agentSnapshot).toBeNull();
    expect(runs[0].results[0].toolCalls).toEqual([{ tool: "t" }]);
    expect(await store.listRuns("other/owner", "a")).toHaveLength(0);
  });

  it("getRun fetches one run by id, owner-scoped, with per-case threadIds", async () => {
    const saved = await store.saveRun({
      owner,
      agentName: "b",
      setName: "default",
      agentSnapshot: null,
      results: [
        { caseId: "c1", caseName: "c1", pass: false, reasons: ["missing"], threadId: "sub_x", answerPreview: "…", toolCalls: [] },
      ],
      passCount: 0,
      failCount: 1,
    });
    const run = await store.getRun(owner, saved.id);
    expect(run?.id).toBe(saved.id);
    expect(run?.results[0].threadId).toBe("sub_x");
    // Another owner can't read it; unknown ids miss cleanly.
    expect(await store.getRun("other/owner", saved.id)).toBeNull();
    expect(await store.getRun(owner, "evr_nope")).toBeNull();
  });
});
