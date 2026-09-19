import { describe, expect, it } from "vitest";
import { effectiveFailed, reliabilityOf } from "./reliability";
import type { EvalRun } from "./store";

/** A run carrying one case whose checks have (judge, human) verdicts. */
const run = (
  id: string,
  checks: { id: string; failed: boolean; human?: boolean }[],
  caseId = "c1",
): EvalRun =>
  ({
    id,
    owner: "o",
    agentName: "a",
    setName: "default",
    agentSnapshot: null,
    passCount: 0,
    failCount: 0,
    createdAt: 0,
    results: [
      {
        caseId,
        caseName: caseId,
        pass: true,
        reasons: [],
        answerPreview: "",
        toolCalls: [],
        checks: checks.map((c) => ({
          id: c.id,
          answer: c.failed ? "false" : "true",
          confidence: 0.9,
          failed: c.failed,
          ...(c.human === undefined ? {} : { human: { failed: c.human, at: 1 } }),
        })),
      },
    ],
  }) as EvalRun;

describe("reliabilityOf", () => {
  it("ignores verdicts nobody has ruled on", () => {
    // An unlabelled verdict is not evidence for the judge OR against it, and
    // counting it as agreement would manufacture confidence out of silence.
    const r = reliabilityOf([run("r1", [{ id: "q", failed: false }])]);
    expect(r).toEqual([]);
  });

  it("counts agreement and names the runs that disagreed", () => {
    const runs = [
      run("r1", [{ id: "q", failed: true, human: true }]),
      run("r2", [{ id: "q", failed: true, human: false }]), // judge wrong
      run("r3", [{ id: "q", failed: false, human: false }]),
    ];
    const [q] = reliabilityOf(runs);
    expect(q).toMatchObject({ labelled: 3, agreed: 2, disputedRuns: ["r2"] });
    expect(q!.agreement).toBeCloseTo(2 / 3, 5);
  });

  it("keys on (case, check): the same question on another input is another measurement", () => {
    // A judge can be dependable asking "is this grounded?" of a short factual
    // answer and hopeless asking it of a long argumentative one.
    const runs = [
      run("r1", [{ id: "grounded", failed: false, human: false }], "easy"),
      run("r2", [{ id: "grounded", failed: false, human: true }], "hard"),
    ];
    const r = reliabilityOf(runs);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.caseId).sort()).toEqual(["easy", "hard"]);
  });

  it("refuses to let a lightly-labelled check gate, however perfect its record", () => {
    // THE point of the module. Agreement of 3/3 is not evidence; a check that
    // gated on it would fail builds on the strength of three clicks.
    const runs = Array.from({ length: 3 }, (_, i) =>
      run(`r${i}`, [{ id: "q", failed: false, human: false }]),
    );
    const [q] = reliabilityOf(runs);
    expect(q!.agreement).toBe(1);
    expect(q!.gating).toBe(false);
  });

  it("lets a well-labelled, well-agreed check gate", () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      run(`r${i}`, [{ id: "q", failed: false, human: false }]),
    );
    expect(reliabilityOf(runs)[0]!.gating).toBe(true);
  });

  it("refuses to let a well-labelled but unreliable check gate", () => {
    // Right four times in five fires a false alarm on a fifth of runs, which
    // is how a suite stops being read.
    const runs = Array.from({ length: 20 }, (_, i) =>
      run(`r${i}`, [{ id: "q", failed: false, human: i % 5 === 0 }]),
    );
    const [q] = reliabilityOf(runs);
    expect(q!.agreement).toBeCloseTo(0.8, 5);
    expect(q!.gating).toBe(false);
  });

  it("sorts the least trustworthy first — those are the ones to rewrite", () => {
    const runs = [
      run("r1", [
        { id: "good", failed: false, human: false },
        { id: "bad", failed: true, human: false },
      ]),
      run("r2", [
        { id: "good", failed: false, human: false },
        { id: "bad", failed: true, human: false },
      ]),
    ];
    expect(reliabilityOf(runs).map((r) => r.checkId)).toEqual(["bad", "good"]);
  });

  it("honours a caller's own idea of enough", () => {
    const runs = Array.from({ length: 4 }, (_, i) =>
      run(`r${i}`, [{ id: "q", failed: false, human: false }]),
    );
    expect(reliabilityOf(runs, { minLabels: 4 })[0]!.gating).toBe(true);
    expect(reliabilityOf(runs, { minLabels: 5 })[0]!.gating).toBe(false);
  });
});

describe("effectiveFailed", () => {
  it("prefers the human ruling wherever there is one", () => {
    // Otherwise a correction is cosmetic: the dashboard keeps reporting the
    // answer a person already said was wrong.
    expect(effectiveFailed({ failed: true, human: { failed: false } })).toBe(false);
    expect(effectiveFailed({ failed: false, human: { failed: true } })).toBe(true);
  });

  it("falls back to the judge when nobody has ruled", () => {
    expect(effectiveFailed({ failed: true })).toBe(true);
  });
});
