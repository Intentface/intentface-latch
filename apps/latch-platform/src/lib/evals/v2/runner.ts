import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import type { AskedCheck, CountedCheck, Dataset, Input, Rubric, ThreadRef, Verdict, Version } from "./model";
import { evaluateBound } from "./counted";
import { judgeAsked, stateOf, type JudgeUsage } from "./judge";
import { finalAnswer, viewOf } from "./thread";

/**
 * Running and judging, kept apart on purpose.
 *
 * The two halves have different costs and lifetimes. Running the agent is
 * dollars and minutes and happens once per (input, version); judging is
 * fractions of a cent and seconds and happens every time a check changes. So
 * `runDataset` produces threads and nothing else, and `judgeThreads` can be
 * called on those threads as often as the rubric moves — the behaviour being
 * graded is byte-identical each time, which a re-run could never promise.
 */

/**
 * Everything an agent's behaviour can turn on, and nothing else — no version
 * number or timestamp, which would make two identical configurations look
 * different. `live` and `@3` are one configuration whenever v3 is published.
 */
export function configFingerprint(rec: {
  instructions?: unknown;
  modelId?: unknown;
  maxSteps?: unknown;
  connections?: unknown[];
  tools?: unknown;
  exec?: unknown;
}): string {
  return JSON.stringify({
    instructions: rec.instructions ?? "",
    modelId: rec.modelId ?? "",
    maxSteps: rec.maxSteps ?? null,
    connections: [...((rec.connections as string[] | undefined) ?? [])].sort(),
    tools: rec.tools ?? null,
    exec: rec.exec ?? null,
  });
}

export interface RunDeps {
  runAgent(input: { agent: string; prompt: string; threadId?: string }): Promise<{ threadId: string; answer: string }>;
}

export async function runDataset(opts: {
  owner: string;
  dataset: Dataset;
  inputs: Input[];
  versions: (Version & { fingerprint: string })[];
  deps: RunDeps;
  concurrency?: number;
  /**
   * Run each (input, version) this many times. One attempt per input cannot
   * separate a change from the agent's own variance: the same configuration
   * scored 17%, 26%, 30% and 30% on one check across four single-attempt
   * runs. Repeats turn each input into a rate, which is what can be compared.
   */
  repeats?: number;
  /** Groups the threads of this run. Generated when omitted. */
  runId?: string;
  onThread?: (t: ThreadRef, done: number, total: number) => void;
}): Promise<ThreadRef[]> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const runId = opts.runId ?? `run_${Date.now().toString(36)}`;
  const units = opts.versions.flatMap((v) =>
    opts.inputs.flatMap((input) => Array.from({ length: repeats }, (_, attempt) => ({ v, input, attempt }))),
  );
  const out: ThreadRef[] = new Array(units.length);
  let done = 0;
  await pool(units, opts.concurrency ?? 4, async ({ v, input, attempt }, i) => {
    const started = Date.now();
    const base = {
      owner: opts.owner,
      agentName: opts.dataset.agentName,
      datasetId: opts.dataset.id,
      inputId: input.id,
      runId,
      attempt,
      version: v.label,
      configFingerprint: v.fingerprint,
      origin: "run" as const,
      createdAt: started,
    };
    let threadId = "";
    try {
      let res = await opts.deps.runAgent({ agent: v.ref, prompt: input.prompt });
      threadId = res.threadId;
      // Follow-ups go into the SAME thread: the failures worth catching are
      // usually on turn two, after the agent has something to lose track of.
      for (const f of input.followUps ?? []) {
        res = await opts.deps.runAgent({ agent: v.ref, prompt: f, threadId });
      }
      // An empty answer is an outage, not a result. A provider that refuses
      // can come back as a completed turn with no text; judging that yields a
      // full set of confident verdicts about nothing, with no error in sight.
      if (!res.answer.trim()) throw new Error("the agent produced no answer — not judged");
      out[i] = { ...base, threadId, answer: res.answer, durationMs: Date.now() - started };
    } catch (e) {
      out[i] = {
        ...base,
        threadId: threadId || `failed:${runId}:${v.label}:${input.id}:${attempt}`,
        answer: "",
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
      };
    }
    opts.onThread?.(out[i]!, ++done, units.length);
  });
  return out;
}

