import { describe, expect, it, vi } from "vitest";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { askOfTrace, type Question } from "./ask";

/**
 * A stand-in evaluation model. The point of the provider contract is that
 * these tests never touch a network or a vendor: Haiku, Jev and this fake are
 * the same interface, so everything asserted here holds for all three.
 *
 * `answersPerCall` lets a test give DIFFERENT answers to successive slices,
 * which is the only way to exercise aggregation.
 */
function fakeJudge(
  answersPerCall: Record<string, unknown>[],
  onCall?: (opts: { state: unknown; questions: Record<string, unknown> }) => void,
): Experimental_EvaluationModelV4 {
  let call = 0;
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "fake-judge",
    supportedQuestionTypes: ["boolean", "choice", "score"],
    doEvaluate: async (opts) => {
      onCall?.(opts as never);
      const answers = answersPerCall[Math.min(call++, answersPerCall.length - 1)]!;
      return {
        answers: answers as never,
        warnings: [],
        usage: { inputTokens: 100, outputTokens: 1 },
      };
    },
  };
}

const msg = (role: string, parts: unknown[]) => ({ role, parts });
const user = (text: string) => msg("user", [{ type: "text", text }]);
const read = (path: string, text: string) => ({
  type: "tool-read_file",
  toolCallId: `t_${path}`,
  input: { path },
  output: { text },
});

const trace = [
  user("What's our peering limit?"),
  msg("assistant", [
    read("docs/networking/vpc-limits.md", "Max 125 peering connections per VPC."),
    { type: "text", text: "You can have up to 125 peering connections." },
  ]),
];

/** Long enough to force windowing at a small budget. */
const longTrace = [
  user("audit every networking doc"),
  msg("assistant", [
    ...Array.from({ length: 20 }, (_, i) => read(`docs/net/${i}.md`, "y".repeat(800))),
    { type: "text", text: "Done." },
  ]),
];
const FORCE_SLICING = { budgetChars: 3_000, windowEvents: 6, strideEvents: 6 };

const grounded: Question = { ask: "Is every claim supported by a document the agent opened?" };

describe("askOfTrace", () => {
  it("asks every question in ONE call — the property the cost model depends on", async () => {
    const calls: { questions: Record<string, unknown> }[] = [];
    const model = fakeJudge(
      [
        {
          grounded: { type: "boolean", probability: 0.95 },
          read_doc: { type: "boolean", probability: 0.99 },
          asked: { type: "boolean", probability: 0.02 },
        },
      ],
      (o) => calls.push(o as never),
    );
    const doEvaluate = vi.spyOn(model, "doEvaluate");

    const { usage } = await askOfTrace({
      model,
      messages: trace,
      questions: {
        grounded,
        read_doc: { ask: "Did it open a document covering the question?" },
        asked: { ask: "Did it ask which region before answering?" },
      },
    });

    expect(doEvaluate).toHaveBeenCalledTimes(1);
    expect(Object.keys(calls[0]!.questions)).toEqual(["grounded", "read_doc", "asked"]);
    expect(usage.calls).toBe(1);
  });

  it("reads a low probability as a confident NO, not as low confidence", async () => {
    // The trap in the raw API: `probability` is P(true). A firm "definitely
    // not" arrives as 0.02, which displayed naively reads as "2% sure" when
    // the judge is in fact 98% sure of the opposite.
    const model = fakeJudge([{ asked: { type: "boolean", probability: 0.02 } }]);
    const { verdicts } = await askOfTrace({
      model,
      messages: trace,
      questions: { asked: { ask: "Did it ask which region before answering?" } },
    });
    expect(verdicts[0]).toMatchObject({
      id: "asked",
      answer: "false",
      confidence: 0.98,
      failed: true,
      slices: 1,
    });
  });

  it("honours a question phrased so that YES is the failure", async () => {
    const model = fakeJudge([{ invented: { type: "boolean", probability: 0.9 } }]);
    const { verdicts } = await askOfTrace({
      model,
      messages: trace,
      questions: {
        invented: { ask: "Did it state a number absent from every document it opened?", bad: "true" },
      },
    });
    expect(verdicts[0]!.answer).toBe("true");
    expect(verdicts[0]!.failed).toBe(true);
  });

  it("lets the threshold rise for a question that gates a release", async () => {
    const model = fakeJudge([{ grounded: { type: "boolean", probability: 0.6 } }]);
    const ask = (threshold: number) =>
      askOfTrace({ model, messages: trace, questions: { grounded }, threshold });

    expect((await ask(0.5)).verdicts[0]!.failed).toBe(false); // 0.6 ≥ 0.5 → passes
    expect((await ask(0.8)).verdicts[0]!.failed).toBe(true); // not sure enough to pass
  });

  it("supports a choice, for when 'no' hides two different behaviours", async () => {
    // "Didn't ask" is not one failure: guessing and refusing are different
    // bugs with different fixes, and a boolean folds them together.
    const model = fakeJudge([
      {
        ambiguity: {
          type: "choice",
          choice: "guessed",
          probabilities: { asked: 0.1, guessed: 0.85, refused: 0.05 },
        },
      },
    ]);
    const { verdicts } = await askOfTrace({
      model,
      messages: trace,
      questions: {
        ambiguity: {
          type: "choice",
          ask: "The question was ambiguous about region. What did the agent do?",
          options: {
            asked: "Asked the user which region",
            guessed: "Answered for one region without saying which",
            refused: "Declined to answer at all",
          },
          bad: ["guessed", "refused"],
        },
      },
    });
    expect(verdicts[0]).toMatchObject({ answer: "guessed", confidence: 0.85, failed: true });
  });

  it("does not call the judge when there is nothing to judge", async () => {
    const model = fakeJudge([{}]);
    const doEvaluate = vi.spyOn(model, "doEvaluate");
    expect((await askOfTrace({ model, messages: [], questions: { grounded } })).verdicts).toEqual([]);
    expect((await askOfTrace({ model, messages: trace, questions: {} })).verdicts).toEqual([]);
    expect(doEvaluate).not.toHaveBeenCalled();
  });
});

