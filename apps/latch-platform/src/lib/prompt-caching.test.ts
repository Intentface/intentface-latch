import { describe, expect, it } from "vitest";
import {
  markLastFunctionTool,
  mergeProviderOptions,
  promptCachingPlanFor,
  toolsetHash,
} from "@intentface/latch-core";
import { makeResolvePromptCaching } from "./prompt-caching";
import type { ModelInfo } from "./models";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

describe("promptCachingPlanFor", () => {
  it("anthropic gets all three breakpoints", () => {
    const plan = promptCachingPlanFor("anthropic", { agent: "helper" });
    expect(plan?.requestProviderOptions).toEqual(EPHEMERAL);
    expect(plan?.systemProviderOptions).toEqual(EPHEMERAL);
    expect(plan?.toolProviderOptions).toEqual(EPHEMERAL);
  });

  it("openai gets an agent-keyed cache routing key, principal-suffixed when asked", () => {
    expect(promptCachingPlanFor("openai", { agent: "helper" })).toEqual({
      requestProviderOptions: { openai: { promptCacheKey: "latch:agent:helper" } },
    });
    expect(
      promptCachingPlanFor("openai", { agent: "helper", cacheKeySuffix: "org/u1" })
        ?.requestProviderOptions,
    ).toEqual({ openai: { promptCacheKey: "latch:agent:helper:org/u1" } });
  });

  it("other/unknown providers get no plan", () => {
    expect(promptCachingPlanFor("google", { agent: "helper" })).toBeUndefined();
    expect(promptCachingPlanFor(undefined, { agent: "helper" })).toBeUndefined();
  });
});

describe("mergeProviderOptions", () => {
  it("preserves anthropic thinking alongside cacheControl (reasoning merge hazard)", () => {
    const merged = mergeProviderOptions(
      { anthropic: { thinking: { type: "enabled", budgetTokens: 2048 }, sendReasoning: true } },
      { anthropic: { cacheControl: { type: "ephemeral" } } },
    );
    expect(merged).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 2048 },
        sendReasoning: true,
        cacheControl: { type: "ephemeral" },
      },
    });
  });

  it("preserves openai reasoningEffort alongside promptCacheKey (shared provider key)", () => {
    const merged = mergeProviderOptions(
      { openai: { reasoningEffort: "high" } },
      { openai: { promptCacheKey: "latch:agent:a" } },
    );
    expect(merged).toEqual({
      openai: { reasoningEffort: "high", promptCacheKey: "latch:agent:a" },
    });
  });

  it("passes through single/absent sources", () => {
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
    const only = { anthropic: { thinking: { type: "disabled" } } };
    expect(mergeProviderOptions(only, undefined)).toBe(only);
  });
});

describe("markLastFunctionTool", () => {
  const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };

  it("marks the last function tool and preserves its fields", async () => {
    const execute = async () => "ok";
    const tools: Record<string, unknown> = {
      first: { description: "a", execute },
      last: { description: "b", execute },
    };
    expect(markLastFunctionTool(tools, cache)).toBe("last");
    const marked = tools.last as { providerOptions: unknown; execute: () => Promise<string>; description: string };
    expect(marked.providerOptions).toEqual(cache);
    expect(marked.description).toBe("b");
    await expect(marked.execute()).resolves.toBe("ok");
    expect((tools.first as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it("skips provider-executed tools (they silently drop cache_control)", () => {
    const tools: Record<string, unknown> = {
      fn: { description: "a" },
      web_search: { type: "provider", id: "anthropic.web_search" },
    };
    expect(markLastFunctionTool(tools, cache)).toBe("fn");
  });

  it("skips tools filtered out by activeTools", () => {
    const tools: Record<string, unknown> = {
      kept: { description: "a" },
      dropped: { description: "b" },
    };
    expect(markLastFunctionTool(tools, cache, ["kept"])).toBe("kept");
  });

  it("merges with a tool's existing providerOptions", () => {
    const tools: Record<string, unknown> = {
      t: { description: "a", providerOptions: { anthropic: { foo: 1 } } },
    };
    markLastFunctionTool(tools, cache);
    expect((tools.t as { providerOptions: unknown }).providerOptions).toEqual({
      anthropic: { foo: 1, cacheControl: { type: "ephemeral" } },
    });
  });

  it("returns undefined when nothing is eligible", () => {
    expect(markLastFunctionTool({}, cache)).toBeUndefined();
    expect(
      markLastFunctionTool({ w: { type: "provider" } }, cache),
    ).toBeUndefined();
  });
});

describe("toolsetHash", () => {
  it("is order-insensitive and set-sensitive", () => {
    expect(toolsetHash(["b", "a"])).toBe(toolsetHash(["a", "b"]));
    expect(toolsetHash(["a", "b"])).not.toBe(toolsetHash(["a", "b", "c"]));
    expect(toolsetHash([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("makeResolvePromptCaching", () => {
  const models: ModelInfo[] = [
    { id: "claude-sonnet-4-6", label: "Sonnet", provider: "anthropic" },
    { id: "gpt-5.1", label: "GPT", provider: "openai" },
    { id: "gemini-2.5-pro", label: "Gemini", provider: "google" },
  ];
  const resolve = makeResolvePromptCaching(models, (p: { org: string }) => p.org);
  const args = { agent: "helper", memoryScoped: false, principal: { org: "acme" } };

  it("resolves providers from the catalog", () => {
    expect(resolve("claude-sonnet-4-6", args)?.systemProviderOptions).toEqual(EPHEMERAL);
    expect(resolve("gpt-5.1", args)?.requestProviderOptions).toEqual({
      openai: { promptCacheKey: "latch:agent:helper" },
    });
    expect(resolve("gemini-2.5-pro", args)).toBeUndefined();
  });

  it("falls back to id prefixes for models missing from the catalog", () => {
    expect(resolve("claude-fable-5", args)?.systemProviderOptions).toEqual(EPHEMERAL);
    expect(resolve("o4-mini", args)?.requestProviderOptions).toEqual({
      openai: { promptCacheKey: "latch:agent:helper" },
    });
    expect(resolve("mistral-large", args)).toBeUndefined();
  });

  it("scopes the openai cache key per principal for memory-enabled agents", () => {
    expect(
      resolve("gpt-5.1", { ...args, memoryScoped: true })?.requestProviderOptions,
    ).toEqual({ openai: { promptCacheKey: "latch:agent:helper:acme" } });
  });
});
