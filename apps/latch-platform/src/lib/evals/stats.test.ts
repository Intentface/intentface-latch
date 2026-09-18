import { describe, expect, it } from "vitest";
import {
  bootstrapPValue,
  compare,
  pairedDifferences,
  survivingFdr,
  type Observation,
} from "./stats";

/** `pattern` is per-task failure (1/0) for one version. */
const obs = (agent: string, pattern: number[], prefix = "q"): Observation[] =>
  pattern.map((value, i) => ({ task: `${prefix}${i}`, agent, value }));

describe("pairedDifferences", () => {
  it("drops a task only one version attempted", () => {
    // Including it silently unpairs the comparison: the difference for that
    // task is unknowable, and treating the missing side as 0 invents data.
    const o: Observation[] = [
      ...obs("v12", [1, 0]),
      ...obs("v13", [0, 0]),
      { task: "q2", agent: "v13", value: 1 }, // head only
    ];
    expect(pairedDifferences(o, "v12", "v13").map((p) => p.task)).toEqual(["q0", "q1"]);
  });

  it("averages repeats within a task before differencing", () => {
    const o: Observation[] = [
      { task: "q0", agent: "v12", value: 1 },
      { task: "q0", agent: "v12", value: 0 }, // base 0.5
      { task: "q0", agent: "v13", value: 0 },
    ];
    expect(pairedDifferences(o, "v12", "v13")).toEqual([{ task: "q0", diff: -0.5 }]);
  });

  it("ignores versions that are not being compared", () => {
    const o = [...obs("v11", [1, 1]), ...obs("v12", [1, 1]), ...obs("v13", [0, 0])];
    expect(pairedDifferences(o, "v12", "v13")).toHaveLength(2);
  });
});

describe("compare", () => {
  it("calls a large consistent regression regressed, with an interval clear of zero", () => {
    // Head fails 30 of 40 tasks the base passed.
    const base = obs("v12", Array.from({ length: 40 }, () => 0));
    const head = obs("v13", Array.from({ length: 40 }, (_, i) => (i < 30 ? 1 : 0)));
    const r = compare([...base, ...head], "v12", "v13");

    expect(r.verdict).toBe("regressed");
    expect(r.delta).toBeCloseTo(0.75, 2);
    expect(r.ci[0]).toBeGreaterThan(0);
    expect(r.n).toBe(40);
    expect(r.baseRate).toBeCloseTo(0, 5);
    expect(r.headRate).toBeCloseTo(0.75, 5);
  });

  it("calls the reverse improved", () => {
    const base = obs("v12", Array.from({ length: 40 }, (_, i) => (i < 30 ? 1 : 0)));
    const head = obs("v13", Array.from({ length: 40 }, () => 0));
    const r = compare([...base, ...head], "v12", "v13");
    expect(r.verdict).toBe("improved");
    expect(r.delta).toBeLessThan(0);
    expect(r.ci[1]).toBeLessThan(0);
  });

  it("calls identical behaviour flat, not improved and not underpowered", () => {
    const pattern = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const r = compare([...obs("v12", pattern), ...obs("v13", pattern)], "v12", "v13");
    expect(r.verdict).toBe("flat");
    expect(r.delta).toBe(0);
  });

  it("says UNDERPOWERED rather than flat when the sample cannot tell", () => {
    // THE distinction that keeps a suite trusted. Six tasks, one flipped:
    // the point estimate is a 17% regression and the interval is enormous.
    // Calling that "flat" hides a real regression; calling it "regressed"
    // cries wolf. Neither is honest.
    const base = obs("v12", [0, 0, 0, 0, 0, 0]);
    const head = obs("v13", [1, 0, 0, 0, 0, 0]);
    const r = compare([...base, ...head], "v12", "v13");

    expect(r.verdict).toBe("underpowered");
    expect(r.ci[0]).toBeLessThanOrEqual(0);
    expect(r.ci[1]).toBeGreaterThan(0);
    expect(r.mde).toBeGreaterThan(Math.abs(r.delta)); // "you can't see an effect this small yet"
  });

  it("reports an MDE that shrinks as the sample grows", () => {
    const noisy = (n: number, agent: string, seedOffset: number) =>
      obs(
        agent,
        Array.from({ length: n }, (_, i) => ((i + seedOffset) % 4 === 0 ? 1 : 0)),
      );
    const small = compare([...noisy(20, "v12", 0), ...noisy(20, "v13", 1)], "v12", "v13");
    const large = compare([...noisy(400, "v12", 0), ...noisy(400, "v13", 1)], "v12", "v13");
    expect(large.mde).toBeLessThan(small.mde);
  });

  it("is reproducible — the same inputs give the same interval", () => {
    const o = [...obs("v12", [1, 0, 1, 0, 1, 1, 0, 0]), ...obs("v13", [0, 0, 1, 0, 0, 1, 0, 1])];
    expect(compare(o, "v12", "v13").ci).toEqual(compare(o, "v12", "v13").ci);
  });

  it("does not depend on the order observations arrive in", () => {
    const o = [...obs("v12", [1, 0, 1, 0, 1, 1, 0, 0]), ...obs("v13", [0, 0, 1, 0, 0, 1, 0, 1])];
    expect(compare([...o].reverse(), "v12", "v13").ci).toEqual(compare(o, "v12", "v13").ci);
  });

  it("returns underpowered with no paired tasks rather than pretending to know", () => {
    const r = compare([...obs("v12", [1, 1], "a"), ...obs("v13", [0, 0], "b")], "v12", "v13");
    expect(r.n).toBe(0);
    expect(r.verdict).toBe("underpowered");
    expect(r.mde).toBe(Infinity);
  });

  it("respects a stricter idea of what counts as meaningful", () => {
    // Real disagreement in BOTH directions, so the mean difference is zero but
    // the interval is genuinely wide. Whether that reads as "no meaningful
    // change" or "cannot tell" is a judgement about what size of change you
    // would act on — so it is a caller's parameter, not a constant.
    const base = Array.from({ length: 60 }, (_, i) => (i % 6 === 3 ? 1 : 0));
    const head = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? 1 : 0));
    const o = [...obs("v12", base), ...obs("v13", head)];

    expect(compare(o, "v12", "v13").delta).toBeCloseTo(0, 6);
    expect(compare(o, "v12", "v13", { meaningfulDelta: 0.3 }).verdict).toBe("flat");
    expect(compare(o, "v12", "v13", { meaningfulDelta: 0.05 }).verdict).toBe("underpowered");
  });
});

