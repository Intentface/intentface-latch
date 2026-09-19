import { experimental_evaluate, generateObject } from "ai";
import type {
  Experimental_EvaluationModel,
  Experimental_EvaluationQuestion,
  LanguageModel,
} from "ai";
import { z } from "zod";

/**
 * Judge a whole rubric set in ONE call.
 *
 * The previous shape was one `generateObject` per criterion — deliberate
 * ("isolation over cost"), and the isolation is real: criteria graded together
 * in free text contaminate each other. `experimental_evaluate` keeps the
 * isolation and drops the cost, because the evaluation contract evaluates
 * every question against one shared state "in parallel and in isolation" by
 * construction. Five rubrics go from five calls to one.
 *
 * Two things change besides the count:
 *
 *   PROBABILITIES, not a coin flip. A boolean answer arrives as P(true), so a
 *   verdict at 0.51 is distinguishable from one at 0.99. That is what makes a
 *   threshold meaningful, what makes calibration measurable, and what turns
 *   "is a cheaper judge good enough" into a comparison instead of a bet.
 *
 *   PORTABILITY. The judge is an id: `claude-haiku-4-5`, `jev-latest`,
 *   `gpt-5.6-luna`. Nothing here knows which answered.
 *
 * WHAT IT COSTS: an evaluation model returns no prose, so the judge's one-line
 * reason is gone from the scoring call. It is recovered with a SECOND call that
 * explains only the criteria that actually failed — which is the only place
 * anyone reads it. A run where everything passes now makes one call instead of
 * five; a run with a failure makes two.
 */

/** Which kind of judgment a rubric asks for. */
export type RubricScale = "boolean" | "score" | "choice";

/**
 * Stored rubrics predate the rename and say `"binary"`. Both spellings mean
 * the same thing and always have; normalize on read so no migration is needed
 * and a rubric written by an older client keeps working.
 */
export function normalizeScale(scale: string | undefined): RubricScale {
  if (scale === "score") return "score";
  if (scale === "choice") return "choice";
  return "boolean";
}

/**
 * Ask "is this graded?" rather than "is this binary?".
 *
 * The inverted test is what makes the synonym safe: code that branches on
 * `scale === "binary"` silently takes its GRADED path the moment a rubric is
 * saved as `"boolean"`, turning a 0/1 verdict into a 0-1 score everywhere it
 * is displayed or written to Langfuse. Testing for the one spelling that means
 * graded cannot break that way.
 */
export function isGradedScale(scale: string | undefined): boolean {
  return normalizeScale(scale) === "score";
}

export interface RubricSpec {
  /** Stable name — the score name downstream. */
  name: string;
  /** The plain-English criterion. */
  prompt: string;
  scale?: string;
  /** Choice rubrics: option name → what it means. */
  options?: Record<string, string>;
  /** Choice rubrics: which options count as a failure. */
  bad?: string[];
}

export interface RubricOutcome {
  name: string;
  /**
   * 1/0 for a boolean, 0–1 for a score, and for a choice the pass/fail
   * projection — so an aggregate over any scale is still a pass rate.
   */
  value: number;
  /** The option a choice rubric selected. Absent for the other scales. */
  choice?: string;
  /**
   * The judge's raw calibrated number: P(true) for a boolean, the position
   * within the scale for a score. Kept because `value` throws away the
   * difference between "barely" and "certainly", which is exactly the
   * information needed to tell a good question from a coin flip.
   */
  probability: number;
  /** One line on why — only produced for criteria that failed. */
  comment?: string;
  /** Judge INFRA failure. Never a criterion failure; the caller skips the score. */
  error?: string;
}

/** The judge only ever sees a bounded slice of the answer. */
const ANSWER_CAP = 8_000;
const JUDGE_TIMEOUT_MS = 30_000;

/** Below this a boolean criterion counts as failed. */
const PASS_THRESHOLD = 0.5;

/** How many score levels a graded rubric is judged on. */
const SCORE_LEVELS = [
  "Clearly fails the criterion",
  "Partially satisfies it",
  "Largely satisfies it",
  "Fully satisfies it",
];

export interface JudgeEvidence {
  input: string;
  answer: string;
  /** Tool calls in order, pre-rendered and capped by the caller. */
  tools: string;
  /** Prior conversation text (the "chat" context scope), pre-capped. */
  conversation?: string;
}

/** The shared state every question is asked against. */
function stateOf(e: JudgeEvidence): Record<string, string> {
  return {
    ...(e.conversation
      ? {
          conversation_so_far:
            "Oldest first, tool activity excluded. The turn under judgment is the last exchange.\n" +
            e.conversation,
        }
      : {}),
    user_message: e.input,
    // Tools before the answer: what the agent DID is evidence, what it said
    // about what it did is a claim.
    tools_the_agent_called: e.tools,
    agent_answer: e.answer.slice(0, ANSWER_CAP),
  };
}

const INSTRUCTION_FRAME =
  "Judge ONLY this criterion against the agent's answer — not overall quality, tone, " +
  "or anything the criterion does not state. When genuinely ambiguous, judge it as not met.";