export interface JudgeDeps {
  loadHistory(threadId: string): Promise<unknown[]>;
  judgeFor(id: string): EvaluationModel;
}

/**
 * Judge threads against one rubric version. Counted checks run locally;
 * asked checks go to their judges, grouped so each judge sees one state once.
 * Errored threads are skipped — there is nothing to judge, and scoring them
 * would average an outage into the result.
 */
export async function judgeThreads(opts: {
  rubric: Rubric;
  threads: ThreadRef[];
  inputsById?: Map<string, Input>;
  dataset?: Pick<Dataset, "audience" | "note">;
  deps: JudgeDeps;
  concurrency?: number;
  onUsage?: (u: JudgeUsage) => void;
  onThread?: (threadId: string, verdicts: Verdict[], done: number, total: number) => void;
}): Promise<Verdict[]> {
  const counted = opts.rubric.checks.filter((c): c is CountedCheck => c.kind === "counted");
  const asked = opts.rubric.checks.filter((c): c is AskedCheck => c.kind === "asked");
  const judgeable = opts.threads.filter((t) => !t.error);
  const all: Verdict[] = [];
  let done = 0;
  await pool(judgeable, opts.concurrency ?? 8, async (t) => {
    const view = viewOf(await opts.deps.loadHistory(t.threadId));
    const now = Date.now();
    const facts = t.inputId ? opts.inputsById?.get(t.inputId)?.facts : undefined;
    const vs: Verdict[] = [];
    for (const c of counted) {
      const r = evaluateBound(c.spec, view, facts);
      if (!r) continue; // the input does not say what to look for — not applicable
      vs.push({
        threadId: t.threadId,
        checkId: c.id,
        rubricVersion: opts.rubric.version,
        judgeId: "counted",
        answer: String(r.passed),
        failed: !r.passed,
        createdAt: now,
      });
    }
    if (asked.length && finalAnswer(view)) {
      const answers = await judgeAsked({
        checks: asked,
        state: stateOf({ view, ...(facts ? { facts } : {}), ...(opts.dataset ? { dataset: opts.dataset } : {}) }),
        defaultJudge: opts.rubric.defaultJudge,
        judgeFor: opts.deps.judgeFor,
        ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
      });
      for (const a of answers) {
        vs.push({
          threadId: t.threadId,
          checkId: a.checkId,
          rubricVersion: opts.rubric.version,
          judgeId: a.judgeId,
          answer: a.answer,
          ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
          ...(a.score !== undefined ? { score: a.score } : {}),
          failed: a.failed,
          createdAt: now,
        });
      }
    }
    all.push(...vs);
    opts.onThread?.(t.threadId, vs, ++done, judgeable.length);
  });
  return all;
}

// ─── Reading the results ───────────────────────────────────────────────────

export interface CheckSummary {
  checkId: string;
  /** Verdicts that passed / verdicts given — the mean rate across attempts. */
  passed: number;
  total: number;
  /**
   * Inputs where EVERY attempt passed, over inputs with a verdict. With one
   * attempt this equals the rate; with several it is pass^k — can it do it
   * every time, which is what a user gets, not whether it can do it at all.
   */
  allPassed: number;
  inputs: number;
  /** Answer → count. For a pick-one check this is the diagnosis a rate discards. */
  answers: Record<string, number>;
}

export interface VersionSummary {
  version: string;
  threads: number;
  errors: number;
  checks: CheckSummary[];
}

export function summarize(threads: ThreadRef[], verdicts: Verdict[], rubric: Rubric): VersionSummary[] {
  const byThread = new Map(threads.map((t) => [t.threadId, t]));
  const labels = [...new Set(threads.map((t) => t.version))];
  return labels.map((version) => {
    const ts = threads.filter((t) => t.version === version);
    const mine = verdicts.filter((v) => byThread.get(v.threadId)?.version === version);
    return {
      version,
      threads: ts.length,
      errors: ts.filter((t) => t.error).length,
      checks: rubric.checks.map((c) => {
        const vs = mine.filter((v) => v.checkId === c.id);
        const answers: Record<string, number> = {};
        const perInput = new Map<string, boolean>();
        for (const v of vs) {
          answers[v.answer] = (answers[v.answer] ?? 0) + 1;
          const key = byThread.get(v.threadId)?.inputId ?? v.threadId;
          perInput.set(key, (perInput.get(key) ?? true) && !v.failed);
        }
        return {
          checkId: c.id,
          passed: vs.filter((v) => !v.failed).length,
          total: vs.length,
          allPassed: [...perInput.values()].filter(Boolean).length,
          inputs: perInput.size,
          answers,
        };
      }),
    };
  });
}

