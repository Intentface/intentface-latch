import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel, Experimental_EvaluationQuestion } from "ai";
import { sliceTrace, type Slice, type SliceOptions } from "./slice";

/**
 * Ask plain-English questions ABOUT a stored conversation.
 *
 * The unit here is a question, not a test case, and the difference is the
 * whole point: a test case has to be RUN (spin up the agent, pay for the
 * inference), so it only ever tells you about the version you're on. A
 * question is asked of a transcript that already exists, so a question written
 * today applies to every conversation ever stored — including the ones that
 * happened before anyone thought to ask.
 *
 * Answers come back as probabilities from an `EvaluationModel`: one forward
 * pass for ALL questions against ONE state, no prose generated. Which model
 * answers them is a caller's choice — `anthropic.evaluationModel(...)` needs
 * no new dependency, `typeSafeAi.evaluationModel("jev-latest")` is the same
 * call. Nothing else in this file changes when that swaps, which is what makes
 * "is that judge better here" a measurement rather than a bet.
 */

/**
 * How per-slice answers become one verdict, and the sharpest trap in the whole
 * design.
 *
 *   "any"   — the run fails if ANY slice fails. Right for a question about a
 *             property every part should have ("every claim is supported by a
 *             document it opened"), and for spotting something bad that
 *             happened once.
 *
 *   "every" — the run fails only if EVERY slice fails. Right for an EXISTENCE
 *             question ("did it open a document?"). Under "any" such a
 *             question fails the moment one window happens to contain no tool
 *             calls, which is most windows, so a perfectly good run is marked
 *             broken by the slicing rather than by the agent.
 *
 * It only matters for a run long enough to need slicing; a conversation that
 * fits is one slice and both rules agree.
 */
export type Aggregation = "any" | "every";

/** A yes/no judgment. The common case: "did it do the right thing?" */
export interface BooleanQuestion {
  /** The question, in plain English, as you'd brief a reviewer. */
  ask: string;
  type?: "boolean";
  /**
   * Which answer is the FAILURE. Defaults to "false", i.e. the question is
   * phrased so that "yes" is good — keep it that way and `bad` stays implicit.
   */
  bad?: "true" | "false";
  /** How answers combine when a run had to be sliced. Defaults to "any". */
  agg?: Aggregation;
}

/** A pick-one judgment, for when "no" hides two different behaviours. */
export interface ChoiceQuestion {
  ask: string;
  type: "choice";
  /** Option name → what that option means. */
  options: Record<string, string>;
  /** The options that count as a failure. */
  bad: string[];
  /** How answers combine when a run had to be sliced. Defaults to "any". */
  agg?: Aggregation;
}

export type Question = BooleanQuestion | ChoiceQuestion;

/** One question's answer about one slice. */
export interface SliceVerdict {
  id: string;
  /** Which slice this came from. */
  slice: number;
  /** "true"/"false" for a boolean; the selected option for a choice. */
  answer: string;
  /**
   * Confidence in the answer GIVEN. Keep it: a verdict at 0.51 and one at 0.99
   * are not the same evidence, and the difference is what eventually tells you
   * which questions this judge is good at.
   */
  confidence: number;
  failed: boolean;
}

/** One question's verdict about the whole run, after aggregation. */
export interface Verdict {
  id: string;
  /** The aggregated call. */
  failed: boolean;
  /** The answer from the slice that decided it. */
  answer: string;
  confidence: number;
  /** How many slices the run needed (1 when it fit whole). */
  slices: number;
  /** Slice indices that failed — where to look first. */
  failedSlices: number[];
}

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  /** Judge calls made. One per slice; the honest unit of cost. */
  calls: number;
}

export interface AskResult {
  verdicts: Verdict[];
  /** Every per-slice answer, for debugging a surprising verdict. */
  perSlice: SliceVerdict[];
  usage: AskUsage;
}

/** Our question shape → the SDK's. */
function toSdkQuestion(q: Question): Experimental_EvaluationQuestion {
  if (q.type === "choice") {
    return { type: "choice", instructions: q.ask, criteria: q.options };
  }
  return { type: "boolean", instructions: q.ask };
}

