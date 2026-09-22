import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import type { Dataset, Input, Rubric } from "./model";
import { compareVersions, consistency, judgeThreads, mcnemar, runDataset, summarize } from "./runner";
import { createEvalsStore, migrateEvalsV2, type EvalsStore } from "./store";

const owner = "org/user";

const dataset: Dataset = {
  owner,
  id: "ds1",
  agentName: "linear-bot",
  name: "triage",
  kind: "inputs",
  createdAt: 0,
  updatedAt: 0,
};

const inputs: Input[] = [
  { id: "i1", prompt: "Close ABC-12", facts: { mustNot: ["delete anything"] } },
  { id: "i2", prompt: "Close ABC-13", followUps: ["and tell me why"] },
  { id: "i3", prompt: "Close ABC-14" },
];

const rubric: Rubric = {
  owner,
  id: "r1",
  agentName: "linear-bot",
  version: 1,
  defaultJudge: "jev-latest",
  createdAt: 0,
  checks: [
    { kind: "counted", id: "looked", label: "Looked first", spec: { op: "before", tool: "linear_get_issue", then: "linear_update_issue" } },
    { kind: "counted", id: "no-delete", label: "Never deletes", spec: { op: "never_called", tool: "linear_delete_*" } },
    { kind: "asked", id: "did-it", label: "Did what was asked", ask: "Did it close the issue?", shape: { type: "boolean" } },
  ],
};

/**
 * A fake agent whose behaviour depends on the version: `@good` looks before
 * acting, `live` does not, and `@broken` produces no answer at all.
 */
const histories = new Map<string, unknown[]>();
let n = 0;
function fakeAgent({ agent, prompt, threadId }: { agent: string; prompt: string; threadId?: string }) {
  const id = threadId ?? `t${++n}`;
  const good = agent.endsWith("@good");
  const broken = agent.endsWith("@broken");
  const call = (toolName: string, input: unknown) => ({ type: "dynamic-tool", toolName, input, output: { ok: true } });
  const turn = [
    { role: "user", parts: [{ type: "text", text: prompt }] },
    {
      role: "assistant",
      parts: [
        ...(good ? [call("linear_get_issue", { id: prompt })] : []),
        call("linear_update_issue", { state: "Done" }),
        ...(broken ? [] : [{ type: "text", text: "Done." }]),
      ],
    },
  ];
  histories.set(id, [...(histories.get(id) ?? []), ...turn]);
  return Promise.resolve({ threadId: id, answer: broken ? "" : "Done." });
}

/** A judge that answers "yes" and records what it was shown. */
const seen: Record<string, string>[] = [];
const judge: EvaluationModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedQuestionTypes: ["boolean", "choice", "score"],
  async doEvaluate(o) {
    seen.push(o.state as Record<string, string>);
    return {
      answers: Object.fromEntries(Object.keys(o.questions).map((k) => [k, { type: "boolean", probability: 0.9 }])),
      usage: { inputTokens: 10, outputTokens: 1 },
      warnings: [],
    };
  },
};

