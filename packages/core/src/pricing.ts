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
}

/** Resolve a model id to its price, or undefined if unknown (→ cost 0). */
export type Pricing = (model: string) => ModelPrice | undefined;

/** Cost for a turn's token usage under a price (0 if no price). */
export function computeCost(
  price: ModelPrice | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}

/** A `Pricing` from a static `{ modelId: ModelPrice }` table. */
export function staticPricing(table: Record<string, ModelPrice>): Pricing {
  return (model) => table[model];
}
