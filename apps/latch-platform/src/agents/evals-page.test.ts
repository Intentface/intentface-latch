import { describe, expect, it } from "vitest";
import { pageSection } from "./evals";

describe("what the Evals agent is told about the page", () => {
  it("names the agent, set, view, columns and what is open", () => {
    const s = pageSection({
      evalsPage: {
        agent: "weather-agent",
        page: "results",
        questionSet: "ds_core-weather-questions-v1",
        checks: "core-weather-questions-v1",
        view: { name: "Forecasts", tags: ["forecast"] },
        columns: [
          { label: "live", runId: "run_a", version: "live", role: "baseline" },
          { label: "live · haiku-4-5", runId: "run_b", version: "live · haiku-4-5", role: "compared" },
        ],
        openAnswer: { inputId: "3", column: "live · haiku-4-5" },
      },
    });
    expect(s).toContain("Agent under test: weather-agent · question set ds_core-weather-questions-v1 · checks core-weather-questions-v1 · on the results page");
    expect(s).toContain("View: Forecasts — only inputs tagged forecast");
    expect(s).toContain("live (run run_a, version live, baseline); live · haiku-4-5 (run run_b, version live · haiku-4-5, compared with the baseline)");
    expect(s).toContain("Open: the answer to input 3 on live · haiku-4-5");
    expect(s).toContain("don't ask which agent");
  });

  it("adds nothing when the request carries no page — a chat outside the Evals pages", () => {
    expect(pageSection(undefined)).toBe("");
    expect(pageSection({ message: {} })).toBe("");
  });
});
