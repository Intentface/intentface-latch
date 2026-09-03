import { tool, type Tool } from "ai";
import { z } from "zod";
import { DAY_MS } from "@intentface/latch-core";
import type { Principal } from "./principal.js";
import type { Slack } from "./slack.js";
import { MAX_DOC_CHARS, type StateStore } from "./state.js";

/**
 * The agent's four verbs. Every tool reads the channel from `options.context`
 * — the principal the runtime stamped on the turn — never from the model's
 * input, so the agent can only ever read or write ITS channel.
 */
export interface ToolContext {
  principal: Principal;
  run: { id: string; chatId: string; agent: string };
}

export interface ToolDeps {
  slack: Slack;
  state: StateStore;
  /** Unprompted posts allowed per channel per rolling day. */
  maxPostsPerDay: number;
  now?: () => number;
}

const ctxOf = (options: unknown): ToolContext => {
  const ctx = (options as { context?: ToolContext } | undefined)?.context;
  if (!ctx?.principal?.channel) throw new Error("ambient tools need the turn's principal in options.context");
  return ctx;
};

export function createTools(deps: ToolDeps): Record<string, Tool> {
  const now = deps.now ?? Date.now;

  const read_new_messages = tool({
    description:
      "Read the top-level channel messages posted since your last read (oldest first). " +
      "Advances your read cursor. Call this first on every tick. Thread replies are not included — " +
      "a root with `threadTs` set has a thread; use read_thread to see it.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max messages to return (default 200)."),
    }),
    execute: async ({ limit }, options) => {
      const { channel } = ctxOf(options).principal;
      const before = await deps.state.load(channel);
      const messages = await deps.slack.readSince(channel, before.cursor, limit ?? 200);
      const last = messages.at(-1);
      if (last) await deps.state.advanceCursor(channel, last.ts);
      return {
        count: messages.length,
        since: before.cursor ? new Date(Number(before.cursor) * 1000).toISOString() : "the beginning",
        messages,
      };
    },
  });

  const read_thread = tool({
    description: "Read all replies in one thread of this channel (oldest first), root included.",
    inputSchema: z.object({ threadTs: z.string().describe("The thread root's ts.") }),
    execute: async ({ threadTs }, options) => {
      const { channel } = ctxOf(options).principal;
      return { messages: await deps.slack.readThread(channel, threadTs) };
    },
  });

  const update_state = tool({
    description:
      "Replace your state document for this channel with a new full version. " +
      `Keep the section schema from your instructions. Max ${MAX_DOC_CHARS} characters — prune resolved items rather than growing forever.`,
    inputSchema: z.object({ doc: z.string().describe("The complete new state document (markdown).") }),
    execute: async ({ doc }, options) => {
      const { channel } = ctxOf(options).principal;
      if (doc.length > MAX_DOC_CHARS) {
        return {
          ok: false as const,
          error: `State document is ${doc.length} chars; the cap is ${MAX_DOC_CHARS}. Prune closed items and try again.`,
        };
      }
      await deps.state.saveDoc(channel, doc);
      return { ok: true as const, chars: doc.length };
    },
  });

  const post_to_channel = tool({
    description:
      "Post a message to THIS channel (or into one of its threads). This is your only voice. " +
      "Unprompted posts are budgeted per day; a reply to someone who addressed you is not.",
    inputSchema: z.object({
      text: z.string().min(1).max(4000).describe("Slack markdown."),
      threadTs: z.string().optional().describe("Reply inside this thread instead of top-level."),
      reason: z
        .enum(["addressed", "overdue", "correction", "answer", "other"])
        .describe("Why you are speaking. `addressed` = someone asked you directly; everything else is unprompted."),
    }),
    execute: async ({ text, threadTs, reason }, options) => {
      const { channel } = ctxOf(options).principal;
      const kind = reason === "addressed" ? "addressed" : "unprompted";
      if (kind === "unprompted") {
        const used = await deps.state.unpromptedPostsSince(channel, now() - DAY_MS);
        if (used >= deps.maxPostsPerDay) {
          return {
            ok: false as const,
            error: `Unprompted post budget spent (${used}/${deps.maxPostsPerDay} in the last 24h). Note it in your state and wait.`,
          };
        }
      }
      const { ts } = await deps.slack.post(channel, text, threadTs);
      await deps.state.recordPost(channel, ts, kind);
      return { ok: true as const, ts, kind };
    },
  });

  return { read_new_messages, read_thread, update_state, post_to_channel };
}
