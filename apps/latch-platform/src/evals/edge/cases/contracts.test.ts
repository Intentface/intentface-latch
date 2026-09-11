import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONTRACTS, contractCriteria, contractFor } from "./contracts";
import { byId } from "./questions";

const holdout = (JSON.parse(readFileSync(new URL("./holdout.json", import.meta.url), "utf8")) as { holdout: string[] }).holdout;
const optimization = (JSON.parse(readFileSync(new URL("./selection.json", import.meta.url), "utf8")) as { optimization: string[] }).optimization;

describe("case contracts (guide Step 2)", () => {
  it("cover exactly the sealed 30: 20 optimization + 10 holdout, no duplicates", () => {
    const ids = CONTRACTS.map((c) => c.case_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...holdout, ...optimization].sort());
    expect(CONTRACTS.filter((c) => c.split === "holdout").map((c) => c.case_id).sort()).toEqual([...holdout].sort());
    expect(CONTRACTS.filter((c) => c.split === "optimization").map((c) => c.case_id).sort()).toEqual([...optimization].sort());
  });

  it("agree with the question set on category, and every field is filled", () => {
    for (const c of CONTRACTS) {
      expect(byId(c.case_id).category, c.case_id).toBe(c.category);
      expect(c.why_this_case_exists.length, c.case_id).toBeGreaterThan(40);
      for (const k of ["required_client_facts", "required_expert_ideas", "expected_recommendation_shape", "forbidden_behaviors", "known_ambiguities"] as const) {
        expect(c[k].length, `${c.case_id}.${k}`).toBeGreaterThan(0);
      }
      expect(Object.keys(c.risk_weights).length, c.case_id).toBeGreaterThan(0);
    }
  });

  it("renders criteria the judge can consume", () => {
    const text = contractCriteria(contractFor("AX-01"));
    expect(text).toContain("Required client facts");
    expect(text).toContain("Forbidden behaviours");
    expect(text).toContain("Approve by consequence");
  });
});