export interface AskOptions {
  model: Experimental_EvaluationModel;
  /** The stored conversation, as `runtime.loadHistory` returns it. */
  messages: unknown[];
  /** Questions keyed by a STABLE id — results and history key on it. */
  questions: Record<string, Question>;
  /**
   * Where a boolean answer flips. 0.5 is the honest default; raise it for a
   * question that gates a release, so a coin-flip verdict doesn't block one.
   */
  threshold?: number;
  /** Passed through to `sliceTrace`. */
  slicing?: SliceOptions;
  /** Judge calls in flight at once, when a run needed slicing. */
  concurrency?: number;
  abortSignal?: AbortSignal;
}

/** Ask every question of one slice, in one call. */
async function askSlice(
  model: Experimental_EvaluationModel,
  slice: Slice,
  questions: Record<string, Question>,
  threshold: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ verdicts: SliceVerdict[]; inputTokens: number; outputTokens: number }> {
  const sdkQuestions: Record<string, Experimental_EvaluationQuestion> = {};
  for (const [id, q] of Object.entries(questions)) sdkQuestions[id] = toSdkQuestion(q);

  const { answers, usage } = await experimental_evaluate({
    model,
    state: slice.state,
    questions: sdkQuestions,
    abortSignal,
  });

  const verdicts = Object.entries(questions).map(([id, q]): SliceVerdict => {
    const a = answers[id] as
      | { type: "boolean"; probability: number }
      | { type: "choice"; choice: string; probabilities?: Record<string, number> };

    if (a.type === "choice") {
      return {
        id,
        slice: slice.index,
        answer: a.choice,
        confidence: a.probabilities?.[a.choice] ?? 1,
        failed: (q as ChoiceQuestion).bad.includes(a.choice),
      };
    }
    const isTrue = a.probability >= threshold;
    const answer = isTrue ? "true" : "false";
    return {
      id,
      slice: slice.index,
      answer,
      // Confidence in the answer GIVEN, not in "true" — otherwise a firm
      // "definitely not" reads as 0.02 confidence when it is the opposite.
      confidence: isTrue ? a.probability : 1 - a.probability,
      failed: answer === ((q as BooleanQuestion).bad ?? "false"),
    };
  });

  return {
    verdicts,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/** Run `jobs` with at most `limit` in flight, preserving order. */
async function pooled<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < jobs.length; i = next++) out[i] = await jobs[i]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/**
 * Ask every question of a whole conversation, slicing it first if it is too
 * long for the judge to read at once.
 *
 * Throws only on an infrastructure failure. A judge that answers is always
 * believed here — deciding WHETHER to believe a given question is a separate
 * job, done against human-corrected labels, and conflating the two is how an
 * unvalidated question ends up gating a deploy.
 */
export async function askOfTrace({
  model,
  messages,
  questions,
  threshold = 0.5,
  slicing,
  concurrency = 4,
  abortSignal,
}: AskOptions): Promise<AskResult> {
  const empty: AskResult = {
    verdicts: [],
    perSlice: [],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
  };
  const ids = Object.keys(questions);
  if (ids.length === 0 || messages.length === 0) return empty;

  const slices = sliceTrace(messages, slicing);
  if (slices.length === 0) return empty;

  const results = await pooled(
    slices.map((s) => () => askSlice(model, s, questions, threshold, abortSignal)),
    concurrency,
  );

  const perSlice = results.flatMap((r) => r.verdicts);
  const verdicts = ids.map((id): Verdict => {
    const mine = perSlice.filter((v) => v.id === id);
    const agg = questions[id]!.agg ?? "any";
    const failedSlices = mine.filter((v) => v.failed);
    const failed =
      agg === "every" ? failedSlices.length === mine.length : failedSlices.length > 0;

    // Report the answer from the slice that DECIDED the verdict, so a failure
    // points at the evidence rather than at slice 0 by accident.
    const deciding = failed
      ? (failedSlices[0] ?? mine[0]!)
      : (mine.find((v) => !v.failed) ?? mine[0]!);

    return {
      id,
      failed,
      answer: deciding.answer,
      confidence: deciding.confidence,
      slices: slices.length,
      failedSlices: failedSlices.map((v) => v.slice),
    };
  });

  return {
    verdicts,
    perSlice,
    usage: {
      inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.outputTokens, 0),
      calls: results.length,
    },
  };
}
