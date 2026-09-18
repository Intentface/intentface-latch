import { describe, expect, it, vi } from "vitest";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { askOfTrace, renderTrace, type Question } from "./ask";

/**
 * A stand-in evaluation model. The point of the provider contract is that
 * these tests never touch a network or a vendor: Haiku, Jev and this fake are
 * the same interface, so everything asserted here holds for all three.
 */
function fakeJudge(
  answers: Record<string, unknown>,
  onCall?: (opts: { state: unknown; questions: Record<string, unknown> }) => void,
): Experimental_EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "fake-judge",
    supportedQuestionTypes: ["boolean", "choice", "score"],
    doEvaluate: async (opts) => {
      onCall?.(opts as never);
      return {
        answers: answers as never,
        warnings: [],
        usage: { inputTokens: 100, outputTokens: 1 },
      };
    },
  };
}

const msg = (role: string, parts: unknown[]) => ({ role, parts });

/** A question about VPC limits, the agent reading a doc, then answering. */
const trace = [
  msg("user", [{ type: "text", text: "What's our peering limit?" }]),
  msg("assistant", [
    {
      type: "tool-read_file",
      toolCallId: "t1",
      input: { path: "docs/networking/vpc-limits.md" },
      output: { text: "Max 125 peering connections per VPC in us-east-1." },
    },
    { type: "text", text: "You can have up to 125 peering connections." },
  ]),
];

describe("renderTrace", () => {
  it("puts what the agent DID before what it said about it", () => {
    // A judge shown the narration first grades the narration. Tool calls are
    // evidence; assistant text is a claim about the evidence.
    const rendered = renderTrace(trace) as { conversation: Record<string, unknown>[] };
    const assistant = rendered.conversation[1]!;
    expect(Object.keys(assistant)).toEqual(["role", "tools", "said"]);
    expect(assistant.tools).toEqual([
      {
        name: "read_file",
        args: JSON.stringify({ path: "docs/networking/vpc-limits.md" }),
        result: JSON.stringify({ text: "Max 125 peering connections per VPC in us-east-1." }),
      },
    ]);
  });

  it("caps a huge tool result instead of trusting the trace to be small", () => {
    const huge = [msg("assistant", [
      { type: "tool-search", toolCallId: "t1", input: {}, output: "x".repeat(50_000) },
    ])];
    const out = JSON.stringify(renderTrace(huge));
    // Marked, not silently cut: a judge must be able to tell a short result
    // from a long one it was only shown the start of.
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThan(3_000);
  });

  it("marks a blocked call, so 'it tried' is distinguishable from 'it did'", () => {
    const blocked = [msg("assistant", [
      { type: "tool-delete_stack", toolCallId: "t1", input: {}, output: { __blocked: true } },
    ])];
    const r = renderTrace(blocked) as { conversation: Record<string, unknown>[] };
    expect((r.conversation[0]!.tools as Record<string, unknown>[])[0]!.blocked).toBe(true);
  });
});

describe("askOfTrace", () => {
  const grounded: Question = { ask: "Is every claim supported by a document the agent opened?" };

  it("asks every question in ONE call — the property the cost model depends on", async () => {
    const calls: { questions: Record<string, unknown> }[] = [];
    const model = fakeJudge(
      {
        grounded: { type: "boolean", probability: 0.95 },
        read_doc: { type: "boolean", probability: 0.99 },
        asked: { type: "boolean", probability: 0.02 },
      },
      (o) => calls.push(o as never),
    );
    const doEvaluate = vi.spyOn(model, "doEvaluate");

    await askOfTrace({
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
  });

  it("reads a low probability as a confident NO, not as low confidence", async () => {
    // The trap in the raw API: `probability` is P(true). A firm "definitely
    // not" arrives as 0.02, which naively displayed reads as "2% sure" when
    // the judge is in fact 98% sure of the opposite.
    const model = fakeJudge({ asked: { type: "boolean", probability: 0.02 } });
    const { verdicts } = await askOfTrace({
      model,
      messages: trace,
      questions: { asked: { ask: "Did it ask which region before answering?" } },
    });
    expect(verdicts[0]).toEqual({
      id: "asked",
      answer: "false",
      confidence: 0.98,
      failed: true,
    });
  });

  it("honours a question phrased so that YES is the failure", async () => {
    const model = fakeJudge({ invented: { type: "boolean", probability: 0.9 } });
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
    const model = fakeJudge({ grounded: { type: "boolean", probability: 0.6 } });
    const ask = (threshold: number) =>
      askOfTrace({ model, messages: trace, questions: { grounded }, threshold });

    expect((await ask(0.5)).verdicts[0]!.failed).toBe(false); // 0.6 ≥ 0.5 → passes
    expect((await ask(0.8)).verdicts[0]!.failed).toBe(true); // not sure enough to pass
  });

  it("supports a choice, for when 'no' hides two different behaviours", async () => {
    // "Didn't ask" is not one failure: guessing and refusing are different
    // bugs with different fixes, and a boolean folds them together.
    const model = fakeJudge({
      ambiguity: { type: "choice", choice: "guessed", probabilities: { asked: 0.1, guessed: 0.85, refused: 0.05 } },
    });
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
    expect(verdicts[0]).toEqual({
      id: "ambiguity",
      answer: "guessed",
      confidence: 0.85,
      failed: true,
    });
  });

  it("does not call the judge when there is nothing to judge", async () => {
    const model = fakeJudge({});
    const doEvaluate = vi.spyOn(model, "doEvaluate");
    expect((await askOfTrace({ model, messages: [], questions: { grounded } })).verdicts).toEqual([]);
    expect((await askOfTrace({ model, messages: trace, questions: {} })).verdicts).toEqual([]);
    expect(doEvaluate).not.toHaveBeenCalled();
  });

  it("reports usage, so a dense pass can be costed before it is run", async () => {
    const model = fakeJudge({ grounded: { type: "boolean", probability: 0.9 } });
    const { usage } = await askOfTrace({ model, messages: trace, questions: { grounded } });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 1 });
  });
});