export interface PairedComparison {
  checkId: string;
  /** Inputs where both versions produced at least one verdict. */
  pairs: number;
  /** Inputs whose pass rate went up from A to B. */
  improved: number;
  /** Inputs whose pass rate went down. */
  regressed: number;
  /** Mean per-input rate on A and B, over the paired inputs. */
  rateA: number;
  rateB: number;
  /**
   * Exact two-sided sign test over the inputs that moved. With one attempt
   * per input this is McNemar; with several, it compares rates rather than
   * single draws. Conservative at small n, which is the honest direction.
   */
  p: number;
}

/**
 * Two versions over the SAME inputs, compared input by input.
 *
 * Pairing removes how hard each question is from the comparison; only the
 * inputs that moved carry information. Threads should come from one run —
 * mixing runs mixes conditions, and the agent's variance between runs is
 * larger than most changes worth measuring.
 */
export function compareVersions(
  threads: ThreadRef[],
  verdicts: Verdict[],
  checkIds: string[],
  a: string,
  b: string,
): PairedComparison[] {
  const byThread = new Map(threads.map((t) => [t.threadId, t]));
  return checkIds.map((checkId) => {
    const tally = new Map<string, { a: [number, number]; b: [number, number] }>();
    for (const v of verdicts) {
      if (v.checkId !== checkId) continue;
      const t = byThread.get(v.threadId);
      if (!t?.inputId || (t.version !== a && t.version !== b)) continue;
      const slot = tally.get(t.inputId) ?? { a: [0, 0], b: [0, 0] };
      const side = t.version === a ? slot.a : slot.b;
      side[0] += v.failed ? 0 : 1;
      side[1] += 1;
      tally.set(t.inputId, slot);
    }
    let improved = 0;
    let regressed = 0;
    let pairs = 0;
    let sumA = 0;
    let sumB = 0;
    for (const s of tally.values()) {
      if (!s.a[1] || !s.b[1]) continue;
      pairs += 1;
      const ra = s.a[0] / s.a[1];
      const rb = s.b[0] / s.b[1];
      sumA += ra;
      sumB += rb;
      if (rb > ra) improved += 1;
      if (rb < ra) regressed += 1;
    }
    return {
      checkId,
      pairs,
      improved,
      regressed,
      rateA: pairs ? sumA / pairs : 0,
      rateB: pairs ? sumB / pairs : 0,
      p: mcnemar(improved, regressed),
    };
  });
}

export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * How often the judge agrees with ITSELF: the same threads judged several
 * times. This bounds everything else — a check whose judge wanders cannot
 * resolve a change smaller than its own noise, however many inputs you run.
 * Nearly free, because only the judging is repeated.
 */
export function consistency(passes: Verdict[][]): { checkId: string; agreement: number; unanimous: number; items: number }[] {
  const seen = new Map<string, string[]>();
  for (const pass of passes)
    for (const v of pass) {
      const key = `${v.checkId}|${v.threadId}`;
      (seen.get(key) ?? seen.set(key, []).get(key)!).push(v.answer);
    }
  const byCheck = new Map<string, string[][]>();
  for (const [key, answers] of seen) {
    const checkId = key.split("|")[0]!;
    (byCheck.get(checkId) ?? byCheck.set(checkId, []).get(checkId)!).push(answers);
  }
  return [...byCheck].map(([checkId, items]) => {
    let agree = 0;
    let unanimous = 0;
    for (const answers of items) {
      if (new Set(answers).size === 1) unanimous += 1;
      let pairs = 0;
      let same = 0;
      for (let i = 0; i < answers.length; i++)
        for (let j = i + 1; j < answers.length; j++) {
          pairs += 1;
          if (answers[i] === answers[j]) same += 1;
        }
      agree += pairs ? same / pairs : 1;
    }
    return { checkId, agreement: items.length ? agree / items.length : 1, unanimous, items: items.length };
  });
}

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}
