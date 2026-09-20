import type { EvalRun } from "./store";

/**
 * How often the judge agreed with a human, per question.
 *
 * This is the number that decides what a check is allowed to DO. A question
 * nobody has checked produces a verdict, not evidence: it may be measuring the
 * behaviour you meant, or it may be measuring how the answer is phrased, and
 * the run cannot tell the difference. Until someone has disagreed with it a few
 * times and lost, "the suite went red" is a rumour.
 *
 * So the rule this supports is deliberately blunt: an unvalidated check may
 * REPORT, and only a validated one may GATE. That is the whole reason the
 * judge's verdict is kept beside the human's rather than overwritten — a table
 * of corrected answers looks tidier and can answer nothing.
 */

export interface CheckReliability {
  caseId: string;
  checkId: string;
  /** Verdicts a human has ruled on. */
  labelled: number;
  /** Of those, how many the judge got right. */
  agreed: number;
  /** agreed / labelled, or undefined when nobody has ruled yet. */
  agreement?: number;
  /**
   * Whether this check has earned the right to fail a build.
   *
   * Two conditions, both necessary. ENOUGH labels: agreement of 1/1 is not
   * evidence of anything. And HIGH ENOUGH agreement: a judge that is right four
   * times in five will fire a false alarm on a fifth of your runs, which is
   * how a suite gets muted.
   */
  gating: boolean;
  /** Labels that disagreed — the ones worth reading to fix the question. */
  disputedRuns: string[];
}

/**
 * The bar a check must clear before it may fail a build. Exported because the
 * UI states it to the reader, and a rule the page describes differently from
 * the one it applies is worse than no rule.
 *
 * Both conditions are necessary. Three labels out of three is not evidence,
 * and a judge right four times in five fires a false alarm on a fifth of runs
 * — which is how a suite stops being read.
 */
export const MIN_LABELS = 10;
export const MIN_AGREEMENT = 0.9;

export interface ReliabilityOptions {
  /** Labels needed before a check may gate. */
  minLabels?: number;
  /** Agreement needed before a check may gate. */
  minAgreement?: number;
}

/**
 * Roll every human correction across the given runs into per-check agreement.
 *
 * Keyed by (case, check) rather than check alone: the same question asked about
 * a different input is a different measurement, and a judge can be dependable
 * on one and hopeless on the other.
 */
export function reliabilityOf(
  runs: EvalRun[],
  options: ReliabilityOptions = {},
): CheckReliability[] {
  const { minLabels = MIN_LABELS, minAgreement = MIN_AGREEMENT } = options;
  const byKey = new Map<string, CheckReliability>();

  for (const run of runs) {
    for (const result of run.results) {
      for (const check of result.checks ?? []) {
        if (!check.human) continue; // no ruling → no evidence either way
        const key = `${result.caseId}/${check.id}`;
        const entry =
          byKey.get(key) ??
          ({
            caseId: result.caseId,
            checkId: check.id,
            labelled: 0,
            agreed: 0,
            gating: false,
            disputedRuns: [],
          } satisfies CheckReliability);
        entry.labelled++;
        if (check.human.failed === check.failed) entry.agreed++;
        else entry.disputedRuns.push(run.id);
        byKey.set(key, entry);
      }
    }
  }

  return [...byKey.values()]
    .map((e) => {
      const agreement = e.labelled ? e.agreed / e.labelled : undefined;
      return {
        ...e,
        agreement,
        gating: e.labelled >= minLabels && (agreement ?? 0) >= minAgreement,
      };
    })
    // Worst agreement first: those are the questions to rewrite, and a list
    // sorted by anything else buries them under the ones already working.
    .sort((a, b) => (a.agreement ?? 1) - (b.agreement ?? 1));
}

/**
 * The verdict to act on: the human's when there is one, else the judge's.
 *
 * A human ruling is not an override of one number — it is the ground truth for
 * that observation, and every rate computed from a labelled run should use it.
 * Reporting the judge's answer after someone has said it is wrong would make
 * the correction cosmetic.
 */
export const effectiveFailed = (check: { failed: boolean; human?: { failed: boolean } }): boolean =>
  check.human?.failed ?? check.failed;
