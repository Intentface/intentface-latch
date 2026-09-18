import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Experimental_EvaluationModel } from "ai";

/**
 * Resolve a judge by model id, picking the provider from the id itself.
 *
 * The whole reason this is five lines rather than an integration is that the
 * AI SDK standardised the evaluation contract: `jev-latest` and
 * `claude-haiku-4-5` are the same interface, so nothing downstream — slicing,
 * aggregation, statistics, or a single test — knows which one answered.
 *
 * That makes "which judge should we use" a MEASUREMENT rather than a
 * procurement decision: run the same conversations through two ids, compare
 * the verdicts against each other and against human corrections, and keep the
 * one that agrees with you for the price you want to pay.
 *
 * Each provider reads its own key from the environment:
 *   jev-*     TYPESAFE_AI_API_KEY
 *   claude-*  ANTHROPIC_API_KEY
 *   gpt-*     OPENAI_API_KEY
 *   gemini-*  GOOGLE_GENERATIVE_AI_API_KEY
 *
 * Keys are read lazily by the providers, so a missing one fails at the first
 * call rather than at import — which is what lets a process resolve a judge it
 * never ends up using.
 */
const PROVIDERS: { matches: RegExp; provider: string; model: (id: string) => Experimental_EvaluationModel }[] = [
  { matches: /^jev/, provider: "typesafe-ai", model: (id) => typeSafeAi.evaluationModel(id) },
  { matches: /^claude/, provider: "anthropic", model: (id) => anthropic.evaluationModel(id) },
  { matches: /^gpt|^o\d/, provider: "openai", model: (id) => openai.evaluationModel(id) },
  { matches: /^gemini/, provider: "google", model: (id) => google.evaluationModel(id) },
];

/** Which provider an id resolves to, without constructing anything. */
export function providerOf(modelId: string): string | undefined {
  return PROVIDERS.find((p) => p.matches.test(modelId))?.provider;
}

export function judgeModel(modelId: string): Experimental_EvaluationModel {
  const entry = PROVIDERS.find((p) => p.matches.test(modelId));
  if (!entry) {
    // Guessing a provider from an unknown id would surface as a confusing
    // auth error from whichever one we guessed. Say what happened instead.
    throw new Error(
      `No evaluation provider for judge "${modelId}". Known prefixes: ` +
        `${PROVIDERS.map((p) => String(p.matches).replace(/[/^]/g, "")).join(", ")}.`,
    );
  }
  return entry.model(modelId);
}
