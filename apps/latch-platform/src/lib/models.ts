import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { staticPricing, type Pricing } from "@intentface/latch-core";

/**
 * The model catalog, sourced from models.dev (the public model registry) instead
 * of a hardcoded list. We filter to Anthropic — the only provider we have an API
 * key + provider package for — so the dropdown shows what we can actually run,
 * auto-updating as new models ship. Their `cost` (USD per 1M tokens) also drives
 * the pricing seam, so cost tracking is accurate for any model, not 3 hardcoded
 * rates. Fetched once per process; falls back to a small static list if offline.
 */
export interface ModelInfo {
  id: string;
  label: string;
}

export interface ModelCatalog {
  models: ModelInfo[];
  pricing: Pricing;
  /** Resolve an allow-listed model id → provider model (fallback: default). */
  modelFor: (id: string) => LanguageModel;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

const FALLBACK: ModelCatalog = {
  models: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  pricing: staticPricing({
    "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25 },
    "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5 },
  }),
  modelFor: (id) => anthropic(buildAllowed(["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"], id)),
};

function buildAllowed(ids: string[], id: string): string {
  return ids.includes(id) ? id : DEFAULT_MODEL;
}

interface MdModel {
  name?: string;
  cost?: { input?: number; output?: number };
}

let cached: Promise<ModelCatalog> | undefined;

/** Load (and memoize) the Anthropic model catalog from models.dev. */
export function loadModelCatalog(): Promise<ModelCatalog> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetch("https://models.dev/api.json", { redirect: "error" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all = (await res.json()) as Record<string, { models?: Record<string, MdModel> }>;
      const models = all.anthropic?.models ?? {};
      const ids = Object.keys(models);
      if (ids.length === 0) throw new Error("no anthropic models");
      const rates: Record<string, { inputPer1M: number; outputPer1M: number }> = {};
      const list: ModelInfo[] = [];
      for (const [id, m] of Object.entries(models)) {
        list.push({ id, label: m.name ?? id });
        if (m.cost?.input != null && m.cost?.output != null) {
          rates[id] = { inputPer1M: m.cost.input, outputPer1M: m.cost.output };
        }
      }
      list.sort((a, b) => a.label.localeCompare(b.label));
      const allow = new Set(ids);
      return {
        models: list,
        pricing: staticPricing(rates),
        modelFor: (id) => anthropic(allow.has(id) ? id : DEFAULT_MODEL),
      };
    } catch (e) {
      console.warn("models.dev unavailable, using fallback list:", e instanceof Error ? e.message : e);
      return FALLBACK;
    }
  })();
  return cached;
}
