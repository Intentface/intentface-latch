import { describe, expect, it } from "vitest";
import {
  INDEX_LINE_HARD_CAP,
  memoryIdsIn,
  mintMemoryId,
  parseIndex,
  validateIndexRewrite,
} from "./index-file.js";

const SAMPLE = `# Memory — running-coach · u-usr1
updated: 2026-07-27 · entries: 3

## Identity & preferences
- [m-7f3a2c] (2026-07-12, user-said) Prefers concise answers. ← episodes/2026-07-12-09-30-onboarding.md
- [m-a1c2b3] (2026-07-20, tool-derived) Threshold pace ~5:15/km. ← episodes/2026-07-20-14-05-tempo.md, episodes/2026-07-22-08-00-intervals.md

## Archive
- [m-991100] (2026-06-02, user-said; superseded 2026-07-20 by m-a1c2b3) Threshold pace ~5:30/km. ← episodes/2026-06-02-10-00-test.md
`;

describe("parseIndex", () => {
  it("parses entries with dates, provenance, sources, and archive state", () => {
    const parsed = parseIndex(SAMPLE);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.malformed).toHaveLength(0);

    const [a, b, c] = parsed.entries;
    expect(a).toMatchObject({
      id: "m-7f3a2c",
      date: "2026-07-12",
      provenance: "user-said",
      archived: false,
      sources: ["episodes/2026-07-12-09-30-onboarding.md"],
    });
    expect(a.text).toBe("Prefers concise answers.");
    expect(b.sources).toHaveLength(2);
    expect(c.archived).toBe(true);
    expect(c.superseded).toEqual({ date: "2026-07-20", by: "m-a1c2b3" });
  });

  it("parses aka: aliases and the unverified trust mark from the parenthetical tail", () => {
    const parsed = parseIndex(
      [
        "- [m-4b9d11] (2026-07-25, user-said; aka: Robert Smith, Bob) Bob is the new team lead. ← episodes/d.md",
        "- [m-5c0e22] (2026-07-26, tool-derived; unverified) Threshold pace ~5:15/km. ← episodes/e.md",
        "- [m-6d1f33] (2026-07-27, tool-derived; aka: ACME; unverified; superseded 2026-07-28 by m-4b9d11) Old. ← episodes/f.md",
      ].join("\n"),
    );
    expect(parsed.malformed).toHaveLength(0);
    const [a, b, c] = parsed.entries;
    expect(a).toMatchObject({ aliases: ["Robert Smith", "Bob"], unverified: false });
    expect(a!.raw).toContain("[m-4b9d11]");
    expect(b).toMatchObject({ aliases: [], unverified: true });
    expect(c).toMatchObject({
      aliases: ["ACME"],
      unverified: true,
      superseded: { date: "2026-07-28", by: "m-4b9d11" },
    });
  });

  it("plain entries default to no aliases and verified", () => {
    const [entry] = parseIndex(SAMPLE).entries;
    expect(entry).toMatchObject({ aliases: [], unverified: false });
  });

  it("flags entry-shaped lines that do not parse", () => {
    const parsed = parseIndex("- [m-abc] no parenthetical here");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.malformed).toHaveLength(1);
  });

  it("accepts model-minted non-hex ids (regression: m-g8d7e9 rewrite loop)", () => {
    // The consolidator model mints ids itself; "hex-looking" ids with g-z
    // letters must parse — rejecting them looped the model on rewrites.
    const parsed = parseIndex(
      "- [m-g8d7e9] (2026-07-29, tool-derived; unverified) Recommended beginner gels: Maurten 100, SiS Go Isotonic (no caffeine) ← episodes/2026-07-29-06-42-gels.md\n" +
        "- [m-h2c4f5] (2026-07-29, tool-derived; superseded 2026-07-30 by m-zz99aa) Old strategy. ← episodes/old.md\n",
    );
    expect(parsed.malformed).toHaveLength(0);
    expect(parsed.entries.map((e) => e.id)).toEqual(["m-g8d7e9", "m-h2c4f5"]);
    expect(parsed.entries[1]!.superseded).toMatchObject({ by: "m-zz99aa" });
    expect(memoryIdsIn(parsed.entries[0]!.raw)).toEqual(["m-g8d7e9"]);
  });

  it("does not truncate an overlong supersession id into a wrong pointer", () => {
    const [entry] = parseIndex(
      "- [m-9911aa] (2026-06-02, user-said; superseded 2026-07-20 by m-abcdefghi) Old. ← episodes/old.md",
    ).entries;
    expect(entry!.superseded).toMatchObject({ date: "2026-07-20", by: undefined });
  });

  it("ignores prose and headings", () => {
    const parsed = parseIndex("# Title\nsome prose\n- a plain bullet\n");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.malformed).toHaveLength(0);
  });
});

