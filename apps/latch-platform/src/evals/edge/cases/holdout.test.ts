import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { allocate, drawHoldout, holdoutPool, type HoldoutRecord } from "./holdout";
import { QUESTIONS, byId } from "./questions";

describe("edge test set", () => {
  it("has 68 questions with unique ids: INSIGHTS 3, INFRA 28, AX 24, CODE 13", () => {
    expect(QUESTIONS.length).toBe(68);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(68);
    const n = (c: string) => QUESTIONS.filter((q) => q.category === c).length;
    expect([n("INSIGHTS"), n("INFRA"), n("AX"), n("CODE")]).toEqual([3, 28, 24, 13]);
  });

  it("marks exactly the seven Finnish end-user questions", () => {
    const fi = QUESTIONS.filter((q) => q.register === "end-user").map((q) => q.id).sort();
    expect(fi).toEqual(["AX-19", "AX-20", "AX-21", "AX-22", "AX-23", "AX-24", "INFRA-28"]);
    for (const q of QUESTIONS) expect(q.language === "fi").toBe(q.register === "end-user");
  });

  it("keeps INFRA-10 as a two-turn exchange", () => {
    expect(byId("INFRA-10").followup).toMatch(/actual recommendation/);
    expect(QUESTIONS.filter((q) => q.followup).length).toBe(1);
  });
});

describe("sealed holdout", () => {
  it("draws deterministically, stratified, from the client-team pool without INSIGHTS", () => {
    const pool = holdoutPool();
    expect(pool.length).toBe(68 - 7 - 3);
    const alloc = allocate(pool, 10);
    expect(Object.values(alloc).reduce((a, b) => a + b, 0)).toBe(10);
    expect(alloc.INSIGHTS).toBe(0);
    const a = drawHoldout();
    const b = drawHoldout();
    expect(a).toEqual(b);
    expect(a.length).toBe(10);
    for (const id of a) {
      const q = byId(id);
      expect(q.register).toBe("client-team");
      expect(q.category).not.toBe("INSIGHTS");
    }
  });

  it("reproduces the committed holdout.json byte for byte (the seal)", () => {
    const path = new URL("./holdout.json", import.meta.url);
    if (!existsSync(path)) return; // not sealed yet
    const sealed = JSON.parse(readFileSync(path, "utf8")) as HoldoutRecord;
    expect(drawHoldout(sealed.seed, sealed.size)).toEqual(sealed.holdout);
    expect(allocate(holdoutPool(), sealed.size)).toEqual(sealed.allocation);
  });
});
