import { describe, expect, it } from "vitest";
import { matchChoice } from "./evaluation-model";

describe("matchChoice", () => {
  const names = ["grounded", "partly_grounded", "ungrounded"];
  it("takes the exact option, then ignores case and separators", () => {
    expect(matchChoice(names, "grounded")).toBe("grounded");
    expect(matchChoice(names, "Partly grounded")).toBe("partly_grounded");
    expect(matchChoice(names, "PARTLY-GROUNDED")).toBe("partly_grounded");
  });
  it("prefers the longest option it contains, so a failing label never reads as a passing one", () => {
    expect(matchChoice(names, "it is partly_grounded overall")).toBe("partly_grounded");
  });
  it("names none → null, never the first option", () => {
    expect(matchChoice(names, "unclear")).toBeNull();
    expect(matchChoice(names, "")).toBeNull();
  });
});
