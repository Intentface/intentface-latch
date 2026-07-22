import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { EvalToolCall, RubricVerdict } from "./store";

/**
 * The LLM-judge grader tier: rubric criteria are plain-language checks graded
 * by a PINNED cheap model — one call per criterion (isolation over cost),
 * temperature 0, strict JSON verdict. Semantics live with the caller (run.ts):
 * a failed criterion fails the case like any deterministic check; a judge
 * INFRA error (bad JSON after retry, API down) never does.
 *
 * Determinism hygiene: the model id is a code constant, resolved via the
 * catalog with an explicit existence check (run_evals errors loudly instead
 * of silently judging with a fallback model), and recorded on the run row.
 */
export const JUDGE_MODEL_ID = "claude-haiku-4-5";

const VERDICT = z.object({
  pass: z.boolean(),
  reason: z.string().describe("One short sentence on why."),
});

/** The judge only ever sees a bounded slice of the answer. */
const ANSWER_CAP = 8_000;
/** Hard wall-clock bound per judge call — a stalled provider must not hang the run. */
const JUDGE_TIMEOUT_MS = 30_000;

export interface JudgeCaseInput {
  model: LanguageModel;
  /** The case's user message. */
  input: string;
  /** The agent's full answer. */
  answer: string;
  /** Observed tool calls — the judge sees NAMES only (args stay deterministic-tier). */
  toolCalls: EvalToolCall[];
  criteria: string[];
}

/** Grade every rubric criterion of one case (calls run concurrently, ≤5 by the save-time cap). */
export async function judgeRubric({
  model,
  input,
  answer,
  toolCalls,
  criteria,
}: JudgeCaseInput): Promise<RubricVerdict[]> {
  const tools = toolCalls.length
    ? toolCalls.map((tc) => (tc.blocked ? `${tc.tool} (blocked)` : tc.tool)).join(", ")
    : "none";
  return Promise.all(
    criteria.map((criterion) => judgeCriterion(model, { input, answer, tools, criterion })),
  );
}

async function judgeCriterion(
  model: LanguageModel,
  { input, answer, tools, criterion }: { input: string; answer: string; tools: string; criterion: string },
): Promise<RubricVerdict> {
  const prompt = `You are grading ONE criterion of an AI agent's answer inside an automated eval. Judge ONLY the stated criterion — not overall quality, tone, or anything the criterion doesn't say. pass=true only if the answer clearly satisfies it; when genuinely ambiguous, fail with the ambiguity as the reason.

CRITERION: ${criterion}

USER MESSAGE:
${input}

AGENT'S ANSWER:
${answer.slice(0, ANSWER_CAP)}

TOOLS THE AGENT CALLED (names, in order): ${tools}`;

  let lastError = "";
  // One retry on a malformed verdict; then an error marker (never a case fail).
  // Each attempt gets its own hard timeout — a hung call counts as an attempt.
  for (let i = 0; i < 2; i++) {
    try {
      const { object } = await generateObject({
        model,
        schema: VERDICT,
        temperature: 0,
        prompt,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      return { criterion, pass: object.pass, reason: object.reason };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { criterion, pass: false, reason: "", error: `judge call failed: ${lastError.slice(0, 200)}` };
}
