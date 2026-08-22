import { describe, expect, it } from "vitest";
import { slackManifest } from "./manifest.js";

const BASE = {
  displayName: "Edge Advisor",
  requestUrl: "https://example.com/api/slack",
  redirectUrl: "https://example.com/api/slack/oauth",
};

const descriptionOf = (m: Record<string, unknown>): string =>
  (m.display_information as { description: string }).description;

describe("slackManifest description", () => {
  it("keeps a short description verbatim", () => {
    const m = slackManifest({ ...BASE, description: "Advises on edges." });
    expect(descriptionOf(m)).toBe("Advises on edges.");
  });

  it("fits the create-app wizard's 100-char short-description limit, not the documented 140", () => {
    // Regression, exact: this live 124-char agent description passed our old
    // slice(0, 140) and was still rejected by Slack's wizard as "too long",
    // leaving its confirm button disabled with no visible error.
    const observed =
      "Edge advise stage — the product. Reasons over IF's knowledge plane " +
      "(read-only, via edge-kn) and a client's own context plane";
    const d = descriptionOf(slackManifest({ ...BASE, description: observed }));
    expect(d).toBe(
      "Edge advise stage — the product. Reasons over IF's knowledge plane (read-only, via edge-kn) and a…",
    );
    expect(d.length).toBeLessThanOrEqual(100);
  });

  it("trims at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(40).trim(); // 199 chars of clean words
    const d = descriptionOf(slackManifest({ ...BASE, description: long }));
    expect(d).toBe(`${"word ".repeat(18)}word…`); // 19 whole words survive; the 20th (cut mid-word) is dropped
    expect(d.length).toBeLessThanOrEqual(100);
  });

  it("breaks at any whitespace, not just spaces", () => {
    const nl =
      "first line of the description text here padded to be long enough\n" +
      "second line continues with more words to overflow the limit for sure";
    const d = descriptionOf(slackManifest({ ...BASE, description: nl }));
    expect(d).toBe(
      "first line of the description text here padded to be long enough\nsecond line continues with more…",
    );
  });

  it("still caps a single unbroken token hard", () => {
    const d = descriptionOf(slackManifest({ ...BASE, description: "x".repeat(300) }));
    expect(d).toBe(`${"x".repeat(99)}…`);
    expect(d.length).toBe(100);
  });

  it("never ends the cut on a lone surrogate", () => {
    // The 🚀 straddles the raw cut point (code units 98-99): a naive slice
    // ships half a surrogate pair in the manifest.
    const d = descriptionOf(
      slackManifest({ ...BASE, description: `${"a".repeat(98)}🚀rest of text` }),
    );
    expect(d).toBe(`${"a".repeat(98)}…`);
    // Round-trips through UTF-8 without replacement characters.
    expect(new TextDecoder().decode(new TextEncoder().encode(d))).toBe(d);
  });
});
