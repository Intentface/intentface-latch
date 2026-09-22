import { describe, expect, it } from "vitest";
import type { Ruling, ThreadRef, Verdict } from "./model";
import { rulingQueue, thresholdFor, trustOf } from "./alignment";

const v = (threadId: string, checkId: string, failed: boolean, confidence?: number, answer = failed ? "false" : "true"): Verdict => ({
  threadId,
  checkId,
  rubricVersion: 1,
  judgeId: "jev-latest",
  answer,
  failed,
  ...(confidence !== undefined ? { confidence } : {}),
  createdAt: 0,
});
const r = (threadId: string, checkId: string, failed: boolean): Ruling => ({ threadId, checkId, failed, createdAt: 0 });
const t = (threadId: string, inputId: string, version: string): ThreadRef => ({
  owner: "o",
  threadId,
  agentName: "a",
  inputId,
  version,
  configFingerprint: version,
  origin: "run",
  answer: "x",
  createdAt: 0,
});

describe("trust", () => {
  it("claims nothing below twenty rulings", () => {
    const [x] = trustOf([v("t1", "c", false)], [r("t1", "c", false)]);
    expect(x).toMatchObject({ ruled: 1, agreed: 1, level: "unknown" });
  });

  it("separates the dangerous error from the wasteful one", () => {
    const verdicts = Array.from({ length: 30 }, (_, i) => v(`t${i}`, "c", i < 3));
    // People fail t3..t5 too: the judge passed three things people failed.
    const rulings = Array.from({ length: 30 }, (_, i) => r(`t${i}`, "c", i < 6));
    const [x] = trustOf(verdicts, rulings);
    expect(x).toMatchObject({ ruled: 30, agreed: 27, falsePasses: 3, falseFails: 0, level: "trusted" });
    expect(x!.kappa).toBeGreaterThan(0.5);
  });

  it("disputes a check people keep overruling, and gates one they do not", () => {
    const many = (n: number, disagree: number) => ({
      verdicts: Array.from({ length: n }, (_, i) => v(`t${i}`, "c", false)),
      rulings: Array.from({ length: n }, (_, i) => r(`t${i}`, "c", i < disagree)),
    });
    const bad = many(25, 5);
    expect(trustOf(bad.verdicts, bad.rulings)[0]!.level).toBe("disputed");
    const good = many(60, 2);
    expect(trustOf(good.verdicts, good.rulings)[0]!.level).toBe("gating");
  });
});

describe("queue", () => {
  it("puts unsure, flipped and version-splitting verdicts first, spread across checks", () => {
    const threads = [t("a1", "i1", "live"), t("b1", "i1", "@draft"), t("a2", "i2", "live"), t("b2", "i2", "@draft")];
    const verdicts = [
      v("a1", "grounded", false, 0.99),
      v("b1", "grounded", true, 0.99), // versions split on i1
      v("a2", "grounded", false, 0.55), // unsure
      v("b2", "grounded", false, 0.99),
      v("a1", "tone", false, 0.99),
    ];
    const flipped = [v("b2", "grounded", true, 0.9)];
    const q = rulingQueue({ verdicts, rulings: [r("a1", "tone", false)], threads, passes: [verdicts, flipped], limit: 10 });
    // a1/tone is ruled already; everything else is queued.
    expect(q.map((x) => `${x.threadId}|${x.checkId}`)).not.toContain("a1|tone");
    expect(q).toHaveLength(4);
    expect(q[0]!.reason).toMatch(/changed its answer|sure|versions differ/);
    expect(q.find((x) => x.threadId === "b2")!.reason).toContain("changed its answer");
    expect(q.find((x) => x.threadId === "a2")!.reason).toContain("55% sure");
  });
});

describe("threshold", () => {
  it("accepts nothing on faith", () => {
    expect(thresholdFor("c", [v("t1", "c", false, 0.99)], [r("t1", "c", false)]).accept).toBeNull();
  });

  it("finds the confidence above which the judge has matched people", () => {
    // 30 confident verdicts all right; 10 unsure ones, half wrong.
    const verdicts = [
      ...Array.from({ length: 30 }, (_, i) => v(`h${i}`, "c", false, 0.95)),
      ...Array.from({ length: 10 }, (_, i) => v(`l${i}`, "c", false, 0.6)),
    ];
    const rulings = [
      ...Array.from({ length: 30 }, (_, i) => r(`h${i}`, "c", false)),
      ...Array.from({ length: 10 }, (_, i) => r(`l${i}`, "c", i < 5)),
    ];
    const th = thresholdFor("c", verdicts, rulings);
    expect(th.accept).toBe(0.95);
    expect(th.coverage).toBeCloseTo(0.75);
    expect(th.agreement).toBe(1);
  });
});
