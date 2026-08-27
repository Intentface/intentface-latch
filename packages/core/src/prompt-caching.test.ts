import { describe, expect, it } from "vitest";
import { defaultPromptCachingPlan, promptCachingPlanFor } from "./prompt-caching.js";

/**
 * The default-on story: with no `resolvePromptCaching` hook, the plan is
 * derived from the model object's own `provider` string. Measured at ~6x unit
 * cost on MCP-heavy agents, so "host never found the hook" must not mean
 * "host pays full price forever".
 */
describe("defaultPromptCachingPlan", () => {
  it("maps a first-party Anthropic model to the anthropic plan", () => {
    const plan = defaultPromptCachingPlan({ provider: "anthropic.messages" }, "crm");
    expect(plan).toEqual(promptCachingPlanFor("anthropic", { agent: "crm" }));
    expect(plan?.systemProviderOptions).toBeDefined();
    expect(plan?.toolProviderOptions).toBeDefined();
  });

  it("maps a first-party OpenAI model to the openai plan", () => {
    const plan = defaultPromptCachingPlan({ provider: "openai.responses" }, "crm");
    expect(plan?.requestProviderOptions).toEqual({
      openai: { promptCacheKey: "latch:agent:crm" },
    });
  });

  it("leaves unknown and third-party providers untouched", () => {
    // Bedrock/Vertex ids don't contain the first-party substrings — the
    // Anthropic plan's request-level cache_control is first-party only.
    expect(defaultPromptCachingPlan({ provider: "amazon-bedrock" }, "crm")).toBeUndefined();
    expect(defaultPromptCachingPlan({ provider: "google.vertex" }, "crm")).toBeUndefined();
    expect(defaultPromptCachingPlan({ provider: "mock-provider" }, "crm")).toBeUndefined();
  });

  it("tolerates model shapes with no provider at all", () => {
    expect(defaultPromptCachingPlan("claude-opus-5", "crm")).toBeUndefined();
    expect(defaultPromptCachingPlan(undefined, "crm")).toBeUndefined();
    expect(defaultPromptCachingPlan({}, "crm")).toBeUndefined();
  });
});
