import { describe, expect, it } from "vitest";
import { normalizePairwise, pairwiseBlock, PREFERENCE_CONFIG, REASON_CONFIG, REASON_LABELS } from "./pairwise";

describe("pairwise verdict normalization", () => {
  it("keeps a well-formed verdict", () => {
    expect(normalizePairwise({ preference: -2, primary_reason: "better_grounding" })).toEqual({ preference: -2, primary_reason: "better_grounding" });
  });

  it("clamps and rounds an out-of-range or fractional preference", () => {
    expect(normalizePairwise({ preference: 2.4, primary_reason: "more_decisive" }).preference).toBe(2);
    expect(normalizePairwise({ preference: -7, primary_reason: "wrong_stage" }).preference).toBe(-2);
    expect(normalizePairwise({ preference: 1.5, primary_reason: "more_actionable" }).preference).toBe(2);
  });

  it("repairs a near-miss reason label", () => {
    expect(normalizePairwise({ preference: 1, primary_reason: "Invented client fact." }).primary_reason).toBe("invented_client_fact");
    expect(normalizePairwise({ preference: 1, primary_reason: "generic_advice (left is boilerplate)" }).primary_reason).toBe("generic_advice");
  });

  it("forces a tie's reason to tie_or_no_reason and rejects the reverse", () => {
    expect(normalizePairwise({ preference: 0, primary_reason: "style_only" }).primary_reason).toBe("tie_or_no_reason");
    expect(() => normalizePairwise({ preference: 2, primary_reason: "tie_or_no_reason" })).toThrow(/tie_or_no_reason/);
  });

  it("throws on an unusable verdict", () => {
    expect(() => normalizePairwise({ primary_reason: "better_trade_off" })).toThrow(/numeric preference/);
    expect(() => normalizePairwise({ preference: 1, primary_reason: "vibes" })).toThrow(/unrecognized/);
  });

  it("keeps the human score configs and the judge's vocabulary identical", () => {
    expect(REASON_CONFIG.categories.map((c) => c.label)).toEqual([...REASON_LABELS]);
    expect(PREFERENCE_CONFIG.categories.map((c) => c.value)).toEqual([-2, -1, 0, 1, 2]);
  });

  it("shows the judge the two answers and never the arm behind a side", () => {
    const block = pairwiseBlock({
      question: "How should we approach observability?",
      followup: "Yes, that direction.",
      left: { turn1: "L1", turn2: "L2" },
      right: { turn1: "R1", turn2: "R2" },
    });
    expect(block).toContain("## LEFT");
    expect(block).toContain("## RIGHT");
    for (const s of ["L1", "L2", "R1", "R2"]) expect(block).toContain(s);
    expect(block).not.toMatch(/edge-eval-|variant|arm [ABD]\b|full Edge/i);
  });
});
