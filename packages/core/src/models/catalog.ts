import type { LanguageModel } from "ai";
import { staticPricing } from "../pricing.js";
import type { ModelPrice, Pricing } from "../pricing.js";
import { PROVIDER_IDS, providerFromId, type ProviderId } from "./provider.js";

/**
 * The model catalog, sourced from models.dev (the public model registry). A
 * provider's models are included when its SDK is installed AND its API key is
 * set (models.dev tells us the key env var) — so a picker shows exactly what
 * this deployment can run, across providers, auto-updating as models ship.
 * Each model's `cost` (USD/1M) feeds the pricing seam. Fetched once per process
 * per option set; static fallback if offline.
 *
 * Provider SDKs are OPTIONAL peers of core and loaded lazily, per provider,
 * only when that provider is usable here — a host with one API key never
 * loads the other two SDKs, and core itself stays free of static provider
 * imports.
 */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  /** Whether the model supports reasoning/thinking (gates the effort knob). */
  reasoning?: boolean;
  /** Max output tokens (models.dev `limit.output`) — bounds the thinking budget. */
  maxOutput?: number;
}

export interface ModelCatalog {
  models: ModelInfo[];
  pricing: Pricing;
  /** Resolve a model id → provider model (unknown id → the default model). */
  modelFor: (id: string) => LanguageModel;
  /**
   * The provider's NATIVE web tools for a model id (server-side search/fetch),
   * keyed consistently (`web_search` / `web_fetch`) so prompts stay
   * provider-agnostic. `{}` when the provider has none or isn't loaded.
   */
  providerTools: (id: string) => Record<string, unknown>;
  /** The id `modelFor` falls back to. */
  defaultModel: string;
}

export interface ModelCatalogOptions {
  /** Providers to consider (default: all three). Inclusion still requires the SDK + key env. */
  providers?: readonly ProviderId[];
  /** The model unknown ids resolve to (default: claude-sonnet-4-6). */
  defaultModel?: string;
  /** models.dev endpoint override (tests / mirrors). */
  url?: string;
  /** Fetch override (tests). */
  fetch?: typeof fetch;
}

/** What core needs from one provider SDK, loaded on demand. */
interface ProviderFactory {
  model: (id: string) => LanguageModel;
  webTools: () => Record<string, unknown>;
}

/**
 * Lazy SDK loaders — the ONLY place a provider package is named. Each import
 * resolves against the host's node_modules (optional peer), so a missing SDK
 * is a per-provider "not available here", never a load-time failure of core.
 */
const LOADERS: Record<ProviderId, () => Promise<ProviderFactory>> = {
  anthropic: async () => {
    const { anthropic } = await import("@ai-sdk/anthropic");
    return {
      model: (id) => anthropic(id),
      webTools: () => ({
        web_search: anthropic.tools.webSearch_20260209(),
        web_fetch: anthropic.tools.webFetch_20260209(),
      }),
    };
  },
  openai: async () => {
    const { openai } = await import("@ai-sdk/openai");
    return { model: (id) => openai(id), webTools: () => ({ web_search: openai.tools.webSearch() }) };
  },
  google: async () => {
    const { google } = await import("@ai-sdk/google");
    return {
      model: (id) => google(id),
      webTools: () => ({
        web_search: google.tools.googleSearch({}),
        web_fetch: google.tools.urlContext({}),
      }),
    };
  },
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MODELS_DEV_URL = "https://models.dev/api.json";

/** Each provider's well-known key env var — models.dev tells us online; this is the offline copy. */
const KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** Load the SDKs for `providers` that are installed; missing ones are skipped (warned once). */
async function loadFactories(providers: readonly ProviderId[]): Promise<Map<ProviderId, ProviderFactory>> {
  const loaded = new Map<ProviderId, ProviderFactory>();
  await Promise.all(
    providers.map(async (p) => {
      try {
        loaded.set(p, await LOADERS[p]());
      } catch (e) {
        console.warn(
          `[latch-core/models] provider "${p}" unavailable (install @ai-sdk/${p} to use it):`,
          e instanceof Error ? e.message : e,
        );
      }
    }),
  );
  return loaded;
}

/**
 * The implicit default: the canonical Sonnet when Anthropic is runnable here,
 * else the first listed model of a provider that is — so an OpenAI- or
 * Google-only host never gets a default its SDK can't build.
 */
function pickDefaultModel(
  factories: ReadonlyMap<ProviderId, ProviderFactory>,
  models: readonly ModelInfo[],
): string {
  if (factories.has("anthropic")) return DEFAULT_MODEL;
  return models.find((m) => factories.has(m.provider as ProviderId))?.id ?? DEFAULT_MODEL;
}

function buildResolvers(
  factories: ReadonlyMap<ProviderId, ProviderFactory>,
  idToProvider: ReadonlyMap<string, ProviderId>,
  defaultModel: string,
): Pick<ModelCatalog, "modelFor" | "providerTools"> {
  const defaultProvider = providerFromId(defaultModel) ?? "anthropic";
  const providerOfId = (id: string): ProviderId | undefined => idToProvider.get(id) ?? providerFromId(id);
  return {
    modelFor: (id) => {
      const provider = providerOfId(id);
      const f = (provider && factories.get(provider)) || factories.get(defaultProvider);
      if (!f) {
        throw new Error(
          `[latch-core/models] no provider SDK loaded for "${id}" (or the default "${defaultModel}") — install @ai-sdk/${provider ?? defaultProvider} and set its API key`,
        );
      }
      // A known provider resolves the requested id; an unknown id falls back to the default model.
      return provider && factories.has(provider) ? f.model(id) : f.model(defaultModel);
    },
    providerTools: (id) => {
      // Unknown ids default to the default model's provider (historically Anthropic's tools).
      const provider = providerOfId(id) ?? defaultProvider;
      return factories.get(provider)?.webTools() ?? {};
    },
  };
}

/**
 * Offline fallback: one known-good model per provider, restricted (like the
 * online path) to providers that are keyed AND installed. Same eligibility
 * rule, so an unconfigured SDK never yields a model that can't run.
 */
function fallbackCatalog(
  factories: ReadonlyMap<ProviderId, ProviderFactory>,
  defaultModel: string | undefined,
): ModelCatalog {
  const all: ModelInfo[] = [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", reasoning: true, maxOutput: 64000 },
    { id: "gpt-4o", label: "GPT-4o", provider: "openai", reasoning: false, maxOutput: 16384 },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google", reasoning: true, maxOutput: 65536 },
  ];
  const models = all.filter((m) => factories.has(m.provider as ProviderId));
  const chosenDefault = defaultModel ?? pickDefaultModel(factories, models);
  return {
    models,
    pricing: staticPricing({
      "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
      "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
      "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
    }),
    ...buildResolvers(factories, new Map(models.map((m) => [m.id, m.provider as ProviderId])), chosenDefault),
    defaultModel: chosenDefault,
  };
}

/** Providers whose key env is set (offline eligibility rule). */
const keyedProviders = (providers: readonly ProviderId[]): ProviderId[] =>
  providers.filter((p) => !!process.env[KEY_ENV[p]]);

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
      reasoning?: boolean;
      limit?: { output?: number };
      cost?: MdCost & { tiers?: Array<MdCost & { tier?: { type?: string; size?: number } }> };
    }
  >;
}

