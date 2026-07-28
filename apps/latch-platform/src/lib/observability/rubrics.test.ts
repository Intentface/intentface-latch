import { describe, expect, it } from "vitest";
import type { AttachedEval } from "../agent-store";
import { validateRubrics } from "./rubrics";

const anyModel = () => true;

const rubric = (over: Partial<AttachedEval> = {}): AttachedEval => ({
  name: "stays-on-topic",
  prompt: "Stays on topic.",
  scale: "binary",
  enabled: true,
  ...over,
});

describe("validateRubrics — trigger/context", () => {
  it("accepts a legacy rubric with neither field (back-compat)", () => {
    const res = validateRubrics([rubric()], anyModel);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rubrics[0]).not.toHaveProperty("trigger");
      expect(res.rubrics[0]).not.toHaveProperty("context");
    }
  });

  it("preserves a valid trigger and context in the cleaned output", () => {
    const res = validateRubrics(
      [rubric({ trigger: { kind: "turn", eq: 1 }, context: "chat" })],
      anyModel,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rubrics[0].trigger).toEqual({ kind: "turn", eq: 1 });
      expect(res.rubrics[0].context).toBe("chat");
    }
  });

  it("rejects a malformed trigger with the rubric named", () => {
    const res = validateRubrics(
      [rubric({ trigger: { kind: "sometimes" } as never })],
      anyModel,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/stays-on-topic.*unknown trigger kind/);
  });

  it("rejects an unknown context scope", () => {
    const res = validateRubrics([rubric({ context: "everything" as never })], anyModel);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid context/);
  });
});
