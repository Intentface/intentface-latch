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
    // Regression: a live 124-char agent description passed our old
    // slice(0, 140) and was still rejected by Slack's wizard as "too long",
    // leaving its confirm button disabled with no visible error.
    const observed =
      "Edge advise stage — the product. Reasons over IF's knowledge plane " +
      "(read-only, via edge-kn) and a client's own context plane";
    const m = slackManifest({ ...BASE, description: observed });
    expect(descriptionOf(m).length).toBeLessThanOrEqual(100);
  });

  it("trims at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(40).trim(); // 199 chars of clean words
    const d = descriptionOf(slackManifest({ ...BASE, description: long }));
    expect(d.length).toBeLessThanOrEqual(100);
    expect(d.endsWith("…")).toBe(true);
    expect(d).not.toMatch(/wor…$/); // never cut mid-word when a boundary exists
  });

  it("still caps a single unbroken token hard", () => {
    const d = descriptionOf(slackManifest({ ...BASE, description: "x".repeat(300) }));
    expect(d.length).toBeLessThanOrEqual(100);
  });
});
