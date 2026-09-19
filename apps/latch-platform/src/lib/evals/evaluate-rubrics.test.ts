import { describe, expect, it, vi } from "vitest";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { scoreRubrics, normalizeScale, type JudgeEvidence } from "./evaluate-rubrics";

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
      return { answers: answers as never, warnings: [], usage: { inputTokens: 80, outputTokens: 2 } };
    },
  };
}

function throwingJudge(message: string): Experimental_EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "fake-judge",
    supportedQuestionTypes: ["boolean", "score"],
    doEvaluate: async () => {
      throw new Error(message);
    },
  };
}

/** A text model that returns a fixed structured-output payload. */
const explainerReturning = (explanations: { name: string; reason: string }[]) =>
  new MockLanguageModelV4({
    modelId: "explainer",
    doGenerate: (async () => ({
      content: [{ type: "text", text: JSON.stringify({ explanations }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
      warnings: [],
    })) as never,
  }) as never;

const evidence: JudgeEvidence = {
  input: "Give me the top HN posts",
  answer: "1. [Something](https://example.com) ⬆️ 120 💬 44",
  tools: "fetch_top_hn_posts({})",
};

const RUBRICS = [
  { name: "uses-hn-tool", prompt: "Called fetch_top_hn_posts before answering.", scale: "binary" },
  { name: "follows-digest-format", prompt: "Numbered 1-5 with links and counts.", scale: "binary" },
];

describe("normalizeScale", () => {
  it("treats the stored spelling and the SDK spelling as the same thing", () => {
    // Rubrics saved before the rename say "binary". A migration for a synonym
    // would be churn; normalizing on read costs nothing and cannot break.
    expect(normalizeScale("binary")).toBe("boolean");
    expect(normalizeScale("boolean")).toBe("boolean");
    expect(normalizeScale("score")).toBe("score");
    expect(normalizeScale(undefined)).toBe("boolean");
  });
});

describe("evaluateRubrics", () => {
  it("judges every rubric in ONE call — the point of the change", async () => {
    const calls: { questions: Record<string, unknown>; state: unknown }[] = [];
    const model = fakeJudge(
      {
        "uses-hn-tool": { type: "boolean", probability: 0.97 },
        "follows-digest-format": { type: "boolean", probability: 0.88 },
      },
      (o) => calls.push(o as never),
    );
    const doEvaluate = vi.spyOn(model, "doEvaluate");

    const out = await scoreRubrics({ model, rubrics: RUBRICS, evidence });

    expect(doEvaluate).toHaveBeenCalledTimes(1); // was one call PER rubric
    expect(Object.keys(calls[0]!.questions)).toEqual(["uses-hn-tool", "follows-digest-format"]);
    expect(out.map((o) => o.value)).toEqual([1, 1]);
  });

  it("keeps the probability, not just the pass/fail it collapses to", async () => {
    // A verdict at 0.51 and one at 0.99 are not the same evidence. Throwing
    // that away is what makes it impossible to tell a good question from a
    // coin flip later.
    const model = fakeJudge({ "uses-hn-tool": { type: "boolean", probability: 0.51 } });
    const [out] = await scoreRubrics({ model, rubrics: [RUBRICS[0]!], evidence });
    expect(out!.value).toBe(1);
    expect(out!.probability).toBe(0.51);
  });

  it("puts the evidence in the state with tools before the answer", async () => {
    const calls: { state: Record<string, string> }[] = [];
    const model = fakeJudge({ "uses-hn-tool": { type: "boolean", probability: 0.9 } }, (o) =>
      calls.push(o as never),
    );
    await scoreRubrics({ model, rubrics: [RUBRICS[0]!], evidence });
    expect(Object.keys(calls[0]!.state)).toEqual([
      "user_message",
      "tools_the_agent_called",
      "agent_answer",
    ]);
  });

  it("includes prior conversation only when the rubric scope asked for it", async () => {
    const calls: { state: Record<string, string> }[] = [];
    const model = fakeJudge({ "uses-hn-tool": { type: "boolean", probability: 0.9 } }, (o) =>
      calls.push(o as never),
    );
    await scoreRubrics({
      model,
      rubrics: [RUBRICS[0]!],
      evidence: { ...evidence, conversation: "user: hi\nassistant: hello" },
    });
    expect(Object.keys(calls[0]!.state)[0]).toBe("conversation_so_far");
  });

  it("maps a graded rubric onto the 0-1 range the column already stores", async () => {
    const model = fakeJudge({ depth: { type: "score", score: 3 } }); // top of 4 levels
    const [out] = await scoreRubrics({
      model,
      rubrics: [{ name: "depth", prompt: "Depth of explanation.", scale: "score" }],
      evidence,
    });
    expect(out!.value).toBe(1);

    const mid = fakeJudge({ depth: { type: "score", score: 1 } });
    const [midOut] = await scoreRubrics({
      model: mid,
      rubrics: [{ name: "depth", prompt: "Depth of explanation.", scale: "score" }],
      evidence,
    });
    expect(midOut!.value).toBeCloseTo(1 / 3, 5);
  });

  it("asks a graded rubric as a score question and a plain one as boolean", async () => {
    const calls: { questions: Record<string, { type: string }> }[] = [];
    const model = fakeJudge(
      { a: { type: "boolean", probability: 1 }, b: { type: "score", score: 3 } },
      (o) => calls.push(o as never),
    );
    await scoreRubrics({
      model,
      rubrics: [
        { name: "a", prompt: "x", scale: "binary" },
        { name: "b", prompt: "y", scale: "score" },
      ],
      evidence,
    });
    expect(calls[0]!.questions.a!.type).toBe("boolean");
    expect(calls[0]!.questions.b!.type).toBe("score");
  });
});

describe("explanations", () => {
  it("explains only what failed, in ONE extra call", async () => {
    const model = fakeJudge({
      "uses-hn-tool": { type: "boolean", probability: 0.02 },
      "follows-digest-format": { type: "boolean", probability: 0.95 },
    });
    const explainModel = explainerReturning([
      { name: "uses-hn-tool", reason: "No tool call appears before the digest." },
    ]);
    const out = await scoreRubrics({ model, explainModel, rubrics: RUBRICS, evidence });

    expect(out[0]!.comment).toBe("No tool call appears before the digest.");
    expect(out[1]!.comment).toBeUndefined(); // passing rubrics need no explanation
  });

  it("makes no second call at all when nothing failed", async () => {
    const model = fakeJudge({
      "uses-hn-tool": { type: "boolean", probability: 0.99 },
      "follows-digest-format": { type: "boolean", probability: 0.99 },
    });
    const explainModel = explainerReturning([]);
    const spy = vi.spyOn(explainModel as unknown as MockLanguageModelV4, "doGenerate");
    const out = await scoreRubrics({ model, explainModel, rubrics: RUBRICS, evidence });
    expect(spy).not.toHaveBeenCalled();
    expect(out.every((o) => o.comment === undefined)).toBe(true);
  });

  it("keeps the verdict when the explainer fails — a missing tooltip is not a failed criterion", async () => {
    const model = fakeJudge({ "uses-hn-tool": { type: "boolean", probability: 0.01 } });
    const broken = new MockLanguageModelV4({
      modelId: "explainer",
      doGenerate: (async () => {
        throw new Error("explainer down");
      }) as never,
    }) as never;
    const [out] = await scoreRubrics({
      model,
      explainModel: broken,
      rubrics: [RUBRICS[0]!],
      evidence,
    });
    expect(out!.value).toBe(0);
    expect(out!.error).toBeUndefined();
    expect(out!.comment).toBeUndefined();
  });
});

describe("infrastructure failures", () => {
  it("marks every rubric as an ERROR, never as a failed criterion", async () => {
    // The distinction the whole tier depends on: a judge that could not run
    // must not look like an agent that misbehaved, or an outage silently
    // becomes a wall of regressions.
    const out = await scoreRubrics({
      model: throwingJudge("503 upstream"),
      rubrics: RUBRICS,
      evidence,
    });
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.error?.includes("503 upstream"))).toBe(true);
  });

  it("treats a PARTIAL answer set as an infra failure for the whole group", async () => {
    // The SDK enforces one answer per question, so a judge that returns some
    // of them fails the call outright. That is the behaviour we want: there is
    // no way to know WHICH rubric was dropped, and scoring the survivors would
    // publish an aggregate quietly computed over a different denominator.
    const model = fakeJudge({ "uses-hn-tool": { type: "boolean", probability: 0.9 } });
    const out = await scoreRubrics({ model, rubrics: RUBRICS, evidence });
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.error?.includes("one answer for every question"))).toBe(true);
  });

  it("returns nothing for no rubrics, without calling the judge", async () => {
    const model = fakeJudge({});
    const spy = vi.spyOn(model, "doEvaluate");
    expect(await scoreRubrics({ model, rubrics: [], evidence })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("choice rubrics", () => {
  const AMBIGUITY = {
    name: "handles-ambiguity",
    prompt: "The request did not say which region. What did the agent do?",
    scale: "choice",
    options: {
      asked: "Asked which region before answering",
      said_so: "Answered but stated which region it assumed",
      guessed: "Answered without saying which region it assumed",
    },
    bad: ["guessed"],
  };

  it("asks the options as a choice question", async () => {
    const calls: { questions: Record<string, { type: string; criteria?: unknown }> }[] = [];
    const model = fakeJudge(
      { "handles-ambiguity": { type: "choice", choice: "asked", probabilities: { asked: 0.8, said_so: 0.15, guessed: 0.05 } } },
      (o) => calls.push(o as never),
    );
    await scoreRubrics({ model, rubrics: [AMBIGUITY], evidence });
    expect(calls[0]!.questions["handles-ambiguity"]!.type).toBe("choice");
    expect(calls[0]!.questions["handles-ambiguity"]!.criteria).toEqual(AMBIGUITY.options);
  });

  it("keeps the label AND projects it to pass/fail", async () => {
    // The projection is what lets an aggregate over a choice rubric still mean
    // a pass rate; the label is the part a boolean would have destroyed.
    const good = fakeJudge({
      "handles-ambiguity": { type: "choice", choice: "said_so", probabilities: { asked: 0.2, said_so: 0.7, guessed: 0.1 } },
    });
    const [ok] = await scoreRubrics({ model: good, rubrics: [AMBIGUITY], evidence });
    expect(ok).toMatchObject({ value: 1, choice: "said_so", probability: 0.7 });

    const bad = fakeJudge({
      "handles-ambiguity": { type: "choice", choice: "guessed", probabilities: { asked: 0.05, said_so: 0.05, guessed: 0.9 } },
    });
    const [nope] = await scoreRubrics({ model: bad, rubrics: [AMBIGUITY], evidence });
    expect(nope).toMatchObject({ value: 0, choice: "guessed", probability: 0.9 });
  });

  it("distinguishes two failures a boolean would have merged", async () => {
    // The whole reason the type exists: "didn't handle ambiguity" is not one
    // bug. Guessing silently and refusing outright need different fixes.
    const withRefused = { ...AMBIGUITY, options: { ...AMBIGUITY.options, refused: "Declined" }, bad: ["guessed", "refused"] };
    const dist = (pick: string) =>
      Object.fromEntries(["asked", "said_so", "guessed", "refused"].map((k) => [k, k === pick ? 0.7 : 0.1]));
    const guessed = fakeJudge({ "handles-ambiguity": { type: "choice", choice: "guessed", probabilities: dist("guessed") } });
    const refused = fakeJudge({ "handles-ambiguity": { type: "choice", choice: "refused", probabilities: dist("refused") } });

    const [a] = await scoreRubrics({ model: guessed, rubrics: [withRefused], evidence });
    const [b] = await scoreRubrics({ model: refused, rubrics: [withRefused], evidence });
    expect(a!.value).toBe(0);
    expect(b!.value).toBe(0);
    expect(a!.choice).not.toBe(b!.choice); // same score, different diagnosis
  });

  it("mixes scales in one call", async () => {
    const model = fakeJudge({
      "uses-hn-tool": { type: "boolean", probability: 0.9 },
      depth: { type: "score", score: 3 },
      "handles-ambiguity": { type: "choice", choice: "asked", probabilities: { asked: 0.8, said_so: 0.15, guessed: 0.05 } },
    });
    const out = await scoreRubrics({
      model,
      rubrics: [RUBRICS[0]!, { name: "depth", prompt: "d", scale: "score" }, AMBIGUITY],
      evidence,
    });
    expect(out.map((o) => o.value)).toEqual([1, 1, 1]);
    expect(out[2]!.choice).toBe("asked");
  });
});
