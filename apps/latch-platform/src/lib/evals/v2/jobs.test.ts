import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import type { Dataset, Input, Rubric } from "./model";
import { advanceJob, estimateRun, type EvalJob, type JobDeps } from "./jobs";
import { createEvalsStore, migrateEvalsV2, type EvalsStore } from "./store";

const owner = "org/user";
const dataset: Dataset = { owner, id: "ds", agentName: "bot", name: "set", kind: "inputs", createdAt: 0, updatedAt: 0 };
const inputs: Input[] = [
  { id: "1", prompt: "one" },
  { id: "2", prompt: "two" },
  { id: "3", prompt: "three" },
];
const rubric: Rubric = {
  owner,
  id: "r",
  agentName: "bot",
  version: 1,
  defaultJudge: "jev-latest",
  createdAt: 0,
  checks: [
    { kind: "counted", id: "looked", label: "Looked", spec: { op: "called", tool: "lookup" } },
    { kind: "asked", id: "ok", label: "OK", ask: "Is it ok?", shape: { type: "boolean" } },
  ],
};
const judge: EvaluationModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedQuestionTypes: ["boolean", "choice", "score"],
  async doEvaluate(o) {
    return {
      answers: Object.fromEntries(Object.keys(o.questions).map((k) => [k, { type: "boolean", probability: 0.9 }])),
      usage: { inputTokens: 1, outputTokens: 1 },
      warnings: [],
    };
  },
};

let store: EvalsStore;
let agentCalls: number;
const histories = new Map<string, unknown[]>();

function job(patch: Partial<EvalJob> = {}): EvalJob {
  return {
    owner,
    id: "run_a",
    runId: "run_a",
    kind: "run",
    agentName: "bot",
    datasetId: "ds",
    rubricId: "r",
    principal: { orgId: "org" },
    versions: [{ label: "live", ref: "bot", fingerprint: "A" }],
    inputIds: ["1", "2", "3"],
    repeats: 2,
    status: "running",
    total: 6,
    done: 0,
    failed: 0,
    estimate: { agentRuns: 6, judgeCalls: 6, cost: null, basis: "" },
    createdAt: 0,
    updatedAt: 0,
    leaseUntil: 0,
    ...patch,
  };
}

function deps(id = "run_a", onAgent?: () => void): JobDeps {
  return {
    run: {
      runAgent: ({ prompt }) => {
        agentCalls += 1;
        onAgent?.();
        const threadId = `t${agentCalls}`;
        histories.set(threadId, [
          { role: "user", parts: [{ type: "text", text: prompt }] },
          { role: "assistant", parts: [{ type: "dynamic-tool", toolName: "lookup", input: {}, output: {} }, { type: "text", text: "done" }] },
        ]);
        return Promise.resolve({ threadId, answer: "done" });
      },
    },
    judge: { loadHistory: (t) => Promise.resolve(histories.get(t) ?? []), judgeFor: () => judge },
    loadInputs: () => Promise.resolve(inputs),
    loadDataset: () => Promise.resolve(dataset),
    loadRubric: () => Promise.resolve(rubric),
    threadsOf: (runId) => store.listThreads(owner, { runId }),
    saveThread: (t) => store.saveThread(t),
    verdictsOf: (threadIds, v) => store.listVerdicts({ threadIds, rubricVersion: v }),
    saveVerdicts: (vs) => store.saveVerdicts(vs),
    update: (patch) => store.updateJob(id, patch),
  };
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  await migrateEvalsV2(client);
  store = createEvalsStore(client);
  agentCalls = 0;
  histories.clear();
});

