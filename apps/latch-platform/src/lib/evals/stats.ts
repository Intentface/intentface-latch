/**
 * Turning two piles of verdicts into a decision you can ship on.
 *
 * The failure this exists to prevent: "v13 passes 82%, v12 passed 79%, ship
 * it". With sixty conversations that difference is roughly a coin flip, and a
 * team that ships on it will also revert on it next week. A number without an
 * interval is not evidence.
 *
 * Three things make the difference between a real comparison and a plausible
 * one:
 *
 *   PAIRING. Compare versions on the SAME tasks. Question difficulty varies
 *   enormously — one hard question can move an unpaired average more than a
 *   real regression does — and pairing cancels it exactly.
 *
 *   AN INTERVAL, from a bootstrap over tasks rather than a normal
 *   approximation. Failure rates are bounded and lumpy at the sample sizes
 *   anyone actually runs, which is where the normal approximation is worst.
 *
 *   ADMITTING IGNORANCE. "Flat" and "we can't tell" are different answers, and
 *   collapsing them is how eval suites get muted. A wide interval around zero
 *   means UNDERPOWERED, and the honest response is to say how many more runs
 *   it would take.
 *
 * Convention throughout: a value is a FAILURE indicator — 1 failed, 0 passed
 * (fractions are fine for a pass rate over repeats). So a POSITIVE delta means
 * the head version fails more, i.e. a regression.
 */

/** One question's outcome on one task under one version. */
export interface Observation {
  /**
   * What makes the comparison paired. For replayed traffic this is the
   * question that was asked; for a canary, whatever identifies the same unit
   * of work on both sides.
   */
  task: string;
  /** Version label, e.g. "v12". */
  agent: string;
  /** 1 = failed, 0 = passed. */
  value: number;
}

export type Verdict = "regressed" | "improved" | "flat" | "underpowered";

export interface Comparison {
  /** Mean paired difference, head − base. Positive = head fails more. */
  delta: number;
  /** Percentile bootstrap interval for `delta`. */
  ci: [number, number];
  /** Tasks present in BOTH versions — the only ones that count. */
  n: number;
  /** Base and head failure rates over those paired tasks. */
  baseRate: number;
  headRate: number;
  verdict: Verdict;
  /**
   * Roughly the smallest true difference this sample could reliably detect.
   * When the verdict is `underpowered`, this is the number to quote.
   */
  mde: number;
}

export interface CompareOptions {
  /**
   * The smallest difference worth acting on. An interval that contains zero
   * AND is narrower than this means "confidently no meaningful change"; wider
   * means "we cannot tell".
   */
  meaningfulDelta?: number;
  /** Bootstrap resamples. 2000 is plenty for a 95% percentile interval. */
  iterations?: number;
  /** Seed, so the same inputs always give the same interval. */
  seed?: number;
}

/**
 * A small deterministic PRNG. A bootstrap that moves on every run makes a
 * regression report impossible to reproduce and impossible to argue with.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Nearest-rank percentile on a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/** Per-task differences (head − base), over tasks BOTH versions attempted. */
export function pairedDifferences(
  observations: Observation[],
  base: string,
  head: string,
): { task: string; diff: number }[] {
  const byTask = new Map<string, { base?: number[]; head?: number[] }>();
  for (const o of observations) {
    if (o.agent !== base && o.agent !== head) continue;
    const entry = byTask.get(o.task) ?? {};
    const side = o.agent === base ? "base" : "head";
    (entry[side] ??= []).push(o.value);
    byTask.set(o.task, entry);
  }
  const out: { task: string; diff: number }[] = [];
  for (const [task, { base: b, head: h }] of byTask) {
    // A task only one version attempted tells you nothing about the
    // difference, and including it silently unpairs the comparison.
    if (!b?.length || !h?.length) continue;
    out.push({ task, diff: mean(h) - mean(b) });
  }
  // Stable order so the bootstrap is reproducible regardless of input order.
  out.sort((x, y) => (x.task < y.task ? -1 : x.task > y.task ? 1 : 0));
  return out;
}

