/**
 * Edge Eval v0 — agreement statistics for judge reliability (plan, approved flow
 * improvement 4) and judge–human calibration (improvement 1).
 *
 * Raw agreement flatters any rating task with an unbalanced marginal — on a benchmark where
 * D wins nearly always, two raters who both always say "D" agree 100% while carrying no
 * information. Cohen's κ removes the agreement expected from the raters' own marginals; the
 * quadratically weighted variant is the one to quote for the ordered scales (−2…+2 and 0–3),
 * where "off by one rung" must not count the same as "opposite verdict".
 */

export interface Agreement {
  n: number;
  /** Share of items the two raters scored identically. */
  raw: number;
  /** Cohen's κ over the observed categories (unweighted). */
  kappa: number | null;
  /** Quadratically weighted κ — ordered scales only. */
  weightedKappa?: number | null;
  /** Mean |a − b| — ordered scales only. */
  meanAbsDelta?: number;
  /** Share where both raters fall on the same side of 0 (ties count as their own side). */
  signAgreement?: number;
  /** Set when the sample cannot support κ — read `raw` and `meanAbsDelta` instead. */
  caveat?: string;
}

/** κ needs both variance and a sample; below this it reports noise about noise. */
const MIN_N_FOR_KAPPA = 10;

function caveatFor(pairs: Array<[unknown, unknown]>): string | undefined {
  if (pairs.length < MIN_N_FOR_KAPPA) return `n = ${pairs.length}: below ${MIN_N_FOR_KAPPA}, κ is not meaningful — read raw agreement instead`;
  if (new Set(pairs.map(([a]) => a)).size < 2 || new Set(pairs.map(([, b]) => b)).size < 2) {
    return "one rater used a single category: κ corrects against a zero-variance marginal and reads ~0 however high the agreement — read raw agreement instead";
  }
  return undefined;
}

const round = (x: number) => +x.toFixed(3);

/**
 * Cohen's κ for two raters over the same items. `weights` = "quadratic" treats the labels as
 * equally spaced numbers and penalises by squared distance. Returns null when κ is undefined
 * (one rater used a single category and agreement is total — the expected-agreement term is 1).
 */
export function cohenKappa(pairs: Array<[string | number, string | number]>, weights: "none" | "quadratic" = "none"): number | null {
  if (!pairs.length) return null;
  const labels = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  if (weights === "quadratic" && labels.some((l) => typeof l !== "number")) throw new Error("quadratic weighting needs numeric labels");
  labels.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
  const k = labels.length;
  if (k === 1) return null; // no variance to correct for
  const idx = new Map(labels.map((l, i) => [l, i]));
  const n = pairs.length;
  const obs: number[][] = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
  const rowA = Array.from({ length: k }, () => 0);
  const rowB = Array.from({ length: k }, () => 0);
  for (const [a, b] of pairs) {
    const i = idx.get(a)!;
    const j = idx.get(b)!;
    obs[i]![j]! += 1;
    rowA[i]! += 1;
    rowB[j]! += 1;
  }
  const maxDist = weights === "quadratic" ? Math.pow(Number(labels[k - 1]) - Number(labels[0]), 2) : 1;
  const w = (i: number, j: number) => (weights === "quadratic" ? Math.pow(Number(labels[i]) - Number(labels[j]), 2) / maxDist : i === j ? 0 : 1);
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      po += w(i, j) * (obs[i]![j]! / n);
      pe += w(i, j) * ((rowA[i]! / n) * (rowB[j]! / n));
    }
  }
  if (pe === 0) return null;
  return round(1 - po / pe);
}

/** Agreement on an unordered categorical (hard failures, primary reasons). */
export function categoricalAgreement(pairs: Array<[string, string]>): Agreement {
  const caveat = caveatFor(pairs);
  return {
    n: pairs.length,
    raw: pairs.length ? round(pairs.filter(([a, b]) => a === b).length / pairs.length) : 0,
    kappa: cohenKappa(pairs),
    ...(caveat ? { caveat } : {}),
  };
}

/** Agreement on an ordered scale (0–3 rubric rungs, −2…+2 preferences). */
export function ordinalAgreement(pairs: Array<[number, number]>): Agreement {
  const n = pairs.length;
  const side = (x: number) => Math.sign(x);
  const caveat = caveatFor(pairs);
  return {
    n,
    raw: n ? round(pairs.filter(([a, b]) => a === b).length / n) : 0,
    kappa: cohenKappa(pairs),
    weightedKappa: cohenKappa(pairs, "quadratic"),
    meanAbsDelta: n ? round(pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / n) : 0,
    signAgreement: n ? round(pairs.filter(([a, b]) => side(a) === side(b)).length / n) : 0,
    ...(caveat ? { caveat } : {}),
  };
}

/** Agreement on a boolean dimension (the rubric's pass/fail dimensions). */
export function binaryAgreement(pairs: Array<[boolean, boolean]>): Agreement {
  return categoricalAgreement(pairs.map(([a, b]) => [String(a), String(b)] as [string, string]));
}
