import { describe, expect, it } from "vitest";
import {
  chatKindOf,
  evaluateTrigger,
  rubricIsDue,
  triggerMentionsDepth,
  triggerNeedsTurnOrdinal,
  turnOrdinalOf,
  validateTrigger,
} from "./trigger";
import type { EvalTrigger, TriggerFacts } from "./trigger";

const facts = (over: Partial<TriggerFacts> = {}): TriggerFacts => ({
  turnOrdinal: 1,
  toolsCalled: [],
  depth: 0,
  chatKind: "user",
  ...over,
});

describe("evaluateTrigger", () => {
  it("matches turn comparators, ANDed when combined", () => {
    expect(evaluateTrigger({ kind: "turn", eq: 1 }, facts())).toBe(true);
    expect(evaluateTrigger({ kind: "turn", eq: 2 }, facts())).toBe(false);
    expect(evaluateTrigger({ kind: "turn", gte: 2, lte: 4 }, facts({ turnOrdinal: 3 }))).toBe(true);
    expect(evaluateTrigger({ kind: "turn", gte: 2, lte: 4 }, facts({ turnOrdinal: 5 }))).toBe(false);
  });

  it("everyNth matches turns N, 2N, … (1-based)", () => {
    const t: EvalTrigger = { kind: "turn", everyNth: 3 };
    expect(evaluateTrigger(t, facts({ turnOrdinal: 3 }))).toBe(true);
    expect(evaluateTrigger(t, facts({ turnOrdinal: 6 }))).toBe(true);
    expect(evaluateTrigger(t, facts({ turnOrdinal: 1 }))).toBe(false);
    expect(evaluateTrigger(t, facts({ turnOrdinal: 4 }))).toBe(false);
  });

  it("toolCalled matches a named tool, or any tool when name is omitted", () => {
    const called = facts({ toolsCalled: ["web_fetch", "spawn_agent"] });
    expect(evaluateTrigger({ kind: "toolCalled", name: "spawn_agent" }, called)).toBe(true);
    expect(evaluateTrigger({ kind: "toolCalled", name: "send_email" }, called)).toBe(false);
    expect(evaluateTrigger({ kind: "toolCalled" }, called)).toBe(true);
    expect(evaluateTrigger({ kind: "toolCalled" }, facts())).toBe(false);
  });

  it("evaluates depth and chatKind leaves", () => {
    expect(evaluateTrigger({ kind: "depth", eq: 0 }, facts())).toBe(true);
    expect(evaluateTrigger({ kind: "depth", gte: 1 }, facts({ depth: 2 }))).toBe(true);
    expect(evaluateTrigger({ kind: "chatKind", is: "internal" }, facts())).toBe(false);
    expect(
      evaluateTrigger({ kind: "chatKind", is: "internal" }, facts({ chatKind: "internal" })),
    ).toBe(true);
  });

  it("combines with all/any/not", () => {
    const t: EvalTrigger = {
      kind: "all",
      of: [
        { kind: "turn", gte: 2 },
        { kind: "not", of: { kind: "toolCalled", name: "spawn_agent" } },
      ],
    };
    expect(evaluateTrigger(t, facts({ turnOrdinal: 2 }))).toBe(true);
    expect(evaluateTrigger(t, facts({ turnOrdinal: 2, toolsCalled: ["spawn_agent"] }))).toBe(false);
    expect(
      evaluateTrigger(
        { kind: "any", of: [{ kind: "turn", eq: 9 }, { kind: "depth", gte: 1 }] },
        facts({ depth: 1 }),
      ),
    ).toBe(true);
  });
});

describe("rubricIsDue (the subagent default)", () => {
  it("no trigger → due on top-level turns only", () => {
    expect(rubricIsDue(undefined, facts())).toBe(true);
    expect(rubricIsDue(undefined, facts({ depth: 1 }))).toBe(false);
  });

  it("a depth-less trigger stays top-level-only even when it matches", () => {
    const t: EvalTrigger = { kind: "turn", eq: 1 };
    expect(rubricIsDue(t, facts({ depth: 1 }))).toBe(false);
    expect(rubricIsDue(t, facts())).toBe(true);
  });

  it("mentioning depth anywhere opts the rubric into subagent turns", () => {
    expect(rubricIsDue({ kind: "depth", gte: 0 }, facts({ depth: 2 }))).toBe(true);
    const nested: EvalTrigger = {
      kind: "all",
      of: [{ kind: "turn", eq: 1 }, { kind: "depth", gte: 0 }],
    };
    expect(rubricIsDue(nested, facts({ depth: 1, turnOrdinal: 1 }))).toBe(true);
    expect(rubricIsDue(nested, facts({ depth: 1, turnOrdinal: 2 }))).toBe(false);
  });
});

