import { describe, expect, it } from "vitest";
import { mean, ndcgAtK, precisionAtK, recallAtK, reciprocalRank, top1Hit } from "./metrics.js";

/**
 * Every expectation below is hand-computed — the scorer must match pencil-and-
 * paper arithmetic, not itself.
 */

const ranked = ["a", "b", "c", "d", "e"];
const relevant = new Set(["a", "c", "f"]);

describe("precisionAtK", () => {
  it("counts relevant results over k", () => {
    // top-5 = [a,b,c,d,e], relevant among them = {a,c} → 2/5
    expect(precisionAtK(ranked, relevant, 5)).toBeCloseTo(0.4, 10);
    // top-1 = [a] → 1/1
    expect(precisionAtK(ranked, relevant, 1)).toBe(1);
    // top-2 = [a,b] → 1/2
    expect(precisionAtK(ranked, relevant, 2)).toBeCloseTo(0.5, 10);
  });

  it("uses k as the denominator even when fewer results exist", () => {
    // ranked has only 2 items; P@5 = 1/5
    expect(precisionAtK(["a", "b"], relevant, 5)).toBeCloseTo(0.2, 10);
  });

  it("is 0 for k <= 0 or no relevant results", () => {
    expect(precisionAtK(ranked, new Set(["zz"]), 5)).toBe(0);
    expect(precisionAtK(ranked, relevant, 0)).toBe(0);
  });
});

describe("recallAtK", () => {
  it("counts found relevant over total relevant", () => {
    // found {a,c} of {a,c,f} → 2/3
    expect(recallAtK(ranked, relevant, 5)).toBeCloseTo(2 / 3, 10);
    // top-1 finds only a → 1/3
    expect(recallAtK(ranked, relevant, 1)).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 when there are no relevant items", () => {
    expect(recallAtK(ranked, new Set(), 5)).toBe(0);
  });

  it("is 0 for k <= 0", () => {
    expect(recallAtK(ranked, relevant, 0)).toBe(0);
    expect(recallAtK(ranked, relevant, -1)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(ranked, relevant)).toBe(1); // "a" at rank 1
    expect(reciprocalRank(["x", "y", "c"], relevant)).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 when nothing relevant is retrieved", () => {
    expect(reciprocalRank(["x", "y"], relevant)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("matches a hand-computed graded example", () => {
    // grades: a=3, c=1, f=3; ranked [a,b,c,d,e], k=5.
    // DCG  = (2^3-1)/log2(2) + (2^1-1)/log2(4)            = 7 + 0.5 = 7.5
    // IDCG = 7/log2(2) + 7/log2(3) + 1/log2(4)            = 7 + 4.416508… + 0.5
    //      = 11.916508…
    // nDCG = 7.5 / 11.916508… = 0.629379…
    const grades = new Map([
      ["a", 3],
      ["c", 1],
      ["f", 3],
    ]);
    const idcg = 7 + 7 / Math.log2(3) + 0.5;
    expect(ndcgAtK(ranked, grades, 5)).toBeCloseTo(7.5 / idcg, 10);
  });

  it("is 1 for a perfect ranking", () => {
    const grades = new Map([
      ["a", 3],
      ["b", 1],
    ]);
    expect(ndcgAtK(["a", "b"], grades, 5)).toBeCloseTo(1, 10);
  });

  it("penalizes the target appearing late", () => {
    const grades = new Map([["t", 3]]);
    // t at rank 3: DCG = 7/log2(4) = 3.5, IDCG = 7 → 0.5
    expect(ndcgAtK(["x", "y", "t"], grades, 5)).toBeCloseTo(0.5, 10);
  });

  it("is 0 with no judged items or nothing retrieved", () => {
    expect(ndcgAtK(ranked, new Map(), 5)).toBe(0);
    expect(ndcgAtK([], new Map([["a", 3]]), 5)).toBe(0);
  });

  it("is 0 for k <= 0", () => {
    const grades = new Map([["a", 3]]);
    expect(ndcgAtK(ranked, grades, 0)).toBe(0);
    expect(ndcgAtK(ranked, grades, -1)).toBe(0);
  });
});

describe("top1Hit", () => {
  it("requires the primary target at rank 1", () => {
    expect(top1Hit(["a", "b"], "a")).toBe(1);
    expect(top1Hit(["b", "a"], "a")).toBe(0);
    expect(top1Hit([], "a")).toBe(0);
  });
});

describe("mean", () => {
  it("averages and defaults to 0 for empty input", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });
});