describe("validateIndexRewrite", () => {
  it("accepts a valid rewrite that archives an active entry", () => {
    const next = SAMPLE.replace(
      "- [m-7f3a2c] (2026-07-12, user-said) Prefers concise answers. ← episodes/2026-07-12-09-30-onboarding.md\n",
      "",
    ).replace(
      "## Archive",
      "## Archive\n- [m-7f3a2c] (2026-07-12, user-said; superseded 2026-07-27) Prefers concise answers. ← episodes/2026-07-12-09-30-onboarding.md",
    );
    expect(validateIndexRewrite(SAMPLE, next)).toEqual([]);
  });

  it("rejects silently deleting an ACTIVE entry", () => {
    const next = SAMPLE.replace(/- \[m-7f3a2c\].*\n/, "");
    const problems = validateIndexRewrite(SAMPLE, next);
    expect(problems.join(" ")).toContain("m-7f3a2c");
  });

  it("allows dropping a previously ARCHIVED entry (history lives in snapshots)", () => {
    const next = SAMPLE.replace(/- \[m-991100\].*\n/, "");
    expect(validateIndexRewrite(SAMPLE, next)).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    const next = SAMPLE + "\n- [m-7f3a2c] (2026-07-27, user-said) Dup. ← episodes/x.md";
    expect(validateIndexRewrite(SAMPLE, next).join(" ")).toContain("duplicate");
  });

  it("rejects rewrites past the hard line cap", () => {
    const long = SAMPLE + Array(INDEX_LINE_HARD_CAP).fill("filler line").join("\n");
    expect(validateIndexRewrite(SAMPLE, long).join(" ")).toContain("hard cap");
  });

  it("accepts the first write (no previous index)", () => {
    expect(validateIndexRewrite(undefined, SAMPLE)).toEqual([]);
  });

  it("rejects malformed entry lines", () => {
    const next = SAMPLE + "\n- [m-deadbe] broken";
    expect(validateIndexRewrite(SAMPLE, next).join(" ")).toContain("malformed");
  });

  it("accepts entries carrying aka:/unverified markers", () => {
    const next =
      SAMPLE +
      "- [m-4b9d11] (2026-07-27, tool-derived; aka: Bob, Robert; unverified) New lead. ← episodes/d.md\n";
    expect(validateIndexRewrite(SAMPLE, next)).toEqual([]);
  });
});

describe("helpers", () => {
  it("mintMemoryId avoids taken ids and matches the grammar", () => {
    const taken = new Set(["m-000000"]);
    const id = mintMemoryId(taken);
    expect(id).toMatch(/^m-[0-9a-f]{6}$/);
    expect(taken.has(id)).toBe(false);
  });

  it("memoryIdsIn extracts unique ids", () => {
    expect(memoryIdsIn("see [m-7f3a2c] and [m-7f3a2c] and [m-a1c2b3]")).toEqual([
      "m-7f3a2c",
      "m-a1c2b3",
    ]);
  });
});
