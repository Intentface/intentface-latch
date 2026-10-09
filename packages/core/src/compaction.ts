import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { safeFileDownload } from "./file-download.js";

/**
 * Conversation compaction: replace a long history with a summary the model reads
 * instead, so a chat that never ends (a Telegram DM, a months-old thread) stops
 * growing its prompt without losing what matters.
 *
 * The boundary itself is a projection concern (`sliceAtCompaction` in
 * `projections.ts`); this module only produces the summary text. Kept separate
 * from `runtime.ts` so the prompt is easy to find and tune.
 */

const COMPACTION_SYSTEM = `You compact conversations so they can continue in a smaller context window.

Write a summary that lets the assistant carry on as if it had read the whole
conversation. Preserve, in this order of priority:
1. What the user is trying to achieve, and any decisions already made.
2. Facts about the user and their situation that came up (names, numbers, dates,
   preferences, constraints) — these are usually irrecoverable once dropped.
3. What has been done so far, including tool results that still matter.
4. Anything explicitly left open, pending, or promised.

Rules:
- Write in the third person about "the user" and "the assistant".
- Be specific: keep concrete values, drop pleasantries and dead ends.
- Never invent anything. If something is unclear, say so plainly.
- No preamble, no headings-for-their-own-sake, no closing remarks — just the
  summary itself.`;

const instructionFor = (words: number) =>
  `Summarize the conversation above as described in your system prompt, so it can be continued in a fresh context window. Keep it under ${words} words. Output only the summary.`;

/**
 * Hard ceiling on the call. Generous on purpose: it is a backstop against a
 * runaway summary, NOT the mechanism that keeps summaries small — that's the word
 * target in the instruction. A tight ceiling here is actively harmful, because on
 * a model that thinks by default the thinking block spends this budget before any
 * summary text is produced, and the call ends truncated with nothing usable.
 */
const MAX_SUMMARY_TOKENS = 8000;
/** Asked-for length. Big enough to carry a long conversation's specifics. */
const SUMMARY_WORD_TARGET = 600;
/** Retry target after a truncated first attempt — decisively shorter. */
const RETRY_WORD_TARGET = 250;

/**
 * Summarize a conversation for compaction with a single tool-free model call.
 *
 * Deliberately NOT a normal agent turn: with the agent's own tools and
 * instructions in play the tool loop would go do work instead of summarizing.
 */
export async function summarizeForCompaction(input: {
  model: LanguageModel;
  messages: ModelMessage[];
  /** Extra steer from the caller, e.g. `/compact keep the training plan`. */
  focus?: string;
  /**
   * Provider options for the call. Callers should pass their "don't think"
   * mapping (see `resolveReasoningOptions`): summarizing needs no reasoning
   * block, and on a thinking-by-default model that block competes with the
   * summary for the same output budget.
   */
  providerOptions?: Record<string, unknown>;
  /** Abort a stalled provider (a request signal, or a caller-owned timeout). */
  signal?: AbortSignal;
}): Promise<{
  text: string;
  /** True when even the shortened retry hit `MAX_SUMMARY_TOKENS`. */
  truncated: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}> {
  const focus = input.focus?.trim();

  const attempt = async (words: number) => {
    const instruction = instructionFor(words);
    const res = await generateText({
      model: input.model,
      system: COMPACTION_SYSTEM,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
      // Cast for the same reason `buildTurn` casts its ToolLoopAgent options: the
      // hook's shape is `Record<string, unknown>` (it's host-supplied and
      // provider-specific), while the SDK wants `Record<string, JSONObject>`.
      ...(input.providerOptions
        ? { providerOptions: input.providerOptions as Record<string, never> }
        : {}),
      ...(input.signal ? { abortSignal: input.signal } : {}),
      // The history can carry file URLs: download them the same checked way.
      experimental_download: safeFileDownload({ signal: input.signal }),
      messages: [
        ...input.messages,
        {
          role: "user",
          content: focus
            ? `${instruction}\n\nPay particular attention to: ${focus}`
            : instruction,
        },
      ],
    });
    // Same shape the tool loop reads per step (`onStepEnd` in runtime.ts), so the
    // cached-prompt split reaches `computeCost` the same way.
    const u = res.usage as {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    } | undefined;
    return {
      text: res.text.trim(),
      truncated: res.finishReason === "length",
      usage: {
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
      },
    };
  };

  const first = await attempt(SUMMARY_WORD_TARGET);
  if (!first.truncated) return first;

  // Truncated: ask again for a decisively shorter summary rather than giving up.
  // A truncated summary must never be stored (it becomes the permanent head of
  // every later prompt), but failing outright would mean the longest
  // conversations — the ones that most need compacting — could never be.
  const retry = await attempt(RETRY_WORD_TARGET);
  return {
    ...retry,
    // Both calls were paid for; report the total so cost isn't understated.
    usage: {
      inputTokens: first.usage.inputTokens + retry.usage.inputTokens,
      outputTokens: first.usage.outputTokens + retry.usage.outputTokens,
      cacheReadTokens: first.usage.cacheReadTokens + retry.usage.cacheReadTokens,
      cacheWriteTokens: first.usage.cacheWriteTokens + retry.usage.cacheWriteTokens,
    },
  };
}
