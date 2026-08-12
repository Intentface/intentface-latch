import { describe, expect, it } from "vitest";
import { extractionRunKey } from "./extraction-key.js";
import { EXTRACTION_PROMPT_VERSION } from "./prompts/extractor.js";

const WINDOW = [
  { seq: 0, role: "user", text: "I prefer running in the morning." },
  { seq: 1, role: "assistant", text: "Noted — morning runs it is." },
];

describe("extractionRunKey", () => {
  it("is deterministic for the same window", () => {
    expect(extractionRunKey(WINDOW)).toBe(extractionRunKey([...WINDOW]));
  });

  it("embeds the prompt version (bump-to-invalidate)", () => {
    expect(extractionRunKey(WINDOW)).toMatch(
      new RegExp(`^x${EXTRACTION_PROMPT_VERSION}:[0-9a-f]{16}$`),
    );
  });

  it("changes when any message content changes", () => {
    const edited = [WINDOW[0]!, { ...WINDOW[1]!, text: "Noted — evening runs it is." }];
    expect(extractionRunKey(edited)).not.toBe(extractionRunKey(WINDOW));
  });

  it("changes when the role changes", () => {
    const swapped = [{ ...WINDOW[0]!, role: "assistant" }, WINDOW[1]!];
    expect(extractionRunKey(swapped)).not.toBe(extractionRunKey(WINDOW));
  });

  it("is order-sensitive", () => {
    expect(extractionRunKey([WINDOW[1]!, WINDOW[0]!])).not.toBe(extractionRunKey(WINDOW));
  });

  it("ignores seq — a re-sequenced chat with identical content keys the same", () => {
    const resequenced = WINDOW.map((m, i) => ({ ...m, seq: i + 100 }));
    expect(extractionRunKey(resequenced)).toBe(extractionRunKey(WINDOW));
  });

  it("frames messages unambiguously (no concatenation collisions)", () => {
    expect(extractionRunKey([{ role: "user", text: "ab" }])).not.toBe(
      extractionRunKey([{ role: "usera", text: "b" }]),
    );
    expect(
      extractionRunKey([
        { role: "user", text: "a" },
        { role: "user", text: "b" },
      ]),
    ).not.toBe(extractionRunKey([{ role: "user", text: "auser b" }]));
  });

  it("a schema fingerprint changes the key; the same fingerprint keys the same", () => {
    const bare = extractionRunKey(WINDOW);
    const withFp = extractionRunKey(WINDOW, { schemaFingerprint: "abc123" });
    expect(withFp).not.toBe(bare);
    expect(withFp).toBe(extractionRunKey([...WINDOW], { schemaFingerprint: "abc123" }));
    expect(extractionRunKey(WINDOW, { schemaFingerprint: "def456" })).not.toBe(withFp);
  });
});
