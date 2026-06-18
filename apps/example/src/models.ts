import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, customProvider, type LanguageModel } from "ai";

/**
 * Provider registry — Latch's "own model routing" seam.
 *
 * Keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), read
 * by the provider packages — they never touch agent config, logs, or the model.
 * Agents reference *aliases* (`latch:default`, `latch:smart`, …), so swapping
 * the underlying model is a one-line change here, not a change in every agent.
 *
 * (AI Gateway alternative: set `AI_GATEWAY_API_KEY` and pass a string model id
 * like `"anthropic/claude-sonnet-4.6"` directly as the agent's `model` — no
 * provider packages, no registry. We use direct keys here per the project.)
 */
const anthropic = createAnthropic();
const openai = createOpenAI();

/** Friendly, intent-named aliases — the only ids agents should reference. */
const latch = customProvider({
  languageModels: {
    default: anthropic("claude-sonnet-4-6"),
    smart: anthropic("claude-opus-4-8"),
    fast: anthropic("claude-haiku-4-5"),
    openai: openai("gpt-5.5"),
  },
});

/**
 * The registry. Resolve either a friendly alias (`latch:default`) or a raw
 * provider id (`anthropic:claude-opus-4-8`, `openai:gpt-5.5`).
 */
const models = createProviderRegistry({ anthropic, openai, latch });

/**
 * Resolve an alias/id to a `LanguageModel` for use in `defineAgent`.
 * `id` is `provider:model` — `latch:default`, `anthropic:claude-opus-4-8`, etc.
 */
type ModelId = Parameters<typeof models.languageModel>[0];
export function model(id = "latch:default"): LanguageModel {
  return models.languageModel(id as ModelId);
}