describe("bootstrapPValue", () => {
  it("is small for a clear effect and large for none", () => {
    const clear = [
      ...obs("v12", Array.from({ length: 40 }, () => 0)),
      ...obs("v13", Array.from({ length: 40 }, () => 1)),
    ];
    const none = [
      ...obs("v12", Array.from({ length: 40 }, (_, i) => i % 2)),
      ...obs("v13", Array.from({ length: 40 }, (_, i) => i % 2)),
    ];
    expect(bootstrapPValue(clear, "v12", "v13")).toBeLessThan(0.05);
    expect(bootstrapPValue(none, "v12", "v13")).toBeGreaterThan(0.5);
  });

  it("reports NO evidence when the two versions behaved identically", () => {
    // Regression test for a real bug: counting ties as "below zero" and taking
    // the complement made an all-zero resample distribution look entirely
    // one-sided, so two identical versions came back at the p-value floor —
    // "highly significant" for no difference at all.
    const same = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    expect(bootstrapPValue([...obs("v12", same), ...obs("v13", same)], "v12", "v13")).toBe(1);
  });

  it("never claims more precision than the number of resamples allows", () => {
    const clear = [
      ...obs("v12", Array.from({ length: 200 }, () => 0)),
      ...obs("v13", Array.from({ length: 200 }, () => 1)),
    ];
    const p = bootstrapPValue(clear, "v12", "v13", { iterations: 1_000 });
    expect(p).toBeGreaterThanOrEqual(1 / 1_000);
  });
});

describe("survivingFdr", () => {
  it("keeps a genuine finding among many null ones", () => {
    // 19 questions that found nothing plus one real regression — the shape of
    // every real comparison, and the shape that produces a false alarm about
    // half the time without correction.
    const findings = [
      { id: "real", pValue: 0.0001 },
      ...Array.from({ length: 19 }, (_, i) => ({ id: `null${i}`, pValue: 0.3 + i * 0.03 })),
    ];
    expect([...survivingFdr(findings, 0.1)]).toEqual(["real"]);
  });

  it("drops the one lucky p-value among twenty nulls", () => {
    const findings = [
      { id: "lucky", pValue: 0.04 },
      ...Array.from({ length: 19 }, (_, i) => ({ id: `null${i}`, pValue: 0.2 + i * 0.04 })),
    ];
    expect(survivingFdr(findings, 0.1).has("lucky")).toBe(false);
  });

  it("keeps everything when everything is real", () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, pValue: 0.0001 }));
    expect(survivingFdr(findings, 0.1).size).toBe(5);
  });

  it("returns nothing for no findings", () => {
    expect(survivingFdr([], 0.1).size).toBe(0);
  });
});
