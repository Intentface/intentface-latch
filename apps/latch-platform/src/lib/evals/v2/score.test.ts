import { describe, expect, it } from "vitest";
import { cellsOf, columnRate, verdictFor, versus } from "./score";

const t = (threadId: string, inputId: string, column: string, attempt = 0) => ({ threadId, inputId, column, attempt, error: null });
const v = (threadId: string, answer: string, failed: boolean, ruling: boolean | null = null) => ({ threadId, answer, failed, ruling });

describe("what the Results page counts", () => {
  it("counts each item of a list check as a test, beside the other checks", () => {
    const grid = {
      inputs: [{ id: "1" }],
      threads: [t("a", "1", "live")],
      verdicts: [v("a", JSON.stringify({ each: [true, false] }), true), v("a", "true", false), v("a", "false", true)],
    };
    expect(cellsOf(grid).get("1|live")!.tries[0]).toMatchObject({ pass: 2, of: 4 });
  });

  it("lets a person's ruling stand for the whole check it rules on", () => {
    const grid = { inputs: [{ id: "1" }], threads: [t("a", "1", "live")], verdicts: [v("a", JSON.stringify({ each: [false, false] }), true, false)] };
    expect(cellsOf(grid).get("1|live")!.tries[0]).toMatchObject({ pass: 1, of: 1 });
  });

  it("scores a column as the average input, however many tests each has", () => {
    const grid = {
      inputs: [{ id: "1" }, { id: "2" }],
      threads: [t("a", "1", "live"), t("b", "2", "live")],
      // Input 1: 1 of 1. Input 2: 0 of 3. Pooled that is 25%; the average input is 50%.
      verdicts: [v("a", "true", false), v("b", "false", true), v("b", "false", true), v("b", "false", true)],
    };
    expect(columnRate(grid, cellsOf(grid), "live")).toBe(0.5);
  });

  it("compares input by input, and words the verdict by how lopsided it is", () => {
    const inputs = Array.from({ length: 15 }, (_, n) => ({ id: String(n) }));
    const threads = inputs.flatMap((i) => [t(`b${i.id}`, i.id, "live"), t(`d${i.id}`, i.id, "@draft")]);
    // 11 higher, 4 lower on the draft.
    const verdicts = inputs.flatMap((i, n) => [v(`b${i.id}`, "true", n < 11), v(`d${i.id}`, "true", n >= 11)]);
    const grid = { inputs, threads, verdicts };
    const r = versus(grid, cellsOf(grid), "live", "@draft");
    expect([r.up, r.down, r.same]).toEqual([11, 4, 0]);
    expect(verdictFor(r)).toBe("Maybe better");
    expect(verdictFor({ up: 17, down: 0, p: 0.00001 })).toBe("Clearly better");
    expect(verdictFor({ up: 7, down: 9, p: 0.8 })).toBe("No real difference");
    expect(verdictFor({ up: 0, down: 0, p: 1 })).toBe("No change");
  });
});
