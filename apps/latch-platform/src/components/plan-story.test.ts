import { describe, expect, it } from "vitest";
import { analyze, condQuestion, predicateWords, storyRows, summarize, type Plan } from "./plan-story";

/** The story's pure half: dependency edges from expressions, row grouping, wording. */

const plan: Plan = {
  steps: [
    { id: "h", call: "clockify_hours", args: { period: "=input.args" }, reason: "this week's hours" },
    { id: "prs", call: "github_prs", args: { state: "merged" } },
    { id: "busy", let: "h.filter(x => x.total > 30)" },
    { id: "guard", if: "busy.length === 0", return: "{ none: true }" },
    { id: "posted", call: "slack_post", args: { text: "=`${busy.length} busy`" }, after: ["prs"] },
  ],
};

describe("plan story", () => {
  it("infers dependencies from expressions, template holes and `after`", () => {
    const g = analyze(plan);
    expect(g.deps.h).toEqual([]);
    expect(g.deps.busy).toEqual(["h"]);
    expect(g.deps.guard).toEqual(["busy"]);
    expect(g.deps.posted.sort()).toEqual(["busy", "prs"]);
    // `input` is not a step, so it is not a dependency; a literal arg is not an expression.
    expect(g.deps.prs).toEqual([]);
  });

  it("groups independent consecutive steps into one row; guards get their own", () => {
    const rows = storyRows(analyze(plan)).map((r) => r.map((s) => s.id));
    expect(rows).toEqual([["h", "prs"], ["busy"], ["guard"], ["posted"]]);
  });

  it("puts conditions and predicates into words, falling back to the code", () => {
    expect(condQuestion("busy.length === 0")).toBe("Is busy empty?");
    expect(condQuestion("!owner")).toBe("Is owner missing?");
    expect(condQuestion("a > b")).toBe("Is it true that a > b?");
    expect(predicateWords("x => x.total > 30")).toBe("where total is more than 30");
    expect(predicateWords("i => !i.stale")).toBe("that are not stale");
    expect(predicateWords("i => i.a && i.b")).toBeNull();
  });

  it("summarizes values in one line", () => {
    expect(summarize([{ name: "Anna", total: 38 }, { name: "Bo", total: 12 }])).toBe("2 items of { name, total }");
    expect(summarize([])).toBe("empty list");
    expect(summarize({ since: 1, files: [] })).toBe("{ since, files }");
    expect(summarize("x".repeat(100))).toMatch(/…"$/);
    expect(summarize(7)).toBe("7");
  });
});
