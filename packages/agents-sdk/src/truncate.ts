/**
 * truncate.ts — keep one enormous tool result from eating the conversation.
 *
 * A single `grep` or a chatty API can return more text than the rest of the
 * transcript combined, and because `tool_result` is one of the three moments
 * that write history, an untruncated blob is not just an expensive turn — it
 * is in the conversation forever, re-sent on every subsequent step.
 *
 * Two details matter more than the trimming itself:
 *
 *   The model must be TOLD it was truncated, or it will reason about a partial
 *   answer as though it were whole, and confidently report the wrong count.
 *
 *   Keep the head, not the tail. Tool output is usually most informative at the
 *   start — a header row, the first matches, the error — and a middle-out trim
 *   reads worse than an honest "first N characters".
 */
import { defineExtension, type Extension } from "./extension.js";

export interface TruncateOptions {
  /** Characters of serialised output to keep. */
  maxChars?: number;
  /** Leave these tools alone, whatever they return. */
  exempt?: string[];
  /** Called when something was actually trimmed. */
  onTruncate?: (info: { toolName: string; from: number; to: number }) => void;
}

/** The shape a truncated result takes, so a consumer can recognise one. */
export interface TruncatedOutput {
  truncated: true;
  toolName: string;
  originalChars: number;
  keptChars: number;
  note: string;
  output: string;
}

export const isTruncated = (v: unknown): v is TruncatedOutput =>
  typeof v === "object" && v !== null && (v as { truncated?: unknown }).truncated === true;

export function truncateToolOutput(options: TruncateOptions = {}): Extension {
  const maxChars = options.maxChars ?? 8_000;
  const exempt = new Set(options.exempt ?? []);

  return defineExtension("truncate", (ext) =>
    ext.on("tool_result", ({ toolName, output, isError }) => {
      if (isError || exempt.has(toolName) || output == null) return;

      // Already truncated by someone else; trimming twice would compound the loss.
      if (isTruncated(output)) return;

      const text = typeof output === "string" ? output : safeStringify(output);
      if (text.length <= maxChars) return;

      options.onTruncate?.({ toolName, from: text.length, to: maxChars });

      const result: TruncatedOutput = {
        truncated: true,
        toolName,
        originalChars: text.length,
        keptChars: maxChars,
        // Addressed to the model, because it is the one that will otherwise
        // treat a partial answer as a complete one.
        note: `Output was ${text.length} characters and has been cut to the first ${maxChars}. This is NOT the whole result — say so if it matters, and narrow the call rather than guessing at what was cut.`,
        output: text.slice(0, maxChars),
      };
      return { output: result };
    }),
  ) as Extension;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // Circular or otherwise unserialisable: length still matters, content less so.
    return String(v);
  }
}
