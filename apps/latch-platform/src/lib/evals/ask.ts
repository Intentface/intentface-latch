import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel, Experimental_EvaluationQuestion } from "ai";
import { transcriptOf } from "@/agents/eval-author";

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
 * no new dependency, `typeSafeAi.evaluationModel("jev-latest")` is ~17x
 * cheaper. Nothing else in this file changes when that swaps.
 *
 * What this deliberately does NOT do yet: slice long runs into windows (a
 * 200-step trace is rendered whole and will overflow a small judge), pair
 * results across agent versions, or decide whether a difference is real.
 * Those are the next pieces; this is the one they all sit on.
 */

/** JSON, structurally — the shape an evaluation model accepts as its state. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

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
}

/** A pick-one judgment, for when "no" hides two different behaviours. */
export interface ChoiceQuestion {
  ask: string;
  type: "choice";
  /** Option name → what that option means. */
  options: Record<string, string>;
  /** The options that count as a failure. */
  bad: string[];
}

export type Question = BooleanQuestion | ChoiceQuestion;

export interface Verdict {
  /** The key the question was registered under. */
  id: string;
  /** "true"/"false" for a boolean; the selected option for a choice. */
  answer: string;
  /**
   * P(true) for a boolean, P(selected option) for a choice. Keep it: a
   * verdict at 0.51 and one at 0.99 are not the same evidence, and the
   * difference is what tells you which questions the judge is good at.
   */
  confidence: number;
  /** Whether `answer` is on the side the question calls a failure. */
  failed: boolean;
}

/**
 * Caps. A judge with a small context window is the norm — the cheap ones are
 * cheap partly BECAUSE they are small — so the renderer bounds what it emits
 * rather than trusting the trace to be short.
 *
 * Tool results are the EVIDENCE a grounding question is asked about, so they
 * get far more room than a diagnostic transcript gives them: 500 chars is a
 * paragraph, and a judge asked "is this claim supported by what it read" would
 * see a clipped document and answer "no" about a perfectly correct answer.
 */
const MAX_TOOL_OUTPUT = 2_000;
const MAX_TOOL_ARGS = 400;
const MAX_MESSAGE_TEXT = 3_000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);

const compact = (v: unknown, n: number): string => {
  if (v === undefined) return "";
  try {
    return clip(typeof v === "string" ? v : JSON.stringify(v), n);
  } catch {
    return "[unserializable]";
  }
};

/**
 * Stored messages → the state the judge reads.
 *
 * Tool calls come FIRST in each message and the assistant's own text last,
 * because a judge shown the narration first tends to grade the narration. What
 * the agent DID is the evidence; what it said about what it did is a claim.
 */
export function renderTrace(messages: unknown[]): { conversation: Json[] } {
  const transcript = transcriptOf(messages, {
    text: MAX_MESSAGE_TEXT,
    toolOutput: MAX_TOOL_OUTPUT,
  });
  const conversation = transcript.map((m): Json => {
    // Key insertion order IS the order the judge reads them in.
    const entry: { [key: string]: Json } = { role: m.role };
    if (m.toolCalls.length) {
      entry.tools = m.toolCalls.map((tc): Json => {
        const t: { [key: string]: Json } = { name: tc.tool };
        if (tc.blocked) t.blocked = true;
        t.args = compact(tc.args, MAX_TOOL_ARGS);
        // Already clipped (and marked) by `transcriptOf`.
        t.result = tc.output ?? "";
        return t;
      });
    }
    entry.said = m.text;
    return entry;
  });
  return { conversation };
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
  abortSignal?: AbortSignal;
}

export interface AskResult {
  verdicts: Verdict[];
  usage: { inputTokens?: number; outputTokens?: number };
}

/**
 * Ask every question of one conversation, in a single call.
 *
 * Throws only on an infrastructure failure. A judge that answers is always
 * believed here — deciding WHETHER to believe a given question is a separate
 * job done against human-corrected labels, and conflating the two is how an
 * unvalidated question ends up gating a deploy.
 */
export async function askOfTrace({
  model,
  messages,
  questions,
  threshold = 0.5,
  abortSignal,
}: AskOptions): Promise<AskResult> {
  const ids = Object.keys(questions);
  if (ids.length === 0 || messages.length === 0) {
    return { verdicts: [], usage: {} };
  }

  const sdkQuestions: Record<string, Experimental_EvaluationQuestion> = {};
  for (const id of ids) sdkQuestions[id] = toSdkQuestion(questions[id]!);

  const { answers, usage } = await experimental_evaluate({
    model,
    state: renderTrace(messages),
    questions: sdkQuestions,
    abortSignal,
  });

  const verdicts = ids.map((id): Verdict => {
    const q = questions[id]!;
    const a = answers[id] as
      | { type: "boolean"; probability: number }
      | { type: "choice"; choice: string; probabilities?: Record<string, number> };

    if (a.type === "choice") {
      const q2 = q as ChoiceQuestion;
      return {
        id,
        answer: a.choice,
        confidence: a.probabilities?.[a.choice] ?? 1,
        failed: q2.bad.includes(a.choice),
      };
    }
    const isTrue = a.probability >= threshold;
    const bad = (q as BooleanQuestion).bad ?? "false";
    return {
      id,
      answer: isTrue ? "true" : "false",
      // Confidence in the answer GIVEN, not in "true" — otherwise a firm
      // "definitely not" reads as 0.02 confidence when it is the opposite.
      confidence: isTrue ? a.probability : 1 - a.probability,
      failed: (isTrue ? "true" : "false") === bad,
    };
  });

  return {
    verdicts,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
