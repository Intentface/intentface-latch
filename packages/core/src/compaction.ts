import { generateText, type LanguageModel, type ModelMessage } from "ai";

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

const COMPACTION_INSTRUCTION = `Summarize the conversation above as described in your system prompt, so it can be continued in a fresh context window. Output only the summary.`;

/**
 * Hard ceiling on the summary. A summary that runs away is worse than no
 * compaction at all — it becomes the permanent head of every later prompt, so it
 * must be decisively smaller than the history it replaces.
 */
const MAX_SUMMARY_TOKENS = 2000;

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
  /** Abort a stalled provider (a request signal, or a caller-owned timeout). */
  signal?: AbortSignal;
}): Promise<{
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}> {
  const focus = input.focus?.trim();
  const res = await generateText({
    model: input.model,
    system: COMPACTION_SYSTEM,
    maxOutputTokens: MAX_SUMMARY_TOKENS,
    ...(input.signal ? { abortSignal: input.signal } : {}),
    messages: [
      ...input.messages,
      {
        role: "user",
        content: focus
          ? `${COMPACTION_INSTRUCTION}\n\nPay particular attention to: ${focus}`
          : COMPACTION_INSTRUCTION,
      },
    ],
  });
  // Same shape the tool loop reads per step (`onStepEnd` in runtime.ts), so the
  // cached-prompt split reaches `computeCost` the same way.
  const usage = res.usage as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  } | undefined;
  return {
    text: res.text.trim(),
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    },
  };
}
