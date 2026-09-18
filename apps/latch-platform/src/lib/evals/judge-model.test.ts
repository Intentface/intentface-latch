import { describe, expect, it } from "vitest";
import { judgeModel, providerOf } from "./judge-model";

describe("judgeModel", () => {
  it("routes each id to its provider", () => {
    expect(providerOf("jev-latest")).toBe("typesafe-ai");
    expect(providerOf("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(providerOf("gpt-5.6-luna")).toBe("openai");
    expect(providerOf("gemini-3.5-flash-lite")).toBe("google");
  });

  it("builds models that all satisfy the same contract", () => {
    // The point of the whole design: swapping judges changes one string, and
    // nothing downstream can tell the difference.
    for (const id of ["jev-latest", "claude-haiku-4-5-20251001"]) {
      const m = judgeModel(id);
      expect(typeof m).not.toBe("string");
      if (typeof m === "string") throw new Error("unreachable");
      expect(m.specificationVersion).toBe("v4");
      expect(m.modelId).toBe(id);
      expect(m.supportedQuestionTypes.length).toBeGreaterThan(0);
      expect(typeof m.doEvaluate).toBe("function");
    }
  });

  it("names the two judges we actually compare", () => {
    const jev = judgeModel("jev-latest");
    const haiku = judgeModel("claude-haiku-4-5-20251001");
    if (typeof jev === "string" || typeof haiku === "string") throw new Error("unreachable");
    expect(jev.provider).toContain("typesafe");
    expect(haiku.provider).toContain("anthropic");
  });

  it("refuses an unknown id instead of guessing a provider", () => {
    // Guessing surfaces later as an authentication error from whichever
    // provider was picked, which is a miserable thing to debug.
    expect(() => judgeModel("llama-3")).toThrow(/No evaluation provider for judge "llama-3"/);
    expect(providerOf("llama-3")).toBeUndefined();
  });
});
