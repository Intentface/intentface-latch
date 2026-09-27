import { describe, expect, it } from "vitest";
import { configDiff, configOf, lineDiff, sideBySide } from "./diff";

const base = { instructions: "Be brief.\nAnswer in Celsius.", modelId: "claude-sonnet-5", maxSteps: 20, connections: ["Weather"], tools: null, exec: { providerWebTools: true } };

describe("what a column changed", () => {
  it("names a model switch and nothing else when only the model moved", () => {
    expect(configDiff(base, { ...base, modelId: "claude-haiku-4-5" }).map((c) => c.summary)).toEqual(["model → haiku-4-5"]);
  });

  it("counts instruction lines added and removed, and keeps them", () => {
    const [c] = configDiff(base, { ...base, instructions: "Be brief.\nAnswer in Fahrenheit.\nNever guess." });
    expect(c.summary).toBe("instructions +2 −1 lines");
    expect(c.lines).toEqual([
      { kind: "del", text: "Answer in Celsius." },
      { kind: "add", text: "Answer in Fahrenheit." },
      { kind: "add", text: "Never guess." },
    ]);
  });

  it("reads settings, connections and steps in words", () => {
    const d = configDiff(base, { ...base, maxSteps: 5, connections: ["Weather", "Calendar"], exec: { providerWebTools: false, effort: "high" } });
    expect(d.map((c) => c.summary)).toEqual(["connections +Calendar", "steps 20 → 5", "web tools off, effort → high"]);
  });

  it("finds nothing between the same setup, and no config in an old fingerprint", () => {
    expect(configDiff(base, { ...base })).toEqual([]);
    // Saved empty is the same agent as never set.
    expect(configDiff(base, { ...base, tools: { enabled: [], approval: {} }, exec: { providerWebTools: true, defaultTools: [] } })).toEqual([]);
    expect(configOf("A")).toBeNull();
    expect(lineDiff("a\nb", "a\nb")).toEqual([]);
  });
});

describe("instructions side by side", () => {
  it("puts a replaced line on the same row and marks the words that changed", () => {
    const rows = sideBySide("Be brief.\nAnswer in Celsius.", "Be brief.\nAnswer in Fahrenheit.\nNever guess.");
    expect(rows.map((r) => [r.kind, r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["same", "Be brief.", "Be brief."],
      ["change", "Answer in Celsius.", "Answer in Fahrenheit."],
      ["change", null, "Never guess."],
    ]);
    expect(rows[1].left!.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(["Celsius."]);
    expect(rows[1].right!.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(["Fahrenheit."]);
    expect(rows[1].right!.words!.map((w) => w.text).join("")).toBe("Answer in Fahrenheit.");
  });

  it("leaves a rewritten line unmarked word by word — the whole line changed", () => {
    const [row] = sideBySide("Do not answer in full.", "Run the whole procedure first, always.");
    expect(row.kind).toBe("change");
    expect(row.left!.words).toBeUndefined();
  });
});
