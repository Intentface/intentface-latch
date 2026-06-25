import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { staticPricing, type Pricing, type ModelPrice } from "@intentface/latch-core";

/**
 * The model catalog, sourced from models.dev (the public model registry). We
 * include a provider's models when we have BOTH a provider factory for it AND
 * its API key is set (models.dev tells us the key env var) — so the dropdown
 * shows exactly what we can run, across providers, auto-updating as models ship.
 * Each model's `cost` (USD/1M) feeds the pricing seam. Adding a provider is one
 * line in PROVIDERS. Fetched once per process; static fallback if offline.
 */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
}

export interface ModelCatalog {
  models: ModelInfo[];
  pricing: Pricing;
  /** Resolve a model id → provider model (fallback: default). */
  modelFor: (id: string) => LanguageModel;
}

/** Providers we can actually run (factory). Inclusion also requires the key env (per models.dev). */
const PROVIDERS: Record<string, (id: string) => LanguageModel> = {
  anthropic: (id) => anthropic(id),
  openai: (id) => openai(id),
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROVIDER = "anthropic";

const FALLBACK: ModelCatalog = {
  models: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
    { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  ],
  pricing: staticPricing({
    "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  }),
  modelFor: (id) =>
    id.startsWith("gpt") || id.startsWith("o") ? openai(id) : anthropic(DEFAULT_MODEL),
};

interface MdCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}
interface MdProvider {
  env?: string[];
  models?: Record<
    string,
    {
      name?: string;
      cost?: MdCost & {
        tiers?: Array<MdCost & { tier?: { type?: string; size?: number } }>;
      };
    }
  >;
}

let cached: Promise<ModelCatalog> | undefined;

/** Load (and memoize) the model catalog from models.dev, across runnable providers. */
export function loadModelCatalog(): Promise<ModelCatalog> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetch("https://models.dev/api.json", { redirect: "error" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all = (await res.json()) as Record<string, MdProvider>;

      const list: ModelInfo[] = [];
      const rates: Record<string, ModelPrice> = {};
      const idToProvider = new Map<string, string>();

      for (const provider of Object.keys(PROVIDERS)) {
        const p = all[provider];
        // Need the provider's API key set (models.dev lists which env var).
        const keyed = (p?.env ?? []).some((e) => !!process.env[e]);
        if (!p?.models || !keyed) continue;
        for (const [id, m] of Object.entries(p.models)) {
          list.push({ id, label: m.name ?? id, provider });
          idToProvider.set(id, provider);
          if (m.cost?.input != null && m.cost?.output != null) {
            rates[id] = {
              inputPer1M: m.cost.input,
              outputPer1M: m.cost.output,
              ...(m.cost.cache_read != null ? { cacheReadPer1M: m.cost.cache_read } : {}),
              ...(m.cost.cache_write != null ? { cacheWritePer1M: m.cost.cache_write } : {}),
            };
            // Long-context tier (higher rates above a context size).
            const ct = (m.cost.tiers ?? []).find(
              (t) => t.tier?.type === "context" && t.tier?.size && t.input != null && t.output != null,
            );
            if (ct?.tier?.size) {
              rates[id].tier = {
                thresholdTokens: ct.tier.size,
                inputPer1M: ct.input!,
                outputPer1M: ct.output!,
                ...(ct.cache_read != null ? { cacheReadPer1M: ct.cache_read } : {}),
                ...(ct.cache_write != null ? { cacheWritePer1M: ct.cache_write } : {}),
              };
            }
          }
        }
      }
      if (list.length === 0) throw new Error("no runnable providers (no API keys?)");
      list.sort((a, b) => a.label.localeCompare(b.label));

      return {
        models: list,
        pricing: staticPricing(rates),
        modelFor: (id) => {
          const provider = idToProvider.get(id);
          return provider
            ? PROVIDERS[provider](id)
            : PROVIDERS[DEFAULT_PROVIDER](DEFAULT_MODEL);
        },
      };
    } catch (e) {
      console.warn("models.dev unavailable, using fallback list:", e instanceof Error ? e.message : e);
      return FALLBACK;
    }
  })();
  return cached;
}