describe("trigger tree inspection", () => {
  it("triggerMentionsDepth walks combinators", () => {
    expect(triggerMentionsDepth(undefined)).toBe(false);
    expect(triggerMentionsDepth({ kind: "turn", eq: 1 })).toBe(false);
    expect(
      triggerMentionsDepth({ kind: "not", of: { kind: "depth", eq: 0 } }),
    ).toBe(true);
  });

  it("triggerNeedsTurnOrdinal walks combinators", () => {
    expect(triggerNeedsTurnOrdinal(undefined)).toBe(false);
    expect(triggerNeedsTurnOrdinal({ kind: "depth", gte: 0 })).toBe(false);
    expect(
      triggerNeedsTurnOrdinal({ kind: "any", of: [{ kind: "turn", everyNth: 2 }] }),
    ).toBe(true);
  });
});

describe("validateTrigger", () => {
  it("accepts well-formed trees and rejects malformed ones", () => {
    expect(validateTrigger({ kind: "turn", eq: 1 })).toBeNull();
    expect(
      validateTrigger({
        kind: "all",
        of: [{ kind: "turn", everyNth: 5 }, { kind: "not", of: { kind: "toolCalled" } }],
      }),
    ).toBeNull();
    expect(validateTrigger(null)).toMatch(/object/);
    expect(validateTrigger({ kind: "sometimes" })).toMatch(/unknown trigger kind/);
    expect(validateTrigger({ kind: "turn" })).toMatch(/at least one/);
    expect(validateTrigger({ kind: "turn", eq: 0 })).toMatch(/positive integer/);
    expect(validateTrigger({ kind: "turn", everyNth: 1.5 })).toMatch(/positive integer/);
    expect(validateTrigger({ kind: "depth" })).toMatch(/at least one/);
    expect(validateTrigger({ kind: "depth", gte: -1 })).toMatch(/non-negative/);
    expect(validateTrigger({ kind: "all", of: [] })).toMatch(/non-empty/);
    expect(validateTrigger({ kind: "chatKind" })).toMatch(/non-empty "is"/);
    expect(validateTrigger({ kind: "toolCalled", name: "" })).toMatch(/non-empty string/);
  });

  it("bounds nesting depth and node count", () => {
    let deep: unknown = { kind: "turn", eq: 1 };
    for (let i = 0; i < 6; i++) deep = { kind: "not", of: deep };
    expect(validateTrigger(deep)).toMatch(/deeper/);

    const wide = {
      kind: "all",
      of: Array.from({ length: 30 }, () => ({ kind: "turn", eq: 1 })),
    };
    expect(validateTrigger(wide)).toMatch(/nodes/);
  });
});

describe("turnOrdinalOf", () => {
  const msg = (role: string, runId?: string) => ({
    role,
    metadata: runId ? { runId } : undefined,
  });

  it("counts assistant turns up to and including the run", () => {
    const history = [
      msg("user"),
      msg("assistant", "r1"),
      msg("user"),
      msg("assistant", "r2"),
      msg("user"),
      msg("assistant", "r3"),
    ];
    expect(turnOrdinalOf(history, "r1")).toBe(1);
    expect(turnOrdinalOf(history, "r2")).toBe(2);
    expect(turnOrdinalOf(history, "r3")).toBe(3);
  });

  it("falls back to the total assistant count for an unknown runId", () => {
    const history = [msg("user"), msg("assistant", "r1"), msg("assistant", "r2")];
    expect(turnOrdinalOf(history, "missing")).toBe(2);
  });
});

describe("chatKindOf", () => {
  it("derives internal from the sub_ prefix", () => {
    expect(chatKindOf("sub_abc123")).toBe("internal");
    expect(chatKindOf("chat_abc123")).toBe("user");
  });
});