// Memo per (fetch implementation, option set): an injected fetch (tests,
// mirrors) gets its own cache, so it can never serve a catalog to callers
// using a different one.
const caches = new WeakMap<object, Map<string, Promise<ModelCatalog>>>();
const cacheFor = (fetchImpl: object): Map<string, Promise<ModelCatalog>> => {
  let m = caches.get(fetchImpl);
  if (!m) caches.set(fetchImpl, (m = new Map()));
  return m;
};

/**
 * Load (and memoize per option set) the model catalog from models.dev, across
 * runnable providers. Rejects — never returns a half-usable catalog — when an
 * explicit `defaultModel` names a provider that isn't runnable here.
 */
export function loadModelCatalog(options: ModelCatalogOptions = {}): Promise<ModelCatalog> {
  const providers = options.providers ?? PROVIDER_IDS;
  const url = options.url ?? MODELS_DEV_URL;
  const doFetch = options.fetch ?? fetch;
  const cache = cacheFor(doFetch);
  const key = JSON.stringify([providers, options.defaultModel ?? null, url]);
  const hit = cache.get(key);
  if (hit) return hit;
  const loading = (async () => {
    let factories: Map<ProviderId, ProviderFactory> | undefined;
    let catalog: ModelCatalog;
    try {
      const res = await doFetch(url, { redirect: "error" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all = (await res.json()) as Record<string, MdProvider>;

      // Usable = listed by models.dev AND keyed. Then load those SDKs (only).
      const keyed = providers.filter((p) => {
        const md = all[p];
        return !!md?.models && (md.env ?? []).some((e) => !!process.env[e]);
      });
      factories = await loadFactories(keyed);

      const list: ModelInfo[] = [];
      const rates: Record<string, ModelPrice> = {};
      const idToProvider = new Map<string, ProviderId>();

      for (const provider of keyed) {
        if (!factories.has(provider)) continue; // keyed but SDK not installed
        for (const [id, m] of Object.entries(all[provider]!.models!)) {
          list.push({ id, label: m.name ?? id, provider, reasoning: m.reasoning, maxOutput: m.limit?.output });
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
      if (list.length === 0) throw new Error("no runnable providers (no API keys, or SDKs not installed?)");
      list.sort((a, b) => a.label.localeCompare(b.label));

      const defaultModel = options.defaultModel ?? pickDefaultModel(factories, list);
      catalog = {
        models: list,
        pricing: staticPricing(rates),
        ...buildResolvers(factories, idToProvider, defaultModel),
        defaultModel,
      };
    } catch (e) {
      console.warn("models.dev unavailable, using fallback list:", e instanceof Error ? e.message : e);
      // Offline: the same eligibility rule (keyed + installed) over the
      // fallback list's providers, from the well-known key env names.
      factories ??= await loadFactories(keyedProviders(providers));
      catalog = fallbackCatalog(factories, options.defaultModel);
    }
    // An explicit default that this deployment can't build is a configuration
    // error — say so now, not on the first turn that falls back to it.
    const dp = providerFromId(catalog.defaultModel) ?? providerOfListed(catalog.models, catalog.defaultModel);
    if (!dp || !factories.has(dp)) {
      cache.delete(key);
      throw new Error(
        `[latch-core/models] default model "${catalog.defaultModel}" is not runnable here — ` +
          `its provider${dp ? ` (@ai-sdk/${dp})` : ""} is not installed or has no API key set`,
      );
    }
    return catalog;
  })();
  cache.set(key, loading);
  return loading;
}

const providerOfListed = (models: readonly ModelInfo[], id: string): ProviderId | undefined =>
  models.find((m) => m.id === id)?.provider as ProviderId | undefined;
