import { describe, expect, it } from "vitest";
import { providerFromId, providerOf } from "./provider.js";
import { makeResolveReasoningOptions } from "./reasoning.js";
import { makeResolvePromptCaching } from "./prompt-caching.js";
import { loadModelCatalog, programmaticToolCalling } from "./catalog.js";
import { providerDefaults } from "./defaults.js";
import type { ModelInfo } from "./catalog.js";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

const models: ModelInfo[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet", provider: "anthropic", reasoning: true, maxOutput: 64000 },
  { id: "gpt-5.1", label: "GPT", provider: "openai", reasoning: true },
  { id: "gemini-2.5-pro", label: "Gemini", provider: "google", reasoning: true, maxOutput: 65536 },
  { id: "flat-model", label: "Flat", provider: "anthropic", reasoning: false },
  { id: "custom-alias", label: "Custom", provider: "openai" },
];

describe("programmaticToolCalling", () => {
  it("is Opus and Sonnet from 4.6 and Claude 5, never Haiku or an unknown model", () => {
    for (const id of ["claude-sonnet-4-6", "claude-opus-4-7", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"]) expect(programmaticToolCalling(id)).toBe(true);
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-3-7-sonnet", "gpt-5.6"]) expect(programmaticToolCalling(id)).toBe(false);
  });
});

describe("providerOf — one heuristic for every provider-specific hook", () => {
  it("infers from id prefixes", () => {
    expect(providerFromId("claude-fable-5")).toBe("anthropic");
    expect(providerFromId("gpt-5.5")).toBe("openai");
    expect(providerFromId("o4-mini")).toBe("openai");
    expect(providerFromId("gemini-2.5-flash")).toBe("google");
    expect(providerFromId("gemma-3")).toBe("google");
    expect(providerFromId("mistral-large")).toBeUndefined();
    // Not everything starting with "o" is OpenAI.
    expect(providerFromId("ollama-thing")).toBeUndefined();
  });

  it("prefers the catalog over the prefix", () => {
    expect(providerOf("custom-alias", models)).toBe("openai");
    expect(providerOf("claude-x", models)).toBe("anthropic");
    expect(providerOf("mistral-large", models)).toBeUndefined();
  });
});

describe("makeResolveReasoningOptions", () => {
  const resolve = makeResolveReasoningOptions(models);

  it("maps effort to each provider's shape", () => {
    expect(resolve("gpt-5.1", "high")).toEqual({ providerOptions: { openai: { reasoningEffort: "high" } } });
    const a = resolve("claude-sonnet-4-6", "medium")!;
    expect(a.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 }, sendReasoning: true },
    });
    expect(a.maxOutputTokens).toBe(8192 + 8192);
    const g = resolve("gemini-2.5-pro", "low")!;
    expect(g.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
    });
  });

  it("minimal disables Anthropic thinking; the budget is capped under the model's max output", () => {
    expect(resolve("claude-sonnet-4-6", "minimal")).toEqual({
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
    });
    const small = makeResolveReasoningOptions([
      { id: "tiny", label: "t", provider: "anthropic", reasoning: true, maxOutput: 4000 },
    ]);
    const r = small("tiny", "high")!;
    // budget = min(16384, max(1024, floor(4000/2))) = 2000; maxOutputTokens = min(4000, 2000 + 8192)
    expect((r.providerOptions as { anthropic: { thinking: { budgetTokens: number } } }).anthropic.thinking.budgetTokens).toBe(2000);
    expect(r.maxOutputTokens).toBe(4000);
  });

  it("non-reasoning or unknown-effort: no thinking config, but Anthropic/Google max_tokens is lifted", () => {
    expect(resolve("flat-model", "high")).toEqual({ maxOutputTokens: 32_000 });
    expect(resolve("claude-sonnet-4-6", "bogus")).toEqual({ maxOutputTokens: 32_000 });
    expect(resolve("gpt-5.1", "bogus")).toBeUndefined();
    expect(resolve("not-in-catalog", "high")).toBeUndefined();
  });
});

describe("makeResolvePromptCaching", () => {
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
    expect(resolve("gpt-5.1", { ...args, memoryScoped: true })?.requestProviderOptions).toEqual({
      openai: { promptCacheKey: "latch:agent:helper:acme" },
    });
    // Without a principalKey the memory-scoped turn shares the agent key.
    const noKey = makeResolvePromptCaching(models);
    expect(noKey("gpt-5.1", { ...args, memoryScoped: true })?.requestProviderOptions).toEqual({
      openai: { promptCacheKey: "latch:agent:helper" },
    });
  });
});

