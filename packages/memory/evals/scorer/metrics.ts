/**
 * Deterministic retrieval metrics — pure functions, zero LLM, zero network.
 * `ranked` is the ordered list of retrieved memory names (deduped, best
 * first); relevance comes from the sealed qrels.
 */

/** Fraction of the top-k results that are relevant (k is the denominator). */
export function precisionAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) return 0;
  const hits = ranked.slice(0, k).filter((name) => relevant.has(name)).length;
  return hits / k;
}

/** Fraction of all relevant items found in the top k. */
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) return 0;
  if (relevant.size === 0) return 0;
  const hits = ranked.slice(0, k).filter((name) => relevant.has(name)).length;
  return hits / relevant.size;
}

/** 1/rank of the first relevant result (0 when none is retrieved). */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const index = ranked.findIndex((name) => relevant.has(name));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Graded nDCG@k with the exponential gain form: gain = 2^grade − 1,
 * discount = log2(position + 1). Ideal ranking = all judged items sorted by
 * grade descending. Returns 0 when there are no judged items.
 */
export function ndcgAtK(
  ranked: readonly string[],
  grades: ReadonlyMap<string, number>,
  k: number,
): number {
  if (k <= 0) return 0;
  const gain = (grade: number) => Math.pow(2, grade) - 1;
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, name, i) => sum + gain(grades.get(name) ?? 0) / Math.log2(i + 2), 0);
  const ideal = Array.from(grades.values())
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

/** 1 when the top result is the designated primary target, else 0. */
export function top1Hit(ranked: readonly string[], firstRelevant: string): 0 | 1 {
  return ranked[0] === firstRelevant ? 1 : 0;
}

/** Arithmetic mean, 0 for an empty list (an empty tier reports zeros, not NaN). */
export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
