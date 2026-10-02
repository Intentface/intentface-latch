/**
 * Evals v2 — does the judge agree with people?
 *
 * A verdict is a judge's call; a ruling is a person's call on the same
 * (thread, check). Only the pair can say whether a check's numbers mean
 * anything. Three things come out of the pairs:
 *
 *   trust      — per check, how often the judge and people agree, and which
 *                way it errs (passing what people fail is the dangerous way)
 *   queue      — which threads a person should rule next, so a few minutes
 *                of ruling buys the most information
 *   threshold  — the confidence above which this check's verdicts have
 *                matched people, so only the rest need a bigger judge or a
 *                person. Derived from rulings, never assumed.
 *
 * Counted checks are included: code cannot misread a log, but the CHECK can
 * be the wrong question, and a person failing a thread a counted check
 * passed says exactly that.
 */
import type { Ruling, ThreadRef, Verdict } from "./model";

/** Below this many rulings nothing is claimed about a check. */
export const MIN_RULINGS = 20;
/** Enough rulings, and this much agreement, to let a check block a publish. */
export const GATE_RULINGS = 50;
export const TRUSTED_AGREEMENT = 0.9;

export type TrustLevel = "unknown" | "trusted" | "gating" | "disputed";

export interface CheckTrust {
  checkId: string;
  /** Verdicts with a ruling beside them. */
  ruled: number;
  agreed: number;
  /** Judge passed, person failed — the error that ships regressions. */
  falsePasses: number;
  /** Judge failed, person passed — the error that wastes time. */
  falseFails: number;
  /** Cohen's kappa: agreement beyond what the base rates alone would give. */
  kappa: number;
  level: TrustLevel;
}

/**
 * What a check's number is worth. `unknown` until MIN_RULINGS; `disputed`
 * once there are enough rulings and agreement is below TRUSTED_AGREEMENT;
 * `gating` at GATE_RULINGS with agreement held.
 */
export function trustOf(verdicts: Verdict[], rulings: Ruling[]): CheckTrust[] {
  const rulingOf = new Map(rulings.map((r) => [`${r.threadId}|${r.checkId}`, r]));
  const byCheck = new Map<string, { judge: boolean; person: boolean }[]>();
  for (const v of verdicts) {
    const r = rulingOf.get(`${v.threadId}|${v.checkId}`);
    if (!r) continue;
    (byCheck.get(v.checkId) ?? byCheck.set(v.checkId, []).get(v.checkId)!).push({ judge: v.failed, person: r.failed });
  }
  const checkIds = [...new Set(verdicts.map((v) => v.checkId))];
  return checkIds.map((checkId) => {
    const pairs = byCheck.get(checkId) ?? [];
    const agreed = pairs.filter((p) => p.judge === p.person).length;
    const falsePasses = pairs.filter((p) => !p.judge && p.person).length;
    const falseFails = pairs.filter((p) => p.judge && !p.person).length;
    const n = pairs.length;
    const rate = n ? agreed / n : 0;
    return {
      checkId,
      ruled: n,
      agreed,
      falsePasses,
      falseFails,
      kappa: kappa(pairs),
      level:
        n < MIN_RULINGS ? "unknown" : rate < TRUSTED_AGREEMENT ? "disputed" : n >= GATE_RULINGS ? "gating" : "trusted",
    };
  });
}

