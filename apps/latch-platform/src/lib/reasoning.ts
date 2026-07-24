import type { ModelInfo } from "./models";

/**
 * Per-agent reasoning effort. Providers don't share one knob — OpenAI takes an
 * effort enum, Anthropic/Google take a thinking-token budget — so a single
 * `effort` level is mapped to each provider's shape here (the platform owns the
 * provider specifics, like `resolveProviderTools`). Gated to reasoning-capable
 * models so a non-thinking model is a no-op rather than an API error.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

/** Thinking-token budgets per effort (Anthropic/Google). OpenAI uses the enum directly. */
const BUDGET: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 2048,
  medium: 8192,
  high: 16384,
};

export interface ReasoningResolution {
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
}

/**
 * Build the `RuntimeConfig.resolveReasoningOptions` hook over the model catalog.
 * Returns `providerOptions` (keyed by provider id) plus a safe `maxOutputTokens`
 * for the token-budget providers (the budget must stay under the model's max
 * output, and the answer needs room after thinking).
 */
export function makeResolveReasoningOptions(models: ModelInfo[]) {
  const byId = new Map(models.map((m) => [m.id, m]));
  return (modelId: string, effort: string): ReasoningResolution | undefined => {
    const info = byId.get(modelId);
    const eff = EFFORTS.includes(effort as ReasoningEffort)
      ? (effort as ReasoningEffort)
      : undefined;
    // No (valid) effort, or a model not known to support reasoning: don't
    // touch thinking config — but still lift the SDK's tiny Anthropic/Google
    // default max_tokens (4096). Models that think by DEFAULT (e.g.
    // claude-sonnet-5) can burn all 4096 inside the thinking block on a heavy
    // turn and end the run with an empty message.
    if (!eff || !info?.reasoning) {
      // Same fallback as the effort path: a catalog entry without maxOutput
      // must still lift the 4096 default.
      return info?.provider === "anthropic" || info?.provider === "google"
        ? { maxOutputTokens: Math.min(info.maxOutput ?? 32_000, 32_000) }
        : undefined;
    }
    const provider = info.provider;

    if (provider === "openai") {
      return { providerOptions: { openai: { reasoningEffort: eff } } };
    }

    // Token-budget providers (Anthropic, Google): cap the budget under the
    // model's max output, and set maxOutputTokens so the answer has room.
    const max = info.maxOutput ?? 32_000;
    const budget = Math.min(BUDGET[eff], Math.max(1024, Math.floor(max / 2)));
    const maxOutputTokens = Math.min(max, budget + 8192);

    if (provider === "google") {
      return {
        providerOptions: {
          google: { thinkingConfig: { thinkingBudget: eff === "minimal" ? 0 : budget, includeThoughts: true } },
        },
        maxOutputTokens,
      };
    }

    // Anthropic: minimal turns thinking off; otherwise an explicit budget.
    if (eff === "minimal") {
      return { providerOptions: { anthropic: { thinking: { type: "disabled" } } } };
    }
    return {
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: budget }, sendReasoning: true } },
      maxOutputTokens,
    };
  };
}
