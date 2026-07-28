import { describe, expect, it } from "vitest";
import { createSafetyOf, entryEvidence, normalizeForMatch } from "./search-evidence.js";

describe("normalizeForMatch", () => {
  it("trims, lowercases, collapses whitespace, and applies NFKC", () => {
    expect(normalizeForMatch("  Robert   Smith ")).toBe("robert smith");
    // NFKC: fullwidth latin and ligatures fold to their plain forms.
    expect(normalizeForMatch("Ｒｏｂｅｒｔ")).toBe("robert");
    expect(normalizeForMatch("ﬁle")).toBe("file");
  });
});

describe("entryEvidence", () => {
  const entry = {
    aliases: ["Robert Smith", "Bob"],
    text: "Bob is the new team lead for the Acme migration.",
  };

  it("returns alias-exact for a normalized exact alias match", () => {
    expect(entryEvidence("bob", entry)).toBe("alias-exact");
    expect(entryEvidence("  ROBERT   SMITH ", entry)).toBe("alias-exact");
    expect(entryEvidence("Ｂｏｂ", entry)).toBe("alias-exact");
  });

  it("returns description for a substring hit in the fact text", () => {
    expect(entryEvidence("acme migration", entry)).toBe("description");
    expect(entryEvidence("team lead", entry)).toBe("description");
  });

  it("prefers alias-exact over description (strongest signal wins)", () => {
    // "Bob" is both an alias and a substring of the text.
    expect(entryEvidence("Bob", entry)).toBe("alias-exact");
  });

  it("returns undefined for no evidence, empty, or too-short queries", () => {
    expect(entryEvidence("marathon", entry)).toBeUndefined();
    expect(entryEvidence("", entry)).toBeUndefined();
    expect(entryEvidence("   ", entry)).toBeUndefined();
    // "is" appears in the text but 2-char substrings prove nothing.
    expect(entryEvidence("is", entry)).toBeUndefined();
  });

  it("does not treat a partial alias hit as exact", () => {
    expect(entryEvidence("Robert", entry)).toBeUndefined();
  });
});

describe("createSafetyOf", () => {
  it("maps evidence to safety: exact → exists, description → probable, else unknown", () => {
    expect(createSafetyOf(["body", "alias-exact", "description"])).toBe("exists");
    expect(createSafetyOf(["body", "description"])).toBe("probable");
    expect(createSafetyOf(["body", "body"])).toBe("unknown");
    expect(createSafetyOf([])).toBe("unknown");
  });
});
