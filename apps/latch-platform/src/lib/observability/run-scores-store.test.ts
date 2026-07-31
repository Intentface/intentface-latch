import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createRunScoresStore, migrateRunScores } from "./run-scores-store";
import type { RunScoresStore, RunScoreWrite } from "./run-scores-store";

const AGENT_OWNER = "org"; // an org-shared agent's owner key
const RUNNER = "org/colleague"; // the member who ran it
const MINE = "org/me"; // my personal key

const score = (over: Partial<RunScoreWrite> = {}): RunScoreWrite => ({
  runId: "r1",
  rubricName: "greets",
  value: 1,
  scale: "binary",
  source: "live",
  updatedAt: 1_000,
  ...over,
});

describe("run scores store (in-memory libsql)", () => {
  let store: RunScoresStore;

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    await migrateRunScores(client);
    await migrateRunScores(client); // idempotent, including the added columns
    store = createRunScoresStore(client);
  });

  it("round-trips the runner alongside the eval owner", async () => {
    await store.put(AGENT_OWNER, score({ runOwner: RUNNER }));
    const got = await store.getOne(AGENT_OWNER, "r1", "greets");
    expect(got).toMatchObject({ runOwner: RUNNER, owner: AGENT_OWNER, value: 1 });
  });

  it("hides a verdict from an owner key that doesn't administer the agent", async () => {
    await store.put(AGENT_OWNER, score({ runOwner: RUNNER }));
    // The colleague who RAN it reads under their own keys and sees nothing.
    expect(await store.getOne([RUNNER, "other-org"], "r1", "greets")).toBeNull();
    expect((await store.getForRuns([RUNNER, "other-org"], ["r1"])).size).toBe(0);
  });

  it("reads across several owner keys in one hop", async () => {
    await store.put(AGENT_OWNER, score({ runOwner: RUNNER }));
    await store.put(MINE, score({ runId: "r2", rubricName: "concise" }));
    const byRun = await store.getForRuns([MINE, AGENT_OWNER], ["r1", "r2"]);
    expect(byRun.get("r1")?.map((s) => s.rubricName)).toEqual(["greets"]);
    expect(byRun.get("r2")?.map((s) => s.rubricName)).toEqual(["concise"]);
  });

  it("collapses a duplicated verdict to the newest row", async () => {
    // The pre-split row (keyed by the runner, which for my own runs IS my key)
    // and the post-split row (keyed by the agent's owner) describe one verdict.
    await store.put(MINE, score({ value: 0, updatedAt: 1_000 }));
    await store.put(AGENT_OWNER, score({ value: 1, updatedAt: 2_000 }));
    const byRun = await store.getForRuns([MINE, AGENT_OWNER], ["r1"]);
    expect(byRun.get("r1")).toHaveLength(1);
    expect(byRun.get("r1")?.[0]).toMatchObject({ value: 1, owner: AGENT_OWNER });
    // getOne agrees, so the human-correction guard can't disagree with the badge.
    expect(await store.getOne([MINE, AGENT_OWNER], "r1", "greets")).toMatchObject({
      value: 1,
    });
  });

  it("keeps a human correction's runner attribution on upsert", async () => {
    await store.put(AGENT_OWNER, score({ runOwner: RUNNER }));
    // A correction isn't a run, so it carries no runner — the original must stand.
    await store.put(
      AGENT_OWNER,
      score({ value: 0, source: "human", comment: "wrong", updatedAt: 2_000 }),
    );
    expect(await store.getOne(AGENT_OWNER, "r1", "greets")).toMatchObject({
      source: "human",
      value: 0,
      runOwner: RUNNER,
    });
  });

  it("treats an empty key list as 'no rows', not a malformed query", async () => {
    await store.put(AGENT_OWNER, score());
    expect(await store.getOne([], "r1", "greets")).toBeNull();
    expect((await store.getForRuns([], ["r1"])).size).toBe(0);
  });

  it("sorts each run's scores by rubric name", async () => {
    await store.put(AGENT_OWNER, score({ rubricName: "zeta" }));
    await store.put(AGENT_OWNER, score({ rubricName: "alpha" }));
    const byRun = await store.getForRuns(AGENT_OWNER, ["r1"]);
    expect(byRun.get("r1")?.map((s) => s.rubricName)).toEqual(["alpha", "zeta"]);
  });
});
