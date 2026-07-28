import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toPublicQuery } from "./seal.js";
import type { Qrel } from "./derive.js";
import { QRELS_PATH } from "../paths.js";

/**
 * Sealing guarantee: the projection handed to the search path carries id +
 * query text and NOTHING else — no relevance labels, no grades, no tier.
 */

describe("toPublicQuery", () => {
  const qrel: Qrel = {
    id: "q99",
    tier: "adversarial",
    query: "some text",
    relevant: [
      { name: "secret-target", grade: 3 },
      { name: "secret-related", grade: 1 },
    ],
    first_relevant: "secret-target",
  };

  it("keeps exactly {id, text}", () => {
    const pub = toPublicQuery(qrel);
    expect(pub).toEqual({ id: "q99", text: "some text" });
    expect(Object.keys(pub).sort()).toEqual(["id", "text"]);
  });

  it("strips every gold field, including unexpected extras", () => {
    const withExtra = { ...qrel, leaked_answer: "secret-target" } as Qrel;
    const json = JSON.stringify(toPublicQuery(withExtra));
    for (const marker of ["relevant", "first_relevant", "grade", "tier", "secret", "leaked"]) {
      expect(json).not.toContain(marker);
    }
  });

  it("strips gold from every committed qrel", () => {
    const qrels = JSON.parse(readFileSync(QRELS_PATH, "utf8")) as Qrel[];
    for (const entry of qrels) {
      const pub = toPublicQuery(entry);
      expect(Object.keys(pub).sort()).toEqual(["id", "text"]);
      const json = JSON.stringify(pub);
      expect(json).not.toContain('"relevant"');
      expect(json).not.toContain('"first_relevant"');
      expect(json).not.toContain('"grade"');
      expect(json).not.toContain('"tier"');
    }
  });
});
