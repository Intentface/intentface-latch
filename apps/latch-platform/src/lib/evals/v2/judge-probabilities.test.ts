import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import { judgeAsked } from "./judge";

const jev: EvaluationModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "jev-test",
  supportedQuestionTypes: ["boolean", "choice", "score"],
  async doEvaluate() {
    return {
      answers: {
        tone: { type: "choice", choice: "warm", probabilities: { warm: 0.7, cold: 0.3 } },
        size: { type: "score", score: 1.4, probabilities: { "0": 0, "1": 0.6, "2": 0.4 } },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      warnings: [],
      providerMetadata: { typesafe: { confidence: { tone: 0.42, size: 0.35 } } },
    };
  },
};

describe("what a judge's answer keeps", () => {
  it("keeps every label's probability and the judge's own confidence, not the top label's probability", async () => {
    const [tone, size] = await judgeAsked({
      checks: [
        { kind: "asked", id: "tone", label: "Tone", ask: "Tone?", shape: { type: "choice", options: { warm: "Warm", cold: "Cold" }, bad: ["cold"] } },
        { kind: "asked", id: "size", label: "Size", ask: "Size?", shape: { type: "score", levels: [{ name: "short", means: "" }, { name: "right", means: "" }, { name: "long", means: "" }] } },
      ],
      state: { THREAD: "…" },
      defaultJudge: "jev-test",
      judgeFor: () => jev,
    });
    expect(tone).toMatchObject({ answer: "warm", confidence: 0.42, probabilities: { warm: 0.7, cold: 0.3 }, failed: false });
    expect(size).toMatchObject({ answer: "right", score: 1.4, confidence: 0.35, probabilities: { "1": 0.6 } });
  });
});
