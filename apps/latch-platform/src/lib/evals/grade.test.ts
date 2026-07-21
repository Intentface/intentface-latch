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
  it("passes contains case-insensitively", () => {
    const r = gradeCase(mk({ assertions: { contains: ["Refund Policy"] } }), "our refund policy is…", []);
    expect(r.pass).toBe(true);
  });

  it("fails with a reason when contains is missing", () => {
    const r = gradeCase(mk({ assertions: { contains: ["escalate"] } }), "here you go", []);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('missing "escalate"');
  });

  it("fails notContains when the string appears", () => {
    const r = gradeCase(mk({ assertions: { notContains: ["guarantee"] } }), "We GUARANTEE results", []);
    expect(r.pass).toBe(false);
  });

  it("applies regex and rejects invalid patterns without throwing", () => {
    expect(gradeCase(mk({ assertions: { regex: ["\\d{4}"] } }), "year 2026", []).pass).toBe(true);
    const bad = gradeCase(mk({ assertions: { regex: ["([)"] } }), "anything", []);
    expect(bad.pass).toBe(false);
    expect(bad.reasons[0]).toContain("invalid regex");
  });

  it("refuses catastrophic-backtracking regex shapes (ReDoS guard)", () => {
    for (const pattern of ["(a+)+$", "(a|aa)*b", "([a-z]*)+x", "a".repeat(201)]) {
      const r = gradeCase(mk({ assertions: { regex: [pattern] } }), "aaaaaaaaaaaaaaaaaaaaaaaaaaa!", []);
      expect(r.pass, `should refuse /${pattern.slice(0, 30)}/`).toBe(false);
      expect(r.reasons[0]).toContain("unsafe regex");
    }
    expect(isRiskyRegex("(abc)+")).toBe(false); // no inner quantifier — fine
    expect(isRiskyRegex("^hello \\d{1,3} world$")).toBe(false);
  });

  it("requires expected tool calls", () => {
    const calls: EvalToolCall[] = [{ tool: "save_lead", args: { source: "web" } }];
    expect(gradeCase(mk({ toolCalls: [{ tool: "save_lead" }] }), "", calls).pass).toBe(true);
    expect(gradeCase(mk({ toolCalls: [{ tool: "send_email" }] }), "", calls).pass).toBe(false);
  });

  it("matches tool args as a subset (any call may match)", () => {
    const calls: EvalToolCall[] = [
      { tool: "save_lead", args: { source: "phone", priority: 1 } },
      { tool: "save_lead", args: { source: "web", priority: 2 } },
    ];
    expect(gradeCase(mk({ toolCalls: [{ tool: "save_lead", args: { source: "web" } }] }), "", calls).pass).toBe(true);
    expect(gradeCase(mk({ toolCalls: [{ tool: "save_lead", args: { source: "mail" } }] }), "", calls).pass).toBe(false);
  });

  it("deep-equals nested arg values", () => {
    const calls: EvalToolCall[] = [{ tool: "t", args: { filter: { tags: ["a", "b"] } } }];
    expect(gradeCase(mk({ toolCalls: [{ tool: "t", args: { filter: { tags: ["a", "b"] } } }] }), "", calls).pass).toBe(
      true,
    );
    expect(gradeCase(mk({ toolCalls: [{ tool: "t", args: { filter: { tags: ["a"] } } }] }), "", calls).pass).toBe(
      false,
    );
  });

  it("fails when a forbidden tool was called", () => {
    const r = gradeCase(mk({ forbiddenTools: ["delete_user"] }), "", [{ tool: "delete_user" }]);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("must not call delete_user");
  });

  it("collects multiple failure reasons", () => {
    const r = gradeCase(
      mk({ assertions: { contains: ["x"], notContains: ["y"] }, toolCalls: [{ tool: "t" }] }),
      "y is here",
      [],
    );
    expect(r.pass).toBe(false);
    expect(r.reasons).toHaveLength(3);
  });
});