describe("evals v2 end to end (fake agent, fake judge, real store)", () => {
  let store: EvalsStore;

  beforeAll(async () => {
    const client = createClient({ url: ":memory:" });
    await migrateEvalsV2(client);
    await migrateEvalsV2(client); // idempotent
    store = createEvalsStore(client);
    await store.saveDataset(dataset);
    await store.setInputs(dataset.id, inputs);
  });

  it("round-trips inputs, including follow-ups and facts", async () => {
    const back = await store.listInputs(dataset.id);
    expect(back.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    expect(back[1]!.followUps).toEqual(["and tell me why"]);
    expect(back[0]!.facts?.mustNot).toEqual(["delete anything"]);
  });

  it("refuses duplicate input ids — a duplicate silently merges two rows across runs", async () => {
    await expect(store.setInputs("dsX", [inputs[0]!, inputs[0]!])).rejects.toThrow(/duplicate/);
  });

  it("appends rubric versions rather than overwriting", async () => {
    const a = await store.saveRubric({ owner, id: "rv", agentName: "x", defaultJudge: "jev-latest", checks: [] });
    const b = await store.saveRubric({ owner, id: "rv", agentName: "x", defaultJudge: "jev-latest", checks: rubric.checks });
    expect([a.version, b.version]).toEqual([1, 2]);
    expect((await store.getRubric(owner, "rv"))!.checks).toHaveLength(3);
    expect((await store.getRubric(owner, "rv", 1))!.checks).toHaveLength(0);
  });

  it("runs, judges, stores and compares two versions paired on the same inputs", async () => {
    const threads = await runDataset({
      owner,
      dataset,
      inputs,
      versions: [
        { label: "live", ref: "linear-bot", fingerprint: "A" },
        { label: "@good", ref: "linear-bot@good", fingerprint: "B" },
      ],
      deps: { runAgent: fakeAgent },
      concurrency: 1,
    });
    expect(threads).toHaveLength(6);
    expect(threads.every((t) => !t.error)).toBe(true);
    for (const t of threads) await store.saveThread(t);

    // Follow-ups land in the same thread.
    const withFollowUp = threads.find((t) => t.inputId === "i2" && t.version === "live")!;
    expect((histories.get(withFollowUp.threadId) ?? []).filter((m) => (m as { role: string }).role === "user")).toHaveLength(2);

    const verdicts = await judgeThreads({
      rubric,
      threads,
      inputsById: new Map(inputs.map((i) => [i.id, i])),
      deps: { loadHistory: (id) => Promise.resolve(histories.get(id) ?? []), judgeFor: () => judge },
    });
    await store.saveVerdicts(verdicts);

    // Counted checks ran locally, asked went to the judge — one call per thread.
    expect(seen).toHaveLength(6);
    // The judge saw the tool log and the input's forbidden outcome.
    expect(seen.some((s) => s.THREAD?.includes("linear_update_issue"))).toBe(true);
    expect(seen.some((s) => s.MUST_NOT?.includes("delete anything"))).toBe(true);

    const [live, good] = summarize(threads, verdicts, rubric);
    expect(live!.checks.find((c) => c.checkId === "looked")).toMatchObject({ passed: 0, total: 3 });
    expect(good!.checks.find((c) => c.checkId === "looked")).toMatchObject({ passed: 3, total: 3 });

    const [looked] = compareVersions(threads, verdicts, ["looked"], "live", "@good");
    expect(looked).toMatchObject({ pairs: 3, improved: 3, regressed: 0 });

    const stored = await store.listVerdicts({ threadIds: threads.map((t) => t.threadId), rubricVersion: 1 });
    expect(stored).toHaveLength(verdicts.length);
  });

  it("repeats: each input becomes a rate, and pass^k asks whether it passes every time", async () => {
    // A flaky agent: `@flaky` looks first on attempts 0 and 1, not on 2.
    let calls = 0;
    const flaky = (o: { agent: string; prompt: string; threadId?: string }) =>
      fakeAgent({ ...o, agent: o.agent.endsWith("@flaky") && calls++ % 3 !== 2 ? `${o.agent}@good` : o.agent });
    const threads = await runDataset({
      owner,
      dataset,
      inputs: [inputs[0]!, inputs[2]!],
      versions: [
        { label: "live", ref: "linear-bot", fingerprint: "A" },
        { label: "@flaky", ref: "linear-bot@flaky", fingerprint: "C" },
      ],
      repeats: 3,
      runId: "run_rep",
      deps: { runAgent: flaky },
      concurrency: 1,
    });
    expect(threads).toHaveLength(12);
    expect(new Set(threads.map((t) => t.runId))).toEqual(new Set(["run_rep"]));
    expect(threads.filter((t) => t.inputId === "i1" && t.version === "live").map((t) => t.attempt).sort()).toEqual([0, 1, 2]);
    for (const t of threads) await store.saveThread(t);
    expect(await store.latestRunId(owner, dataset.id)).toBe("run_rep");
    expect(await store.listThreads(owner, { runId: "run_rep" })).toHaveLength(12);

    const looked = rubric.checks.filter((c) => c.id === "looked");
    const verdicts = await judgeThreads({
      rubric: { ...rubric, checks: looked },
      threads,
      inputsById: new Map(inputs.map((i) => [i.id, i])),
      deps: { loadHistory: (id) => Promise.resolve(histories.get(id) ?? []), judgeFor: () => judge },
    });
    const [, fl] = summarize(threads, verdicts, { ...rubric, checks: looked });
    // 4 of 6 attempts looked first, but no input did it every time.
    expect(fl!.checks[0]).toMatchObject({ passed: 4, total: 6, allPassed: 0, inputs: 2 });

    const [cmp] = compareVersions(threads, verdicts, ["looked"], "live", "@flaky");
    expect(cmp).toMatchObject({ pairs: 2, improved: 2, regressed: 0, rateA: 0 });
    expect(cmp!.rateB).toBeCloseTo(2 / 3);
  });

  it("an empty answer is an error, not a verdict", async () => {
    const threads = await runDataset({
      owner,
      dataset,
      inputs: [inputs[0]!],
      versions: [{ label: "@broken", ref: "linear-bot@broken", fingerprint: "C" }],
      deps: { runAgent: fakeAgent },
    });
    expect(threads[0]!.error).toMatch(/no answer/);
    const verdicts = await judgeThreads({
      rubric,
      threads,
      deps: { loadHistory: (id) => Promise.resolve(histories.get(id) ?? []), judgeFor: () => judge },
    });
    expect(verdicts).toEqual([]);
  });

  it("re-judging appends; the store reads the latest per check", async () => {
    const t = (await store.listThreads(owner, { datasetId: dataset.id }))[0]!;
    await store.saveVerdicts([
      { threadId: t.threadId, checkId: "did-it", rubricVersion: 1, judgeId: "j", answer: "false", failed: true, createdAt: Date.now() + 1000 },
    ]);
    const latest = (await store.listVerdicts({ threadIds: [t.threadId], rubricVersion: 1 })).find((v) => v.checkId === "did-it");
    expect(latest!.answer).toBe("false");
  });

  it("keeps a person's ruling beside the verdict", async () => {
    await store.saveRuling({ threadId: "t1", checkId: "did-it", failed: false, by: "me", createdAt: 1 });
    await store.saveRuling({ threadId: "t1", checkId: "did-it", failed: true, by: "me", createdAt: 2 });
    const rs = await store.listRulings({ threadIds: ["t1"] });
    expect(rs).toEqual([{ threadId: "t1", checkId: "did-it", failed: true, by: "me", createdAt: 2 }]);
  });
});

describe("statistics", () => {
  it("McNemar: 12 to 1 is real, 1 to 0 is not", () => {
    expect(mcnemar(12, 1)).toBeCloseTo(0.0034, 3);
    expect(mcnemar(1, 0)).toBe(1);
    expect(mcnemar(0, 0)).toBe(1);
  });

  it("consistency counts agreement per check across passes", () => {
    const v = (threadId: string, answer: string) => ({
      threadId,
      checkId: "c",
      rubricVersion: 1,
      judgeId: "j",
      answer,
      failed: false,
      createdAt: 0,
    });
    const [c] = consistency([
      [v("a", "x"), v("b", "x")],
      [v("a", "x"), v("b", "y")],
    ]);
    expect(c).toMatchObject({ checkId: "c", items: 2, unanimous: 1, agreement: 0.5 });
  });
});
