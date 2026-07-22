import { describe, expect, it } from "vitest";
import { anthropic } from "@ai-sdk/anthropic";
import { JUDGE_MODEL_ID, judgeRubric } from "./judge";

/**
 * Meta-eval of the REAL pinned judge: known-good / known-bad transcripts it
 * must grade correctly. Live model calls — skipped unless LIVE_JUDGE=1 (needs
 * ANTHROPIC_API_KEY), so the default suite stays fast and hermetic. Run before
 * trusting a judge model change:  LIVE_JUDGE=1 npx vitest run judge.live
 */
const live = process.env.LIVE_JUDGE === "1";

const GOOD_ANSWER =
  "This week I'd cut intensity: your orient data shows three hard sessions in the last four days, " +
  "so the priority is absorbing that load — an easy 30min jog Tuesday, rest Wednesday, and we " +
  "reassess Friday. The reason for the down-week is that adaptation happens during recovery, " +
  "and stacking another interval session now risks overuse injury.";

const BAD_ANSWER = "Tuesday: 30min jog. Wednesday: rest. Friday: intervals 6x400m.";

describe.skipIf(!live)("judge meta-eval (LIVE calls to the pinned judge)", () => {
  const model = anthropic(JUDGE_MODEL_ID);
  const base = { model, input: "What should my training week look like?", toolCalls: [{ tool: "orient" }] };

  it("passes a criterion the answer clearly satisfies", async () => {
    const [v] = await judgeRubric({
      ...base,
      answer: GOOD_ANSWER,
      criteria: ["explains the reasoning behind the recommendation, not just the schedule"],
    });
    expect(v.error).toBeUndefined();
    expect(v.pass, v.reason).toBe(true);
  }, 30_000);

  it("fails a criterion the answer clearly violates", async () => {
    const [v] = await judgeRubric({
      ...base,
      answer: BAD_ANSWER,
      criteria: ["explains the reasoning behind the recommendation, not just the schedule"],
    });
    expect(v.error).toBeUndefined();
    expect(v.pass, v.reason).toBe(false);
    expect(v.reason.length).toBeGreaterThan(0);
  }, 30_000);

  it("judges ONLY the stated criterion, not overall answer quality", async () => {
    // The bare-schedule answer is low quality, but the criterion below is
    // satisfied — a judge that grades holistically would wrongly fail it.
    const [v] = await judgeRubric({
      ...base,
      answer: BAD_ANSWER,
      criteria: ["includes at least one rest day in the plan"],
    });
    expect(v.error).toBeUndefined();
    expect(v.pass, v.reason).toBe(true);
  }, 30_000);
});
