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

const GRADED_VERDICT = z.object({
  score: z.number().min(0).max(1).describe("0 = clearly fails, 1 = fully satisfies."),
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

/** One generalized judge verdict — binary (pass) or graded (score 0–1). */
export interface JudgeVerdict {
  /** Set when scale is "binary". */
  pass?: boolean;
  /** Set when scale is "score" (0–1). */
  score?: number;
  reason: string;
  /** Judge INFRA error (bad JSON after retry, API down) — never a fail. */
  error?: string;
}

/**
 * Grade one criterion of one answer — the single judge call both tiers share:
 * the batch rubric path (binary) and the online attached-eval path (binary or
 * graded). Same prompt frame, caps, timeout, and retry-once semantics.
 */
export async function judgeOnce(
  model: LanguageModel,
  {
    input,
    answer,
    tools,
    criterion,
    scale = "binary",
  }: {
    input: string;
    answer: string;
    tools: string;
    criterion: string;
    scale?: "binary" | "score";
  },
): Promise<JudgeVerdict> {
  const graded = scale === "score";
  const verdictLine = graded
    ? `Give a score from 0 to 1 for how well the answer satisfies it; when genuinely ambiguous, score low with the ambiguity as the reason.`
    : `pass=true only if the answer clearly satisfies it; when genuinely ambiguous, fail with the ambiguity as the reason.`;
  const prompt = `You are grading ONE criterion of an AI agent's answer inside an automated eval. Judge ONLY the stated criterion — not overall quality, tone, or anything the criterion doesn't say. ${verdictLine}

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
      if (graded) {
        const { object } = await generateObject({
          model,
          schema: GRADED_VERDICT,
          temperature: 0,
          prompt,
          abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        });
        return { score: object.score, reason: object.reason };
      }
      const { object } = await generateObject({
        model,
        schema: VERDICT,
        temperature: 0,
        prompt,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      return { pass: object.pass, reason: object.reason };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    ...(graded ? { score: 0 } : { pass: false }),
    reason: "",
    error: `judge call failed: ${lastError.slice(0, 200)}`,
  };
}

async function judgeCriterion(
  model: LanguageModel,
  args: { input: string; answer: string; tools: string; criterion: string },
): Promise<RubricVerdict> {
  const v = await judgeOnce(model, { ...args, scale: "binary" });
  return { criterion: args.criterion, pass: v.pass ?? false, reason: v.reason, ...(v.error ? { error: v.error } : {}) };
}
