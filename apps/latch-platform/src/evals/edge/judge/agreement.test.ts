import { describe, expect, it } from "vitest";
import { binaryAgreement, categoricalAgreement, cohenKappa, ordinalAgreement } from "./agreement";

describe("agreement", () => {
  it("returns κ = 1 for perfect agreement and ≈0 for chance", () => {
    expect(cohenKappa([["a", "a"], ["b", "b"], ["a", "a"], ["b", "b"]])).toBe(1);
    // Independent raters with identical 50/50 marginals: po = pe = 0.5 → κ = 0.
    expect(cohenKappa([["a", "a"], ["a", "b"], ["b", "a"], ["b", "b"]])).toBe(0);
  });

  it("is negative when the raters disagree more than chance", () => {
    expect(cohenKappa([["a", "b"], ["b", "a"], ["a", "b"], ["b", "a"]])!).toBeLessThan(0);
  });

  it("matches the textbook worked example", () => {
    // Landis & Koch style 2×2: a=20, b=5, c=10, d=15 → po=0.7, pe=0.5, κ=0.4.
    const pairs: Array<[string, string]> = [
      ...Array.from({ length: 20 }, () => ["yes", "yes"] as [string, string]),
      ...Array.from({ length: 5 }, () => ["yes", "no"] as [string, string]),
      ...Array.from({ length: 10 }, () => ["no", "yes"] as [string, string]),
      ...Array.from({ length: 15 }, () => ["no", "no"] as [string, string]),
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 3);
  });

  it("returns null when a rater used a single category (κ undefined)", () => {
    expect(cohenKappa([["a", "a"], ["a", "a"]])).toBeNull();
    expect(categoricalAgreement([["a", "a"], ["a", "a"]]).raw).toBe(1);
  });

  it("weights an off-by-one rung below an opposite verdict", () => {
    const offByOne: Array<[number, number]> = [[3, 2], [2, 1], [1, 0], [0, 1], [2, 3], [1, 2]];
    const opposite: Array<[number, number]> = [[3, 0], [0, 3], [3, 0], [0, 3], [3, 0], [0, 3]];
    expect(cohenKappa(offByOne, "quadratic")!).toBeGreaterThan(cohenKappa(opposite, "quadratic")!);
  });

  it("reports sign agreement and mean delta on the −2…+2 preference scale", () => {
    const a = ordinalAgreement([[2, 1], [-2, -1], [0, 0], [2, -2]]);
    expect(a.n).toBe(4);
    expect(a.raw).toBe(0.25);
    expect(a.signAgreement).toBe(0.75); // three of four on the same side of zero
    expect(a.meanAbsDelta).toBe(1.5); // (1 + 1 + 0 + 4) / 4
  });

  it("handles the boolean dimensions", () => {
    expect(binaryAgreement([[true, true], [false, false], [true, false]]).raw).toBeCloseTo(0.667, 2);
  });
});

describe("caveats", () => {
  it("flags a sample too small for κ", () => {
    const a = ordinalAgreement([[2, 1], [-2, -1], [0, 0]]);
    expect(a.caveat).toMatch(/n = 3/);
  });

  it("flags a zero-variance rater, where κ reads ~0 despite total agreement on the winner", () => {
    // Both raters always pick the same side; one never varies its strength.
    const pairs: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [2, i % 2 ? 1 : 2]);
    const a = ordinalAgreement(pairs);
    expect(a.signAgreement).toBe(1);
    expect(a.caveat).toMatch(/single category/);
  });

  it("stays silent on a healthy sample", () => {
    const pairs: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [i % 4, (i + 1) % 4]);
    expect(ordinalAgreement(pairs).caveat).toBeUndefined();
  });
});
