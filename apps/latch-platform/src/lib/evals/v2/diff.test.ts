import { describe, expect, it } from "vitest";
import { configDiff, configOf, lineDiff } from "./diff";

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
