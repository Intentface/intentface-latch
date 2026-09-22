import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  Experimental_EvaluationModelV4CallOptions as CallOptions,
  Experimental_EvaluationModelV4Result as Result,
  Experimental_EvaluationModelV4Question as Question,
} from "@ai-sdk/provider";

/**
 * An ordinary language model, wrapped as an evaluation model.
 *
 * Which judge to use is a MEASUREMENT, not a procurement decision. Jev is
 * purpose-built and cheap; a frontier model is slower and dearer and may be
 * better on a hard question. The only way to find out is to run the same rows
 * through both and compare them against human rulings — which requires them to
 * be interchangeable, which requires this adapter.
 *
 * What is lost against a native evaluation model: real probabilities. An LLM
 * asked to report its own confidence reports a number that reads like one and
 * is not calibrated. We take it, and the reliability loop is what decides
 * whether to believe it.
 */

const BooleanVerdict = z.object({
  answer: z.boolean(),
  confidence: z.number().min(0).max(1).describe("How sure you are of the answer you gave."),
  reason: z.string().describe("At most 40 words: the decisive evidence."),
});

const ChoiceVerdict = z.object({
  choice: z.string().describe("Exactly one option name."),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("At most 40 words: the decisive evidence."),
});

const ScoreVerdict = z.object({
  level: z.number().int().describe("Zero-based index of the level that fits best."),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("At most 40 words: the decisive evidence."),
});

const asText = (v: unknown): string =>
  typeof v === "string" ? v : JSON.stringify(v, null, 2);

function promptFor(state: unknown, q: Question): string {
  const head = `${asText(state)}\n\n---\n\n${asText(q.instructions)}`;
  if (q.type === "choice") {
    const opts = Object.entries(q.criteria)
      .map(([name, means]) => `- ${name}: ${means === null ? "" : asText(means)}`)
      .join("\n");
    return `${head}\n\nPick exactly one:\n${opts}`;
  }
  if (q.type === "score") {
    const rungs = q.criteria
      .map((c, i) => `${i}. ${c === null ? "" : asText(c)}`)
      .join("\n");
    return `${head}\n\nLevels, worst to best:\n${rungs}`;
  }
  const t = q.criteria?.true;
  const f = q.criteria?.false;
  return `${head}${t ? `\n\ntrue means: ${asText(t)}` : ""}${f ? `\nfalse means: ${asText(f)}` : ""}`;
}

/**
 * Probability, in the contract's terms.
 *
 * The trap the contract names: `probability` is P(true), not confidence in the
 * answer given. A judge that is 95% sure the answer is "no" reports 0.05 —
 * displayed naively that reads as 5% confident when it is nearly certain.
 */
const pTrue = (answer: boolean, confidence: number): number =>
  answer ? confidence : 1 - confidence;

export function llmEvaluationModel(model: LanguageModel, modelId = "llm"): EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "latch.llm-as-judge",
    modelId,
    supportedQuestionTypes: ["boolean", "choice", "score"],
    async doEvaluate(options: CallOptions): Promise<Result> {
      const entries = Object.entries(options.questions);
      // One call per question, not one per state: an LLM asked several
      // unrelated judgments at once answers the easy one and lets it colour
      // the rest. A native evaluation model shares the forward pass and does
      // not have that problem — this adapter pays for the difference.
      const usage = { inputTokens: 0, outputTokens: 0 };
      const answers: Result["answers"] = {};
      await Promise.all(
        entries.map(async ([id, q]) => {
          const schema =
            q.type === "boolean" ? BooleanVerdict : q.type === "choice" ? ChoiceVerdict : ScoreVerdict;
          const res = await generateObject({
            model,
            schema,
            temperature: 0,
            abortSignal: options.abortSignal,
            prompt: promptFor(options.state, q),
          });
          usage.inputTokens += res.usage?.inputTokens ?? 0;
          usage.outputTokens += res.usage?.outputTokens ?? 0;
          const v = res.object as z.infer<typeof BooleanVerdict> &
            z.infer<typeof ChoiceVerdict> &
            z.infer<typeof ScoreVerdict>;
          if (q.type === "boolean") {
            answers[id] = { type: "boolean", probability: pTrue(v.answer, v.confidence) };
          } else if (q.type === "choice") {
            // A model that invents an option name must not fail the run — the
            // nearest declared option is a normalization job, not a verdict.
            const names = Object.keys(q.criteria);
            const hit =
              names.find((n) => n === v.choice) ??
              names.find((n) => v.choice?.toLowerCase().includes(n.toLowerCase())) ??
              names[0]!;
            answers[id] = { type: "choice", choice: hit };
          } else {
            const max = q.criteria.length - 1;
            answers[id] = { type: "score", score: Math.max(0, Math.min(max, v.level)) };
          }
        }),
      );
      return { answers, usage, warnings: [] };
    },
  };
}

/** Jev — purpose-built, one forward pass for every question, cheap. */
export const DEFAULT_JUDGE = "jev-latest";

/**
 * Resolve a judge id to an evaluation model.
 *
 * `jev-*` goes to TypeSafe's native evaluation endpoint; anything else is
 * treated as a language model id and wrapped. That is what makes a rubric able
 * to say "this dimension is hard, give it a bigger model" while the rest stay
 * on the cheap one — a per-dimension decision, and a reversible one.
 */
export function evaluationModelFor(
  id: string,
  modelFor: (id: string) => LanguageModel,
  typeSafe: { evaluationModel: (id: string) => EvaluationModel },
): EvaluationModel {
  return id.startsWith("jev") ? typeSafe.evaluationModel(id) : llmEvaluationModel(modelFor(id), id);
}
