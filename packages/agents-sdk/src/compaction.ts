/**
 * compaction.ts — keep the conversation fitting the model, without taking it
 * away from the person.
 *
 * The shape that matters: NOTHING IS DELETED. A marker is inserted at the
 * boundary and every original turn stays in storage, so a reader scrolls back
 * and sees the whole thing. Only the MODEL's view shrinks, to the summary plus
 * everything after the marker.
 *
 * The summary text is never a message. It lives as data on the marker, and the
 * `context` lens prepends it as a synthetic turn the model reads and nobody
 * stores. That keeps the reader's transcript free of a paragraph restating
 * what is already above it — they get a divider saying how many turns were
 * folded, and the real turns either side of it.
 *
 * The first version replaced history outright — less code, wrong behaviour. A
 * summary is a reading aid for the model, not a reason for a person to lose
 * what they said, and trimming someone's transcript to save tokens charges a
 * cost to the wrong account.
 *
 * One rule survives from that version. Never place the boundary past an
 * unanswered tool call: that call IS a suspended run's resume point — an
 * approval waiting for a person, a browser tool waiting for an answer — and
 * hiding it from the model strands the run.
 */
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { convertToModelMessages, generateText } from "ai";
import { defineExtension, type Extension, type Part } from "./extension.js";

/**
 * The boundary marker. Carries the summary as DATA, not as readable text: the
 * model gets it through the `context` lens, and a client renders this part as
 * a divider rather than as another paragraph.
 */
export const SUMMARY_PART = "data-compaction-summary";

/** What the marker carries, for a client that wants to render a real divider. */
export interface SummaryMarker {
  summary: string;
  summarised: number;
  kept: number;
  at: string;
}

/** Streamed when a summary was inserted, so a client can refetch. */
export const COMPACTED_PART = "data-compacted";

export interface CompactionInfo {
  runId: string;
  /** Turns the summary stands in for. They are still in storage. */
  summarised: number;
  /** Turns after the boundary, which the model reads verbatim. */
  kept: number;
  summary: string;
}

export interface CompactionOptions {
  /** The summariser. Often a cheaper model than the one running the conversation. */
  model: LanguageModel;
  /** Insert a boundary once this many messages sit past the last one. */
  afterMessages?: number;
  /** Recent messages the model always reads verbatim. */
  keepLast?: number;
  /** Steer what the summary preserves. */
  instructions?: string;
  /** Also register a slash command that summarises now. `false` to omit. */
  command?: string | false;
  onCompact?: (info: CompactionInfo) => void | Promise<void>;
  /** Fail the run if summarising fails, rather than carrying on uncompacted. */
  critical?: boolean;
}

const isSummary = (m: UIMessage) => (m.parts as Part[]).some((p) => p.type === SUMMARY_PART);