function toQuestion(r: RubricSpec): Experimental_EvaluationQuestion {
  const instructions = `${INSTRUCTION_FRAME}\n\nCRITERION: ${r.prompt}`;
  const scale = normalizeScale(r.scale);
  if (scale === "score") return { type: "score", instructions, criteria: SCORE_LEVELS };
  if (scale === "choice") {
    return { type: "choice", instructions, criteria: r.options ?? {} };
  }
  return { type: "boolean", instructions };
}

const EXPLANATIONS = z.object({
  explanations: z.array(
    z.object({
      name: z.string(),
      reason: z.string().describe("One short sentence on why it did not satisfy the criterion."),
    }),
  ),
});

/**
 * One call explaining every failed criterion — not one call per failure.
 * Contamination is acceptable here in a way it is not for scoring: these are
 * post-hoc descriptions of decisions already made, and nobody aggregates them.
 */
async function explainFailures(
  model: LanguageModel,
  evidence: JudgeEvidence,
  failed: RubricSpec[],
): Promise<Record<string, string>> {
  if (failed.length === 0) return {};
  const prompt = `An automated judge marked these criteria as NOT satisfied by the agent's answer. For each, give ONE short sentence saying why, referring to what the answer did or failed to do. Do not re-judge; explain.

CRITERIA:
${failed.map((r) => `- ${r.name}: ${r.prompt}`).join("\n")}

USER MESSAGE:
${evidence.input}

AGENT'S ANSWER:
${evidence.answer.slice(0, ANSWER_CAP)}

TOOLS THE AGENT CALLED (in order; long values truncated):
${evidence.tools}`;

  try {
    const { object } = await generateObject({
      model,
      schema: EXPLANATIONS,
      temperature: 0,
      prompt,
      abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    return Object.fromEntries(object.explanations.map((e) => [e.name, e.reason]));
  } catch {
    // A missing explanation must never change a verdict — the score stands,
    // the tooltip is simply empty.
    return {};
  }
}

export interface ScoreRubricsOptions {
  /**
   * The judge. Resolve it with `judgeModel(id)` — taken as a value rather than
   * an id so a test can pass a stand-in and never touch a provider, which is
   * the same property that lets `jev-latest` drop in unchanged.
   */
  model: Experimental_EvaluationModel;
  /** The same judge as a text model, for the failure explanations. Optional. */
  explainModel?: LanguageModel;
  rubrics: RubricSpec[];
  evidence: JudgeEvidence;
}

/**
 * Score every rubric against one turn.
 *
 * On an infrastructure failure EVERY rubric comes back carrying `error` and no
 * score, mirroring the previous per-criterion behaviour: a judge that could not
 * run must never look like an agent that failed.
 */
export async function scoreRubrics({
  model,
  explainModel,
  rubrics,
  evidence,
}: ScoreRubricsOptions): Promise<RubricOutcome[]> {
  if (rubrics.length === 0) return [];

  const questions: Record<string, Experimental_EvaluationQuestion> = {};
  // Names are unique per agent (validateRubrics enforces it), so they are safe
  // question keys and keep the mapping back obvious.
  for (const r of rubrics) questions[r.name] = toQuestion(r);

  let answers: Record<string, unknown>;
  try {
    const result = await experimental_evaluate({
      model,
      state: stateOf(evidence),
      questions,
      abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    answers = result.answers as Record<string, unknown>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return rubrics.map((r) => ({
      name: r.name,
      value: 0,
      probability: 0,
      error: `judge call failed: ${message.slice(0, 200)}`,
    }));
  }

  const outcomes = rubrics.map((r): RubricOutcome => {
    const a = answers[r.name] as
      | { type: "boolean"; probability: number }
      | { type: "score"; score: number }
      | { type: "choice"; choice: string; probabilities?: Record<string, number> }
      | undefined;
    if (!a) {
      return { name: r.name, value: 0, probability: 0, error: "judge returned no answer" };
    }
    if (a.type === "choice") {
      const bad = r.bad ?? [];
      return {
        name: r.name,
        // The stored number is the pass/fail projection; the label is the
        // detail. Aggregates keep meaning a pass rate across every scale.
        value: bad.includes(a.choice) ? 0 : 1,
        choice: a.choice,
        // Confidence in the option actually selected, not in "true".
        probability: a.probabilities?.[a.choice] ?? 1,
      };
    }
    if (a.type === "score") {
      // The contract reports a position among the levels; store it as 0–1 so
      // it lands in the same column a graded rubric always used.
      const normalized = a.score / (SCORE_LEVELS.length - 1);
      return { name: r.name, value: normalized, probability: normalized };
    }
    return {
      name: r.name,
      value: a.probability >= PASS_THRESHOLD ? 1 : 0,
      probability: a.probability,
    };
  });

  const failed = rubrics.filter((_, i) => !outcomes[i]!.error && outcomes[i]!.value < PASS_THRESHOLD);
  if (failed.length && explainModel) {
    const reasons = await explainFailures(explainModel, evidence, failed);
    for (const o of outcomes) {
      const reason = reasons[o.name];
      if (reason) o.comment = reason;
    }
  }
  return outcomes;
}