describe("aggregating a sliced run", () => {
  const OPENED: Question = { ask: "Did the agent open a document?", agg: "every" };
  const GROUNDED_ANY: Question = { ask: "Is every claim supported?", agg: "any" };

  it("calls the judge once per slice, and says so", async () => {
    const model = fakeJudge([{ g: { type: "boolean", probability: 0.9 } }]);
    const { usage, verdicts } = await askOfTrace({
      model,
      messages: longTrace,
      questions: { g: grounded },
      slicing: FORCE_SLICING,
    });
    expect(usage.calls).toBeGreaterThan(1);
    expect(verdicts[0]!.slices).toBe(usage.calls);
    expect(usage.inputTokens).toBe(100 * usage.calls);
  });

  it('"any" fails the run when a single slice fails', async () => {
    const model = fakeJudge([
      { g: { type: "boolean", probability: 0.99 } }, // slice 0 fine
      { g: { type: "boolean", probability: 0.01 } }, // slice 1 bad
      { g: { type: "boolean", probability: 0.99 } },
    ]);
    const { verdicts } = await askOfTrace({
      model,
      messages: longTrace,
      questions: { g: GROUNDED_ANY },
      slicing: FORCE_SLICING,
      concurrency: 1, // deterministic slice order for the scripted answers
    });
    expect(verdicts[0]!.failed).toBe(true);
    expect(verdicts[0]!.failedSlices).toContain(1);
    // The reported answer comes from the slice that DECIDED it, not slice 0.
    expect(verdicts[0]!.answer).toBe("false");
  });

  it('"every" does NOT fail an existence question just because most windows lack the evidence', async () => {
    // THE slicing trap. "Did it open a document?" is true of the run but false
    // of nearly every individual window. Under "any" this run would be marked
    // broken by the slicing rather than by the agent.
    const model = fakeJudge([
      { o: { type: "boolean", probability: 0.99 } }, // the window that saw it
      { o: { type: "boolean", probability: 0.01 } },
      { o: { type: "boolean", probability: 0.01 } },
    ]);
    const { verdicts } = await askOfTrace({
      model,
      messages: longTrace,
      questions: { o: OPENED },
      slicing: FORCE_SLICING,
      concurrency: 1,
    });
    expect(verdicts[0]!.failed).toBe(false);
    expect(verdicts[0]!.failedSlices.length).toBeGreaterThan(0); // some slices did say no
  });

  it('"every" still fails when no slice saw it at all', async () => {
    const model = fakeJudge([{ o: { type: "boolean", probability: 0.01 } }]);
    const { verdicts } = await askOfTrace({
      model,
      messages: longTrace,
      questions: { o: OPENED },
      slicing: FORCE_SLICING,
      concurrency: 1,
    });
    expect(verdicts[0]!.failed).toBe(true);
  });

  it("keeps every per-slice answer, so a surprising verdict can be traced back", async () => {
    const model = fakeJudge([{ g: { type: "boolean", probability: 0.9 } }]);
    const { perSlice, verdicts } = await askOfTrace({
      model,
      messages: longTrace,
      questions: { g: grounded },
      slicing: FORCE_SLICING,
    });
    expect(perSlice).toHaveLength(verdicts[0]!.slices);
    expect(new Set(perSlice.map((v) => v.slice)).size).toBe(verdicts[0]!.slices);
  });
});