/** A tool call with no answer yet: an approval, or a tool the browser still owes. */
function hasOpenToolCall(m: UIMessage): boolean {
  return (m.parts as Array<{ type: string; state?: string }>).some(
    (p) =>
      (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
      (p.state === "approval-requested" || p.state === "input-available"),
  );
}

const textOf = (m: UIMessage) =>
  (m.parts as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();

const markerOf = (m: UIMessage): SummaryMarker | undefined =>
  (m.parts as Array<{ type: string; data?: unknown }>).find((p) => p.type === SUMMARY_PART)
    ?.data as SummaryMarker | undefined;

const summaryTextOf = (m: UIMessage) => markerOf(m)?.summary ?? "";

/** Index of the newest summary, or -1. The model's view starts here. */
export const lastSummaryIndex = (messages: UIMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) if (isSummary(messages[i]!)) return i;
  return -1;
};

/**
 * Where the next boundary goes, or nothing if there is too little behind it.
 *
 * One function so the COMMAND and the MOMENT cannot disagree — deciding twice
 * is how `/compact` once reported success on a conversation it then declined
 * to touch.
 */
export function compactionPlan(
  messages: UIMessage[],
  opts: { keepLast: number; force: boolean },
): { at: number } | undefined {
  const keep = opts.force ? Math.min(opts.keepLast, 4) : opts.keepLast;
  let at = messages.length - keep;

  const firstOpen = messages.findIndex(hasOpenToolCall);
  if (firstOpen !== -1) at = Math.min(at, firstOpen);

  // Nothing is gained by summarising what already sits behind a summary.
  const since = lastSummaryIndex(messages);
  return at > since + 2 ? { at } : undefined;
}

const DEFAULT_INSTRUCTIONS = [
  "Summarise the conversation so far for an assistant that will continue it.",
  "Keep decisions, constraints, names, numbers and anything the person asked for.",
  "Keep unfinished business explicit.",
  "Drop pleasantries and restated context. Write it as notes, not prose.",
].join(" ");

/**
 * Summarise up to `at` and return the list with the summary INSERTED there.
 * The originals are all still present; this only grows the transcript.
 */
async function fold(
  messages: UIMessage[],
  at: number,
  options: CompactionOptions,
  runId: string,
): Promise<{ messages: UIMessage[]; info: CompactionInfo } | undefined> {
  const since = lastSummaryIndex(messages);
  const from = Math.max(0, since);
  const toSummarise = messages.slice(from, at);
  if (toSummarise.length < 2) return;

  const transcript = toSummarise
    .map((m) => `${m.role}: ${isSummary(m) ? summaryTextOf(m) : textOf(m)}`)
    .filter((l) => l.split(": ").slice(1).join(": ").length > 0)
    .join("\n");
  if (!transcript) return;

  const { text } = await generateText({
    model: options.model,
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    messages: [{ role: "user", content: transcript }],
  });
  const summary = text.trim();
  if (!summary) return;

  const info: CompactionInfo = {
    runId,
    summarised: at - from,
    kept: messages.length - at,
    summary,
  };
  await options.onCompact?.(info);

  // One part, and not a text one. The reader gets a divider; the model gets
  // the summary through `context`, where it is never stored.
  const marker: UIMessage = {
    id: `compaction-${crypto.randomUUID()}`,
    role: "assistant",
    parts: [
      {
        type: SUMMARY_PART,
        data: {
          summary,
          summarised: info.summarised,
          kept: info.kept,
          at: new Date().toISOString(),
        } satisfies SummaryMarker,
      } as Part,
    ],
  } as UIMessage;

  // Inserted, not substituted. Everything above the marker is still here.
  return { info, messages: [...messages.slice(0, at), marker, ...messages.slice(at)] };
}

export function compaction(options: CompactionOptions): Extension {
  const afterMessages = options.afterMessages ?? 30;
  const keepLast = options.keepLast ?? 10;

  return defineExtension(
    "compaction",
    (ext) => {
      const name = options.command === false ? undefined : (options.command ?? "compact");

      // Commands run at `input`, AFTER the start moments, so this sees the real
      // stored conversation rather than whatever the client happened to post.
      if (name)
        ext.registerCommand(name, {
          description: "Summarise the conversation so far",
          handler: async (_args, ctx) => {
            const plan = compactionPlan(ctx.messages, { keepLast, force: true });
            const done = plan ? await fold(ctx.messages, plan.at, options, "command") : undefined;
            if (!done)
              return "Nothing to summarise yet — there is not enough conversation behind us.";
            return {
              reply: [
                {
                  type: "text",
                  text: `Summarised ${done.info.summarised} messages. They are all still here to read; only the model starts from the summary now.`,
                } as Part,
                { type: COMPACTED_PART, data: { summarised: done.info.summarised } } as Part,
              ],
              replace: done.messages,
            };
          },
        });

      ext.on("before_agent_start", async (messages, run) => {
        const since = lastSummaryIndex(messages);
        // Count only what has happened since the last boundary.
        if (messages.length - (since + 1) <= afterMessages) return;
        const plan = compactionPlan(messages, { keepLast, force: false });
        if (!plan) return;
        const done = await fold(messages, plan.at, options, run.runId);
        return done ? { replace: done.messages } : undefined;
      });

      /**
       * The model's view, and the whole point of the extension: the summary as
       * a synthetic opening turn, then everything after the marker.
       *
       * A LENS — what it returns is never persisted — which is what lets the
       * summary reach the model without ever appearing in the transcript a
       * person reads.
       */
      ext.on("context", async (_converted, ctx) => {
        const i = lastSummaryIndex(ctx.messages);
        if (i < 0) return;
        const marker = markerOf(ctx.messages[i]!);
        if (!marker?.summary) return;
        const after = await convertToModelMessages(ctx.messages.slice(i + 1), {
          tools: {} as ToolSet,
        });
        return {
          messages: [
            {
              role: "user" as const,
              content: `[Summary of the earlier conversation, which is not repeated below]\n${marker.summary}`,
            },
            ...after,
          ],
        };
      });
    },
    { critical: options.critical ?? false },
  ) as Extension;
}