function kappa(pairs: { judge: boolean; person: boolean }[]): number {
  const n = pairs.length;
  if (!n) return 0;
  const po = pairs.filter((p) => p.judge === p.person).length / n;
  const jf = pairs.filter((p) => p.judge).length / n;
  const pf = pairs.filter((p) => p.person).length / n;
  const pe = jf * pf + (1 - jf) * (1 - pf);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export interface QueueItem {
  threadId: string;
  checkId: string;
  /** Why this one is worth a person's minute, in words the UI can show. */
  reason: string;
  score: number;
}

/**
 * What to rule next. A ruling is worth most where the judge is least sure,
 * where it changed its mind across passes, and where two versions disagree on
 * the same input — that last is exactly the cell a comparison's p-value rests
 * on. Rulings are spread across checks so no check stays `unknown` while
 * another collects its hundredth.
 */
export function rulingQueue(opts: {
  verdicts: Verdict[];
  rulings: Ruling[];
  threads: ThreadRef[];
  /** Further judge passes over the same threads, for flip detection. */
  passes?: Verdict[][];
  limit?: number;
}): QueueItem[] {
  const ruled = new Set(opts.rulings.map((r) => `${r.threadId}|${r.checkId}`));
  const byThread = new Map(opts.threads.map((t) => [t.threadId, t]));
  const answers = new Map<string, Set<string>>();
  for (const pass of opts.passes ?? [])
    for (const v of pass) (answers.get(`${v.threadId}|${v.checkId}`) ?? answers.set(`${v.threadId}|${v.checkId}`, new Set()).get(`${v.threadId}|${v.checkId}`)!).add(v.answer);
  // Per (input, check): the set of outcomes across versions.
  const outcomes = new Map<string, Set<boolean>>();
  for (const v of opts.verdicts) {
    const t = byThread.get(v.threadId);
    if (!t?.inputId) continue;
    const k = `${t.inputId}|${v.checkId}`;
    (outcomes.get(k) ?? outcomes.set(k, new Set()).get(k)!).add(v.failed);
  }
  const ruledPerCheck = new Map<string, number>();
  for (const r of opts.rulings) ruledPerCheck.set(r.checkId, (ruledPerCheck.get(r.checkId) ?? 0) + 1);

  const items: QueueItem[] = [];
  for (const v of opts.verdicts) {
    const key = `${v.threadId}|${v.checkId}`;
    if (ruled.has(key)) continue;
    const reasons: string[] = [];
    let score = 0;
    if (v.confidence !== undefined && v.confidence < 0.8) {
      score += 1 - v.confidence;
      reasons.push(`judge was ${Math.round(v.confidence * 100)}% sure`);
    }
    if ((answers.get(key)?.size ?? 1) > 1) {
      score += 1;
      reasons.push("judge changed its answer between passes");
    }
    const t = byThread.get(v.threadId);
    if (t?.inputId && (outcomes.get(`${t.inputId}|${v.checkId}`)?.size ?? 1) > 1) {
      score += 0.5;
      reasons.push("versions differ on this input");
    }
    // Checks nobody has ruled on yet come first; a fresh check is worth more
    // than a tenth ruling on a settled one.
    score += 1 / (1 + (ruledPerCheck.get(v.checkId) ?? 0));
    items.push({ threadId: v.threadId, checkId: v.checkId, reason: reasons.join("; ") || "sample", score });
  }
  items.sort((a, b) => b.score - a.score);
  // Round-robin across checks so the queue is not one check deep.
  const lanes = new Map<string, QueueItem[]>();
  for (const it of items) (lanes.get(it.checkId) ?? lanes.set(it.checkId, []).get(it.checkId)!).push(it);
  const out: QueueItem[] = [];
  const limit = opts.limit ?? 20;
  while (out.length < limit && [...lanes.values()].some((l) => l.length))
    for (const l of lanes.values()) if (l.length && out.length < limit) out.push(l.shift()!);
  return out;
}

export interface Threshold {
  checkId: string;
  /** Accept verdicts at or above this confidence; send the rest on. Null = no level is safe yet. */
  accept: number | null;
  /** Share of this check's verdicts the threshold lets through. */
  coverage: number;
  /** Agreement with people among the accepted, on the ruled sample. */
  agreement: number;
  ruled: number;
}

/**
 * The lowest confidence at which this check's verdicts have agreed with
 * people at least `target` of the time, over at least MIN_RULINGS ruled
 * verdicts. Verdicts at or above it can stand; the rest go to a bigger judge
 * or a person. With too few rulings, `accept` is null — nothing is
 * auto-accepted on faith.
 */
export function thresholdFor(checkId: string, verdicts: Verdict[], rulings: Ruling[], target = 0.95): Threshold {
  const rulingOf = new Map(rulings.map((r) => [`${r.threadId}|${r.checkId}`, r]));
  const mine = verdicts.filter((v) => v.checkId === checkId && v.confidence !== undefined);
  const ruled = mine
    .flatMap((v) => {
      const r = rulingOf.get(`${v.threadId}|${v.checkId}`);
      return r ? [{ c: v.confidence!, agree: r.failed === v.failed }] : [];
    })
    .sort((a, b) => b.c - a.c);
  const none = { checkId, accept: null, coverage: 0, agreement: 0, ruled: ruled.length };
  if (ruled.length < MIN_RULINGS) return none;
  // Walk down from the most confident; keep the lowest cut that still holds.
  let best: Threshold = none;
  let agreed = 0;
  for (let i = 0; i < ruled.length; i++) {
    agreed += ruled[i]!.agree ? 1 : 0;
    const n = i + 1;
    // Cut only between distinct confidences, and never on a handful.
    if (n < MIN_RULINGS || (i + 1 < ruled.length && ruled[i + 1]!.c === ruled[i]!.c)) continue;
    if (agreed / n >= target) {
      const accept = ruled[i]!.c;
      best = {
        checkId,
        accept,
        coverage: mine.filter((v) => v.confidence! >= accept).length / mine.length,
        agreement: agreed / n,
        ruled: ruled.length,
      };
    }
  }
  return best;
}
