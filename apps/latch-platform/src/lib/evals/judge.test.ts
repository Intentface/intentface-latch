import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { judgeRubric } from "./judge";

/** Mock judge: returns each text in sequence (repeating the last), capturing prompts. */
function mockJudge(texts: string[]) {
  const prompts: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      signals.push(options.abortSignal);
      const text = texts[Math.min(call, texts.length - 1)];
      call += 1;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts, signals, calls: () => call };
}

describe("judgeRubric", () => {
  it("grades each criterion with its own call and returns per-criterion verdicts", async () => {
    const { model, prompts } = mockJudge(['{"pass": true, "reason": "it does"}']);
    const verdicts = await judgeRubric({
      model,
      input: "plan my week",
      answer: "Here is why: high training load means rest.",
      toolCalls: [{ tool: "orient" }, { tool: "send_email", blocked: true }],
      criteria: ["explains the why", "stays encouraging"],
    });
    expect(verdicts).toEqual([
      { criterion: "explains the why", pass: true, reason: "it does" },
      { criterion: "stays encouraging", pass: true, reason: "it does" },
    ]);
    expect(prompts).toHaveLength(2);
    // Each call carries the criterion, the case input, the answer, and tool NAMES.
    expect(prompts[0]).toContain("explains the why");
    expect(prompts[0]).toContain("plan my week");
    expect(prompts[0]).toContain("high training load");
    expect(prompts[0]).toContain("orient, send_email (blocked)");
  });

  it("a failing verdict carries the judge's reason", async () => {
    const { model } = mockJudge(['{"pass": false, "reason": "never says why"}']);
    const [v] = await judgeRubric({
      model,
      input: "q",
      answer: "a",
      toolCalls: [],
      criteria: ["explains the why"],
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("never says why");
    expect(v.error).toBeUndefined();
  });

  it("bounds every judge call with an abort signal (stalled provider can't hang the run)", async () => {
    const { model, signals } = mockJudge(['{"pass": true, "reason": "ok"}']);
    await judgeRubric({ model, input: "q", answer: "a", toolCalls: [], criteria: ["c"] });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("retries once on a malformed verdict, then succeeds", async () => {
    const { model, calls } = mockJudge(["not json at all", '{"pass": true, "reason": "ok"}']);
    const [v] = await judgeRubric({ model, input: "q", answer: "a", toolCalls: [], criteria: ["c"] });
    expect(calls()).toBe(2);
    expect(v).toEqual({ criterion: "c", pass: true, reason: "ok" });
  });

  it("marks an error verdict after the retry also fails (never a silent fail)", async () => {
    const { model, calls } = mockJudge(["still not json"]);
    const [v] = await judgeRubric({ model, input: "q", answer: "a", toolCalls: [], criteria: ["c"] });
    expect(calls()).toBe(2);
    expect(v.error).toContain("judge call failed");
    expect(v.pass).toBe(false);
  });
});