describe("jobs", () => {
  it("runs every unit, then judges, then finishes", async () => {
    await store.saveJob(job());
    const end = await advanceJob(job(), deps(), { deadline: Date.now() + 60_000, concurrency: 1 });
    expect(end).toMatchObject({ status: "done", done: 6, failed: 0 });
    expect(agentCalls).toBe(6);
    const threads = await store.listThreads(owner, { runId: "run_a" });
    expect(await store.listVerdicts({ threadIds: threads.map((t) => t.threadId), rubricVersion: 1 })).toHaveLength(12);
  });

  it("starts nothing past the deadline, and resuming never pays twice", async () => {
    await store.saveJob(job());
    // Stop after the second unit by moving the deadline into the past.
    let deadline = Date.now() + 60_000;
    const first = await advanceJob(job(), deps("run_a", () => agentCalls === 2 && (deadline = 0)), {
      get deadline() {
        return deadline;
      },
      concurrency: 1,
    } as { deadline: number; concurrency: number });
    expect(first.status).toBe("running");
    expect(agentCalls).toBe(2);
    const second = await advanceJob((await store.getJob(owner, "run_a"))!, deps(), { deadline: Date.now() + 60_000, concurrency: 1 });
    expect(second.status).toBe("done");
    expect(agentCalls).toBe(6);
  });

  it("stops when cancelled elsewhere, and stays cancelled", async () => {
    await store.saveJob(job());
    const end = await advanceJob(job(), deps("run_a", () => agentCalls === 1 && void store.updateJob("run_a", { status: "cancelled" })), {
      deadline: Date.now() + 60_000,
      concurrency: 1,
    });
    expect(end.status).toBe("cancelled");
    expect(agentCalls).toBeLessThan(6);
    await store.updateJob("run_a", { status: "running" });
    expect((await store.getJob(owner, "run_a"))!.status).toBe("cancelled");
  });

  it("a judge job re-scores an existing run without running the agent", async () => {
    await store.saveJob(job());
    await advanceJob(job(), deps(), { deadline: Date.now() + 60_000 });
    const calls = agentCalls;
    const j = job({ id: "judge_a", runId: "run_a", kind: "judge", total: 0 });
    await store.saveJob(j);
    const end = await advanceJob(j, { ...deps("judge_a"), loadRubric: () => Promise.resolve({ ...rubric, version: 2 }) }, { deadline: Date.now() + 60_000 });
    expect(end).toMatchObject({ status: "done", total: 6, done: 6 });
    expect(agentCalls).toBe(calls);
  });

  it("answering again adds one try per input to the same run, and leaves the others alone", async () => {
    await store.saveJob(job({ repeats: 1, total: 3 }));
    await advanceJob(job({ repeats: 1, total: 3 }), deps(), { deadline: Date.now() + 60_000, concurrency: 1 });
    expect(agentCalls).toBe(3);
    const again = job({ id: "again_a", runId: "run_a", inputIds: ["2"], repeats: 1, tryOf: { "2": 1 }, total: 1 });
    await store.saveJob(again);
    const end = await advanceJob(again, deps("again_a"), { deadline: Date.now() + 60_000, concurrency: 1 });
    expect(end.status).toBe("done");
    expect(agentCalls).toBe(4);
    const threads = await store.listThreads(owner, { runId: "run_a" });
    expect(threads.map((t) => `${t.inputId}.${t.attempt}`).sort()).toEqual(["1.0", "2.0", "2.1", "3.0"]);
    // Resuming it runs nothing more: the new try is already there.
    await advanceJob((await store.getJob(owner, "again_a"))!, deps("again_a"), { deadline: Date.now() + 60_000 });
    expect(agentCalls).toBe(4);
  });

  it("a judge job can be limited to some threads", async () => {
    await store.saveJob(job({ repeats: 1, total: 3 }));
    await advanceJob(job({ repeats: 1, total: 3 }), deps(), { deadline: Date.now() + 60_000, concurrency: 1 });
    const one = (await store.listThreads(owner, { runId: "run_a" }))[0].threadId;
    const j = job({ id: "judge_b", runId: "run_a", kind: "judge", total: 0, threadIds: [one] });
    await store.saveJob(j);
    const end = await advanceJob(j, { ...deps("judge_b"), loadRubric: () => Promise.resolve({ ...rubric, version: 3 }) }, { deadline: Date.now() + 60_000 });
    expect(end).toMatchObject({ status: "done", total: 1, done: 1 });
  });

  it("only one holder gets the lease", async () => {
    await store.saveJob(job());
    const now = Date.now();
    expect(await store.claimJob("run_a", now, 60_000)).toBe(true);
    expect(await store.claimJob("run_a", now, 60_000)).toBe(false);
    expect(await store.claimableJobs(now)).toEqual([]);
    expect(await store.claimableJobs(now + 61_000)).toEqual([{ owner, id: "run_a" }]);
  });
});

describe("unit order", () => {
  it("interleaves versions question by question, so they answer side by side", async () => {
    const { unitsOf } = await import("./jobs");
    const units = unitsOf(
      {
        versions: [
          { label: "live", ref: "a", fingerprint: "A" },
          { label: "@draft", ref: "a@draft", fingerprint: "B" },
        ],
        inputIds: ["1", "2"],
        repeats: 2,
      },
      inputs,
    );
    expect(units.map((u) => `${u.input.id}.${u.attempt}.${u.v.label}`)).toEqual([
      "1.0.live", "1.0.@draft", "1.1.live", "1.1.@draft",
      "2.0.live", "2.0.@draft", "2.1.live", "2.1.@draft",
    ]);
  });
});

describe("estimates", () => {
  it("refuses to guess without history", () => {
    expect(estimateRun({ units: 12, askedChecks: 3, history: [] })).toMatchObject({ agentRuns: 12, judgeCalls: 12, cost: null });
  });

  it("prices from the expensive end of past threads, not the mean", () => {
    const e = estimateRun({ units: 10, askedChecks: 0, history: [0.05, 0.05, 0.05, 0.3] });
    expect(e.judgeCalls).toBe(0);
    expect(e.cost).toBeCloseTo(3);
  });
});

describe("reusable results", () => {
  it("finds the latest run that answered every question and try with the same configuration", async () => {
    const { reusableResults } = await import("@/lib/evals-jobs");
    const t = (runId: string, fingerprint: string, inputId: string, attempt: number, createdAt: number, extra: object = {}) =>
      ({ owner, threadId: `${runId}${inputId}${attempt}`, datasetId: "ds", runId, version: "live", configFingerprint: fingerprint, inputId, attempt, createdAt, ...extra }) as never;
    const past = [
      t("old", "A", "1", 0, 1), t("old", "A", "2", 0, 1),
      t("new", "A", "1", 0, 5, { version: "v3" }), t("new", "A", "2", 0, 5, { version: "v3" }),
      t("gap", "A", "1", 0, 9),
      t("split", "A", "1", 0, 8), t("split", "A", "2", 0, 8, { version: "v4" }),
      t("draft", "B", "1", 0, 9), t("draft", "B", "2", 0, 9),
    ];
    const v = [{ label: "live", fingerprint: "A" }, { label: "@draft", fingerprint: "C" }];
    // "gap" missed question 2, "split" answered it under two names; "new" answered
    // both as v3 — the same configuration live is now. @draft changed since.
    expect(reusableResults(past, v, ["1", "2"], 1)).toEqual([{ version: "live", runId: "new", as: "v3", at: 5 }]);
    // Two tries asked for, one given: nothing covers it.
    expect(reusableResults(past, v, ["1", "2"], 2)).toEqual([]);
  });
});
