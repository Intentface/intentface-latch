import { describe, expect, it } from "vitest";
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
