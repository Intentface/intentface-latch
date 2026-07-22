import { describe, expect, it } from "vitest";
import { gradeCase, isRiskyRegex } from "./grade";
import type { EvalCase, EvalToolCall } from "./store";

const mk = (expected: EvalCase["expected"]): EvalCase => ({
  id: "c1",
  name: "case",
  input: "hi",
  expected,
});

describe("gradeCase", () => {
  it("passes contains case-insensitively", async () => {
    const r = await gradeCase(mk({ assertions: { contains: ["Refund Policy"] } }), "our refund policy is…", []);
    expect(r.pass).toBe(true);
  });

  it("fails with a reason when contains is missing", async () => {
    const r = await gradeCase(mk({ assertions: { contains: ["escalate"] } }), "here you go", []);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('missing "escalate"');
  });

  it("fails notContains when the string appears", async () => {
    const r = await gradeCase(mk({ assertions: { notContains: ["guarantee"] } }), "We GUARANTEE results", []);
    expect(r.pass).toBe(false);
  });

  it("applies regex and rejects invalid patterns without throwing", async () => {
    expect((await gradeCase(mk({ assertions: { regex: ["\\d{4}"] } }), "year 2026", [])).pass).toBe(true);
    const bad = await gradeCase(mk({ assertions: { regex: ["([)"] } }), "anything", []);
    expect(bad.pass).toBe(false);
    expect(bad.reasons[0]).toContain("invalid regex");
  });

  it("refuses catastrophic-backtracking regex shapes (static ReDoS guard)", async () => {
    for (const pattern of ["(a+)+$", "(a|aa)*b", "([a-z]*)+x", "(a?)*b", "a".repeat(201)]) {
      const r = await gradeCase(
        mk({ assertions: { regex: [pattern] } }),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaa!",
        [],
      );
      expect(r.pass, `should refuse /${pattern.slice(0, 30)}/`).toBe(false);
      expect(r.reasons[0]).toContain("unsafe regex");
    }
    expect(isRiskyRegex("(abc)+")).toBe(false); // no inner quantifier — fine
    expect(isRiskyRegex("^hello \\d{1,3} world$")).toBe(false);
  });

  it("kills a backtracking pattern that slips past the static guard (hard timeout)", async () => {
    // No groups, so the static pre-filter allows it — but on a long non-matching
    // input this backtracks for effectively forever. The worker must be killed.
    const pattern = `${"a*".repeat(25)}b`;
    const r = await gradeCase(mk({ assertions: { regex: [pattern] } }), "a".repeat(3000), []);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("timed out");
  });

  it("requires expected tool calls", async () => {
    const calls: EvalToolCall[] = [{ tool: "save_lead", args: { source: "web" } }];
    expect((await gradeCase(mk({ toolCalls: [{ tool: "save_lead" }] }), "", calls)).pass).toBe(true);
    expect((await gradeCase(mk({ toolCalls: [{ tool: "send_email" }] }), "", calls)).pass).toBe(false);
  });

  it("matches tool args as a subset (any call may match)", async () => {
    const calls: EvalToolCall[] = [
      { tool: "save_lead", args: { source: "phone", priority: 1 } },
      { tool: "save_lead", args: { source: "web", priority: 2 } },
    ];
    expect(
      (await gradeCase(mk({ toolCalls: [{ tool: "save_lead", args: { source: "web" } }] }), "", calls)).pass,
    ).toBe(true);
    expect(
      (await gradeCase(mk({ toolCalls: [{ tool: "save_lead", args: { source: "mail" } }] }), "", calls)).pass,
    ).toBe(false);
  });

  it("deep-equals nested arg values", async () => {
    const calls: EvalToolCall[] = [{ tool: "t", args: { filter: { tags: ["a", "b"] } } }];
    expect(
      (await gradeCase(mk({ toolCalls: [{ tool: "t", args: { filter: { tags: ["a", "b"] } } }] }), "", calls)).pass,
    ).toBe(true);
    expect(
      (await gradeCase(mk({ toolCalls: [{ tool: "t", args: { filter: { tags: ["a"] } } }] }), "", calls)).pass,
    ).toBe(false);
  });

  it("matches dynamic arg values via {$regex} matchers (incl. nested), literals stay strict", async () => {
    const calls: EvalToolCall[] = [
      { tool: "plan", args: { date: "2026-07-22", meta: { week: 30 }, load: 7 } },
    ];
    const pass = await gradeCase(
      mk({ toolCalls: [{ tool: "plan", args: { date: { $regex: "^2026-" }, load: { $regex: "^\\d$" } } }] }),
      "",
      calls,
    );
    expect(pass.pass).toBe(true);
    const nested = await gradeCase(
      mk({ toolCalls: [{ tool: "plan", args: { meta: { week: { $regex: "^3" } } } }] }),
      "",
      calls,
    );
    expect(nested.pass).toBe(true);
    const fail = await gradeCase(
      mk({ toolCalls: [{ tool: "plan", args: { date: { $regex: "^2025-" } } }] }),
      "",
      calls,
    );
    expect(fail.pass).toBe(false);
    // A matcher against an object/array value never passes.
    const objTarget = await gradeCase(
      mk({ toolCalls: [{ tool: "plan", args: { meta: { $regex: "week" } } }] }),
      "",
      calls,
    );
    expect(objTarget.pass).toBe(false);
  });

  it("refuses risky {$regex} matchers instead of running them", async () => {
    const r = await gradeCase(
      mk({ toolCalls: [{ tool: "t", args: { v: { $regex: "(a+)+$" } } }] }),
      "",
      [{ tool: "t", args: { v: "aaa" } }],
    );
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("unsafe regex matcher");
  });

  it("reports an invalid {$regex} matcher distinctly, not as a generic args mismatch", async () => {
    const r = await gradeCase(
      mk({ toolCalls: [{ tool: "t", args: { v: { $regex: "([)" } } }] }),
      "",
      [{ tool: "t", args: { v: "aaa" } }],
    );
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("invalid regex matcher");
  });

  it("enforces per-tool maxCalls", async () => {
    const calls: EvalToolCall[] = [{ tool: "web_fetch" }, { tool: "web_fetch" }, { tool: "web_fetch" }];
    expect((await gradeCase(mk({ toolCalls: [{ tool: "web_fetch", maxCalls: 3 }] }), "", calls)).pass).toBe(true);
    const r = await gradeCase(mk({ toolCalls: [{ tool: "web_fetch", maxCalls: 2 }] }), "", calls);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("called 3× (max 2)");
  });

  it("checks toolOrder as a subsequence (interleaved calls allowed)", async () => {
    const calls: EvalToolCall[] = [
      { tool: "orient" },
      { tool: "web_fetch" },
      { tool: "generate_plan" },
    ];
    expect((await gradeCase(mk({ toolOrder: ["orient", "generate_plan"] }), "", calls)).pass).toBe(true);
    const wrong = await gradeCase(mk({ toolOrder: ["generate_plan", "orient"] }), "", calls);
    expect(wrong.pass).toBe(false);
    expect(wrong.reasons[0]).toContain("out of order");
    // Duplicate names must each be matched in sequence.
    expect((await gradeCase(mk({ toolOrder: ["orient", "orient"] }), "", calls)).pass).toBe(false);
    expect((await gradeCase(mk({ toolOrder: ["orient", "generate_plan"] }), "", [])).pass).toBe(false);
  });

  it("enforces the case-level maxTotalToolCalls budget", async () => {
    const calls: EvalToolCall[] = [{ tool: "a" }, { tool: "b" }, { tool: "a" }];
    expect((await gradeCase(mk({ maxTotalToolCalls: 3 }), "", calls)).pass).toBe(true);
    const r = await gradeCase(mk({ maxTotalToolCalls: 2 }), "", calls);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("3 tool calls total (max 2)");
  });

  it("fails when a forbidden tool was called", async () => {
    const r = await gradeCase(mk({ forbiddenTools: ["delete_user"] }), "", [{ tool: "delete_user" }]);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("must not call delete_user");
  });

  it("collects multiple failure reasons", async () => {
    const r = await gradeCase(
      mk({ assertions: { contains: ["x"], notContains: ["y"] }, toolCalls: [{ tool: "t" }] }),
      "y is here",
      [],
    );
    expect(r.pass).toBe(false);
    expect(r.reasons).toHaveLength(3);
  });
});
