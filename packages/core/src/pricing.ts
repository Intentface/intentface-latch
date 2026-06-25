/**
 * Cost calculation — a small seam over token usage.
 *
 * `Pricing` maps a model id to its per-million-token rates; the runtime applies
 * it to each turn's usage and records the cost on the message, the run, and the
 * usage ledger. Inject a static table now (`staticPricing`); a models.dev-backed
 * catalog (live rates, cached in the DB) can replace it behind the same seam.
 */

/** Rate card for one model, in the account's currency unit per 1M tokens. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  /** Cached-prompt READ rate (much cheaper). Falls back to the input rate. */
  cacheReadPer1M?: number;
  /** Cache WRITE/creation rate (Anthropic charges a premium). Falls back to input. */
  cacheWritePer1M?: number;
}

/** A turn's token usage, split so cached input can be priced separately. */
export interface UsageBreakdown {
  /** Total prompt tokens (cached + non-cached). */
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens READ (billed at `cacheReadPer1M`). */
  cacheReadTokens?: number;
  /** Cache-creation tokens WRITTEN (billed at `cacheWritePer1M`). */
  cacheWriteTokens?: number;
}

/** Resolve a model id to its price, or undefined if unknown (→ cost 0). */
export type Pricing = (model: string) => ModelPrice | undefined;

/**
 * Cost for a turn's token usage under a price (0 if no price). Cached prompt
 * tokens are billed at the cache read/write rates (providers auto-cache repeated
 * prefixes — e.g. a tool loop re-sending context — so cache reads are far
 * cheaper than fresh input). `inputTokens` is the TOTAL; the non-cached
 * remainder bills at the full input rate.
 */
export function computeCost(price: ModelPrice | undefined, usage: UsageBreakdown): number {
  if (!price) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const nonCached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const per = (n: number, rate: number) => (n / 1_000_000) * rate;
  return (
    per(nonCached, price.inputPer1M) +
    per(cacheRead, price.cacheReadPer1M ?? price.inputPer1M) +
    per(cacheWrite, price.cacheWritePer1M ?? price.inputPer1M) +
    per(usage.outputTokens, price.outputPer1M)
  );
}

/** A `Pricing` from a static `{ modelId: ModelPrice }` table. */
export function staticPricing(table: Record<string, ModelPrice>): Pricing {
  return (model) => table[model];
}
