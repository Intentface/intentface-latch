import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { extractToolCalls, runEvalCases } from "./run";
import type { EvalCase } from "./store";
import type { Principal } from "@/lib/session";

const principal = { orgId: "org", userId: "user" } as Principal;

const cases: EvalCase[] = [
  { id: "a", name: "greets", input: "hello", expected: { assertions: { contains: ["hi"] } } },
  { id: "b", name: "uses tool", input: "save it", expected: { toolCalls: [{ tool: "save_lead" }] } },
];

/** Runtime stub: answers per prompt; transcript has one tool call for "save it". */
const fakeRuntime = {
  async runAgent({ prompt }: { prompt: string }) {
    return { threadId: `sub_${prompt}`, answer: prompt === "hello" ? "hi there" : "done" };
  },
  async loadHistory({ chatId }: { chatId: string }) {
    if (chatId !== "sub_save it") return [];
    return [
      {
        parts: [
          { type: "tool-save_lead", input: { source: "web" }, output: {} },
          { type: "text", text: "done" },
        ],
      },
    ] as never[];
  },
};

describe("runEvalCases", () => {
  it("runs, grades, and keeps input order", async () => {
    const results = await runEvalCases({
      runtime: fakeRuntime,
      principal,
      agent: "x",
      cases,
    });
    expect(results.map((r) => r.caseId)).toEqual(["a", "b"]);
    expect(results[0].pass).toBe(true);
    expect(results[1].pass).toBe(true);
    expect(results[1].toolCalls).toEqual([{ tool: "save_lead", args: { source: "web" }, blocked: undefined }]);
  });

  it("reports each graded case through onResult with a running count", async () => {
    const ticks: { caseId: string; completed: number; total: number }[] = [];
    await runEvalCases({
      runtime: fakeRuntime,
      principal,
      agent: "x",
      cases,
      onResult: (r, completed, total) => ticks.push({ caseId: r.caseId, completed, total }),
    });
    expect(ticks).toHaveLength(2);
    expect(ticks.map((t) => t.completed)).toEqual([1, 2]);
    expect(ticks.every((t) => t.total === 2)).toBe(true);
    expect(new Set(ticks.map((t) => t.caseId))).toEqual(new Set(["a", "b"]));
  });

  it("repeats a flaky case, passes on majority, and records the pass rate", async () => {
    // Fails on the 1st attempt, passes on the 2nd and 3rd.
    let attempts = 0;
    const flaky = {
      async runAgent() {
        attempts += 1;
        return { threadId: `sub_${attempts}`, answer: attempts === 1 ? "nope" : "hi there" };
      },
      async loadHistory() {
        return [];
      },
    };
    const results = await runEvalCases({
      runtime: flaky,
      principal,
      agent: "x",
      cases: [{ ...cases[0], repeats: 3 }],
      concurrency: 1,
    });
    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.repeats).toBe(3);
    expect(r.passes).toBe(2);
    expect(r.attempts).toHaveLength(3);
    // The representative transcript is the FIRST FAILING attempt (worth diagnosing).
    expect(r.threadId).toBe("sub_1");
    expect(r.reasons).toEqual([]);
  });

  it("represents a repeated case by a failing attempt WITH a transcript, skipping errored ones", async () => {
    // Attempt 1 crashes (no threadId), attempts 2-3 run: 2 fails the grade, 3 passes.
    let attempts = 0;
    const crashyThenFlaky = {
      async runAgent() {
        attempts += 1;
        if (attempts === 1) throw new Error("provider down");
        return { threadId: `sub_${attempts}`, answer: attempts === 2 ? "nope" : "hi there" };
      },
      async loadHistory() {
        return [];
      },
    };
    const results = await runEvalCases({
      runtime: crashyThenFlaky,
      principal,
      agent: "x",
      cases: [{ ...cases[0], repeats: 3 }],
      concurrency: 1,
    });
    // The representative transcript is attempt 2 (failing WITH a transcript),
    // not the errored attempt 1 that has none.
    expect(results[0].threadId).toBe("sub_2");
    expect(results[0].passes).toBe(1);
  });

  it("fails a repeated case below majority with an aggregate reason", async () => {
    let attempts = 0;
    const mostlyBroken = {
      async runAgent() {
        attempts += 1;
        return { threadId: `sub_${attempts}`, answer: attempts === 2 ? "hi there" : "nope" };
      },
      async loadHistory() {
        return [];
      },
    };
    const results = await runEvalCases({
      runtime: mostlyBroken,
      principal,
      agent: "x",
      cases: [{ ...cases[0], repeats: 3 }],
      concurrency: 1,
    });
    expect(results[0].pass).toBe(false);
    expect(results[0].passes).toBe(1);
    expect(results[0].reasons[0]).toBe("passed 1/3 repeats (need 2)");
    expect(results[0].reasons[1]).toContain('missing "hi"');
  });

  it("ticks onAttempt per attempt and onResult once per case", async () => {
    const attemptTicks: [number, number][] = [];
    const resultTicks: string[] = [];
    await runEvalCases({
      runtime: fakeRuntime,
      principal,
      agent: "x",
      cases: [{ ...cases[0], repeats: 3 }, cases[1]],
      onAttempt: (completed, total) => attemptTicks.push([completed, total]),
      onResult: (r) => resultTicks.push(r.caseId),
    });
    expect(attemptTicks.map(([c]) => c)).toEqual([1, 2, 3, 4]);
    expect(attemptTicks.every(([, t]) => t === 4)).toBe(true);
    expect(resultTicks.sort()).toEqual(["a", "b"]);
  });

  it("fails the case on a rubric verdict but not on a judge infra error", async () => {
    const judgeText = (text: string) =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text" as const, text }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }),
      });
    const rubricCase: EvalCase = {
      id: "r",
      name: "explains why",
      input: "hello",
      expected: { assertions: { contains: ["hi"] }, rubric: ["explains the why"] },
    };

    // Deterministic checks pass, judge says the criterion fails → case FAILS.
    const failed = await runEvalCases({
      runtime: fakeRuntime,
      principal,
      agent: "x",
      cases: [rubricCase],
      judgeModel: judgeText('{"pass": false, "reason": "no why given"}'),
    });
    expect(failed[0].pass).toBe(false);
    expect(failed[0].reasons[0]).toBe('rubric "explains the why": no why given');
    expect(failed[0].rubric?.[0].pass).toBe(false);

    // Judge infra failure (malformed after retry) → verdict carries error, case PASSES.
    const infra = await runEvalCases({
      runtime: fakeRuntime,
      principal,
      agent: "x",
      cases: [rubricCase],
      judgeModel: judgeText("not json"),
    });
    expect(infra[0].pass).toBe(true);
    expect(infra[0].reasons).toEqual([]);
    expect(infra[0].rubric?.[0].error).toContain("judge call failed");

    // No judge model wired → rubric silently ungraded is NOT a thing at this
    // layer either: run_evals always resolves one; here rubric just stays unset.
    const without = await runEvalCases({ runtime: fakeRuntime, principal, agent: "x", cases: [rubricCase] });
    expect(without[0].rubric).toBeUndefined();
  });

  it("captures a crashed run as a failed result instead of throwing", async () => {
    const boom = {
      async runAgent() {
        throw new Error("model unavailable");
      },
      async loadHistory() {
        return [];
      },
    };
    const results = await runEvalCases({
      runtime: boom,
      principal,
      agent: "x",
      cases: cases.slice(0, 1),
    });
    expect(results[0].pass).toBe(false);
    expect(results[0].error).toContain("model unavailable");
  });
});

describe("extractToolCalls", () => {
  it("reads static, dynamic, and blocked tool parts", () => {
    const history = [
      {
        parts: [
          { type: "tool-alpha", input: { a: 1 } },
          { type: "dynamic-tool", toolName: "beta", input: {} },
          { type: "tool-gated", input: {}, output: { __blocked: true } },
          { type: "reasoning", text: "…" },
        ],
      },
    ];
    const calls = extractToolCalls(history);
    expect(calls.map((c) => c.tool)).toEqual(["alpha", "beta", "gated"]);
    expect(calls[2].blocked).toBe(true);
  });
});