describe("loadModelCatalog", () => {
  const modelsDev = {
    anthropic: {
      env: ["TEST_ANTHROPIC_KEY"],
      models: {
        "claude-sonnet-4-6": {
          name: "Claude Sonnet 4.6",
          reasoning: true,
          limit: { output: 64000 },
          cost: {
            input: 3,
            output: 15,
            cache_read: 0.3,
            tiers: [{ tier: { type: "context", size: 200000 }, input: 6, output: 22.5 }],
          },
        },
      },
    },
    openai: { env: ["TEST_OPENAI_KEY"], models: { "gpt-5.1": { name: "GPT-5.1", cost: { input: 1, output: 2 } } } },
  };
  const fetchOk = (async () => new Response(JSON.stringify(modelsDev))) as unknown as typeof fetch;

  it("includes only providers whose key env is set, with pricing (incl. the long-context tier)", async () => {
    process.env.TEST_ANTHROPIC_KEY = "x";
    delete process.env.TEST_OPENAI_KEY;
    const catalog = await loadModelCatalog({ url: "https://test/a", fetch: fetchOk });
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
    expect(catalog.models[0]).toMatchObject({ provider: "anthropic", reasoning: true, maxOutput: 64000 });
    expect(catalog.pricing("claude-sonnet-4-6")).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      tier: { thresholdTokens: 200000, inputPer1M: 6, outputPer1M: 22.5 },
    });
    expect(catalog.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("falls back to the static list when models.dev is unavailable — same keyed+installed rule", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const fetchFail = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const catalog = await loadModelCatalog({ url: "https://test/b", fetch: fetchFail, defaultModel: "gpt-4o" });
    // Google is installed but not keyed → excluded, like online.
    expect(catalog.models.map((m) => m.id).sort()).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
    expect(catalog.pricing("gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10 });
    expect(catalog.defaultModel).toBe("gpt-4o");
    // Native web tools come from the lazily loaded SDKs, keyed consistently;
    // unknown ids default to the default model's provider (openai here).
    expect(Object.keys(catalog.providerTools("gpt-4o"))).toEqual(["web_search"]);
    expect(Object.keys(catalog.providerTools("claude-sonnet-4-6")).sort()).toEqual(["web_fetch", "web_search"]);
    expect(Object.keys(catalog.providerTools("mistral-large"))).toEqual(["web_search"]);
    // Haiku can't take tools called from code execution: it gets the direct-only versions.
    const idOf = (model: string) => Object.values(catalog.providerTools(model)).map((t) => (t as { id: string }).id).sort();
    expect(idOf("claude-haiku-4-5")).toEqual(["anthropic.web_fetch_20250910", "anthropic.web_search_20250305"]);
    expect(idOf("claude-sonnet-5")).toEqual(["anthropic.web_fetch_20260209", "anthropic.web_search_20260209"]);
    // modelFor resolves known ids to their provider and unknown ids to the default.
    expect((catalog.modelFor("claude-sonnet-4-6") as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
    expect((catalog.modelFor("nope") as { modelId: string }).modelId).toBe("gpt-4o");
  });

  it("memoizes per option set AND per fetch implementation", async () => {
    process.env.TEST_ANTHROPIC_KEY = "x";
    const a = loadModelCatalog({ url: "https://test/c", fetch: fetchOk });
    const b = loadModelCatalog({ url: "https://test/c", fetch: fetchOk });
    expect(a).toBe(b);
    expect(loadModelCatalog({ url: "https://test/c", fetch: fetchOk, defaultModel: "claude-sonnet-4-6" })).not.toBe(a);
    const otherFetch = (async () => new Response(JSON.stringify(modelsDev))) as unknown as typeof fetch;
    expect(loadModelCatalog({ url: "https://test/c", fetch: otherFetch })).not.toBe(a);
  });

  it("picks a RUNNABLE implicit default: Sonnet when Anthropic is keyed, else the first listed model", async () => {
    delete process.env.TEST_ANTHROPIC_KEY;
    process.env.TEST_OPENAI_KEY = "x";
    const catalog = await loadModelCatalog({ url: "https://test/e", fetch: fetchOk });
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-5.1"]);
    expect(catalog.defaultModel).toBe("gpt-5.1");
    expect((catalog.modelFor("unknown-id") as { modelId: string }).modelId).toBe("gpt-5.1");
    // Offline, Google-only: the fallback still has a runnable default.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";
    const fetchFail = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const g = await loadModelCatalog({ url: "https://test/f", fetch: fetchFail });
    expect(g.models.map((m) => m.id)).toEqual(["gemini-2.5-pro"]);
    expect(g.defaultModel).toBe("gemini-2.5-pro");
    expect(Object.keys(g.providerTools("gemini-2.5-pro")).sort()).toEqual(["web_fetch", "web_search"]);
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  it("rejects an explicit default whose provider is not runnable here", async () => {
    delete process.env.TEST_ANTHROPIC_KEY;
    process.env.TEST_OPENAI_KEY = "x";
    await expect(
      loadModelCatalog({ url: "https://test/g", fetch: fetchOk, defaultModel: "claude-sonnet-4-6" }),
    ).rejects.toThrow(/default model "claude-sonnet-4-6" is not runnable/);
    // …and the failure isn't memoized: fixing the env makes the next call succeed.
    process.env.TEST_ANTHROPIC_KEY = "x";
    const ok = await loadModelCatalog({ url: "https://test/g", fetch: fetchOk, defaultModel: "claude-sonnet-4-6" });
    expect(ok.defaultModel).toBe("claude-sonnet-4-6");
  });
});

describe("providerDefaults", () => {
  it("bundles the four hooks; promptCaching:false turns caching off", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    const catalog = await loadModelCatalog({
      url: "https://test/d",
      fetch: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch,
    });
    const d = providerDefaults<{ org: string }>(catalog, { principalKey: (p) => p.org });
    expect(d.pricing).toBe(catalog.pricing);
    expect(d.resolveProviderTools).toBe(catalog.providerTools);
    expect(d.resolveReasoningOptions!("claude-sonnet-4-6", "low")?.maxOutputTokens).toBe(2048 + 8192);
    expect(
      d.resolvePromptCaching!("gpt-4o", { agent: "a", memoryScoped: true, principal: { org: "acme" } })
        ?.requestProviderOptions,
    ).toEqual({ openai: { promptCacheKey: "latch:agent:a:acme" } });
    const off = providerDefaults(catalog, { promptCaching: false });
    expect(off.resolvePromptCaching!("gpt-4o", { agent: "a", memoryScoped: false, principal: {} })).toBeUndefined();
  });
});