/** Compare two versions on one question. */
export function compare(
  observations: Observation[],
  base: string,
  head: string,
  options: CompareOptions = {},
): Comparison {
  const { meaningfulDelta = 0.05, iterations = 2_000, seed = 42 } = options;
  const pairs = pairedDifferences(observations, base, head);
  const n = pairs.length;

  const paired = new Set(pairs.map((p) => p.task));
  const rate = (agent: string) =>
    mean(observations.filter((o) => o.agent === agent && paired.has(o.task)).map((o) => o.value));

  if (n === 0) {
    return {
      delta: 0,
      ci: [0, 0],
      n: 0,
      baseRate: 0,
      headRate: 0,
      verdict: "underpowered",
      mde: Infinity,
    };
  }

  const diffs = pairs.map((p) => p.diff);
  const delta = mean(diffs);

  // Paired bootstrap: resample TASKS with replacement, not observations —
  // the task is the independent unit, and resampling within it would shrink
  // the interval by pretending we have more information than we do.
  const rng = mulberry32(seed);
  const means = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += diffs[Math.floor(rng() * n)]!;
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const ci: [number, number] = [percentile(means, 0.025), percentile(means, 0.975)];

  const se = Math.sqrt(mean(means.map((m) => (m - mean(means)) ** 2)));
  // ~80% power at α=0.05 is about 2.8 standard errors.
  const mde = 2.8 * se;

  const excludesZero = ci[0] > 0 || ci[1] < 0;
  const halfWidth = (ci[1] - ci[0]) / 2;
  const verdict: Verdict = excludesZero
    ? delta > 0
      ? "regressed"
      : "improved"
    : halfWidth <= meaningfulDelta
      ? "flat"
      : "underpowered";

  return { delta, ci, n, baseRate: rate(base), headRate: rate(head), verdict, mde };
}

/**
 * Benjamini–Hochberg across questions.
 *
 * Twenty questions compared between two versions will hand you one
 * "significant" result by chance about as often as not. Without this the suite
 * cries wolf, and the first thing a team does with a suite that cries wolf is
 * stop reading it. Returns the ids whose findings survive at `q`.
 */
export function survivingFdr(
  findings: { id: string; pValue: number }[],
  q = 0.1,
): Set<string> {
  const sorted = [...findings].sort((a, b) => a.pValue - b.pValue);
  const m = sorted.length;
  let cutoff = -1;
  for (let i = 0; i < m; i++) {
    if (sorted[i]!.pValue <= ((i + 1) / m) * q) cutoff = i;
  }
  return new Set(sorted.slice(0, cutoff + 1).map((f) => f.id));
}

/**
 * A two-sided bootstrap p-value for "the true difference is zero": the
 * proportion of resamples on the far side of zero, doubled. Floored at
 * 1/iterations, because a bootstrap cannot report a p-value smaller than its
 * own resolution and reporting 0 would overstate the evidence.
 */
export function bootstrapPValue(
  observations: Observation[],
  base: string,
  head: string,
  options: CompareOptions = {},
): number {
  const { iterations = 2_000, seed = 42 } = options;
  const diffs = pairedDifferences(observations, base, head).map((p) => p.diff);
  const n = diffs.length;
  if (n === 0) return 1;

  const rng = mulberry32(seed);
  // Count each side INCLUSIVE of zero. Counting ties as "below" and taking
  // the complement looks equivalent and is not: when every resample lands
  // exactly on zero — two versions that behaved identically — the complement
  // is empty and the p-value comes out at its floor, reporting "highly
  // significant" for no difference whatsoever. Two inclusive counts make that
  // case min(all, all) → p = 1, which is the answer.
  let leqZero = 0;
  let geqZero = 0;
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += diffs[Math.floor(rng() * n)]!;
    const m = sum / n;
    if (m <= 0) leqZero++;
    if (m >= 0) geqZero++;
  }
  const tail = Math.min(leqZero, geqZero) / iterations;
  return Math.max(1 / iterations, Math.min(1, 2 * tail));
}
