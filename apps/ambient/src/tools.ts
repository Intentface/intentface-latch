import { tool, type Tool } from "ai";
import { z } from "zod";
import { DAY_MS } from "@intentface/latch-core";
import type { Principal } from "./principal.js";
import type { Slack } from "./slack.js";
import { MAX_DOC_CHARS, type Observation, type StateStore } from "./state.js";
import { addressesMe, engagementOf, followsMe } from "./engagement.js";

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
  /** How much history to read when a channel is seen for the first time. */
  bootstrapMessages?: number;
  now?: () => number;
}

const ctxOf = (options: unknown): ToolContext => {
  const ctx = (options as { context?: ToolContext } | undefined)?.context;
  if (!ctx?.principal?.channel) throw new Error("ambient tools need the turn's principal in options.context");
  return ctx;
};

const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/** Long pastes and bot dumps are clipped: the agent needs the gist, and every character rides along in every later step. */
const MAX_TEXT = 1200;
const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}… [${t.length - MAX_TEXT} more chars]` : t);

/**
 * Reactions are noisy one at a time and meaningful in aggregate. An add and a
 * remove of the same emoji by the same person on the same message cancel out;
 * the survivors group per (message, emoji) with who did it. Everything else
 * passes through unchanged, in order.
 */
type FoldedReactions = { kind: "reactions"; ts: string; targetTs: string; emoji: string; userIds: string[]; removed?: boolean };

export function foldReactions(obs: Observation[]): (Observation | FoldedReactions)[] {
  type Group = { ts: string; targetTs: string; emoji: string; net: Map<string, number> };
  const groups = new Map<string, Group>();
  // Keep order: a group sits where its first reaction was.
  const order: (Observation | { group: Group })[] = [];
  for (const o of obs) {
    if (o.kind !== "reaction_added" && o.kind !== "reaction_removed") {
      order.push(o);
      continue;
    }
    const key = `${o.targetTs}:${o.emoji}`;
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = { ts: o.ts, targetTs: o.targetTs, emoji: o.emoji, net: new Map() }));
      order.push({ group: g });
    }
    const who = o.userId ?? "?";
    g.net.set(who, (g.net.get(who) ?? 0) + (o.kind === "reaction_added" ? 1 : -1));
  }
  return order.flatMap((item): (Observation | FoldedReactions)[] => {
    if (!("group" in item)) return [item];
    const g = item.group;
    const added = [...g.net].filter(([, n]) => n > 0).map(([u]) => u);
    const removed = [...g.net].filter(([, n]) => n < 0).map(([u]) => u);
    const rows: FoldedReactions[] = [];
    if (added.length) rows.push({ kind: "reactions", ts: g.ts, targetTs: g.targetTs, emoji: g.emoji, userIds: added });
    if (removed.length) rows.push({ kind: "reactions", ts: g.ts, targetTs: g.targetTs, emoji: g.emoji, userIds: removed, removed: true });
    return rows;
  });
}

export function createTools(deps: ToolDeps): Record<string, Tool> {
  const now = deps.now ?? Date.now;

  /** Observations with names instead of ids, reactions folded, follow-ups to the agent marked, and a readable time. */
  async function present(channel: string, obs: Observation[]) {
    const engagement = engagementOf(await deps.state.recentPosts(channel, now() - 7 * DAY_MS), await deps.slack.botName().catch(() => ""));
    const out = [];
    for (const o of foldReactions(obs)) {
      if (o.kind === "reactions") {
        const who = [];
        for (const id of o.userIds) who.push(await deps.slack.userName(id));
        const { userIds, ...rest } = o;
        void userIds;
        out.push({ ...rest, at: isoOf(o.ts), who });
        continue;
      }
      const { userId, ...rest } = o as Observation & { userId?: string; text?: string };
      const flags = { ...(followsMe(o, engagement) ? { followsMe: true } : {}), ...(addressesMe(o, engagement) ? { addressesMe: true } : {}) };
      out.push({ ...rest, ...("text" in rest && typeof rest.text === "string" ? { text: clip(rest.text) } : {}), ...flags, at: isoOf(o.ts), ...(userId !== undefined ? { who: await deps.slack.userName(userId) } : {}) });
    }
    return out;
  }

  const read_inbox = tool({
    description:
      "Drain everything that happened in the channel since your last tick, oldest first: new messages, thread replies " +
      "(`threadTs`), edits and deletions of earlier messages (`targetTs`), reactions grouped per message and emoji " +
      "(`kind: reactions` — `who` reacted, `removed: true` when taken back), and mentions of you (`kind: mention`). Call this first on every tick. The first time you see a channel " +
      "you also get its recent history as context.",
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const { channel } = ctxOf(options).principal;
      const state = await deps.state.load(channel);
      const events = await present(channel, await deps.state.drain(channel));
      let history: Awaited<ReturnType<Slack["recentHistory"]>> | undefined;
      if (state.bootstrappedAt === null) {
        history = (await deps.slack.recentHistory(channel, deps.bootstrapMessages ?? 30)).map((m) => ({ ...m, text: clip(m.text) }));
        await deps.state.markBootstrapped(channel);
      }
      return { count: events.length, events, ...(history ? { history, note: "First look at this channel: recent history for context." } : {}) };
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
        return { ok: false as const, error: `State document is ${doc.length} chars; the cap is ${MAX_DOC_CHARS}. Prune closed items and try again.` };
      }
      await deps.state.saveDoc(channel, doc);
      return { ok: true as const, chars: doc.length };
    },
  });

  const post_to_channel = tool({
    description:
      "Post a message to THIS channel (or into one of its threads). This is your only voice. " +
      "Unprompted posts are budgeted per day; replies (addressed, invited, help) are not.",
    inputSchema: z.object({
      text: z.string().min(1).max(4000).describe("Slack markdown."),
      threadTs: z.string().optional().describe("Reply inside this thread instead of top-level."),
      reason: z
        .enum(["addressed", "invited", "help", "overdue", "correction", "answer", "other"])
        .describe(
          "Why you are speaking. `addressed` = someone asked you directly; `invited` = someone asked the group for input; `help` = someone is stuck on something you can settle. Those three are replies and not budgeted; everything else is unprompted.",
        ),
    }),
    execute: async ({ text, threadTs, reason }, options) => {
      const { channel } = ctxOf(options).principal;
      const kind = reason === "addressed" || reason === "invited" || reason === "help" ? "addressed" : "unprompted";
      if (kind === "unprompted") {
        const used = await deps.state.unpromptedPostsSince(channel, now() - DAY_MS);
        if (used >= deps.maxPostsPerDay) {
          return { ok: false as const, error: `Unprompted post budget spent (${used}/${deps.maxPostsPerDay} in the last 24h). Note it in your state and wait.` };
        }
      }
      const { ts } = await deps.slack.post(channel, text, threadTs);
      await deps.state.recordPost(channel, ts, kind, threadTs);
      return { ok: true as const, ts, kind };
    },
  });

  const react = tool({
    description:
      "Add an emoji reaction to a message in THIS channel. The right response to a message that expects no reply — " +
      "\"thanks\", \"ok\", \"interesting\", a kind word after you helped: a fitting reaction says you saw it, without " +
      "spending anyone's attention. Not budgeted. Use a plain emoji name like `thumbsup`, `pray`, `eyes`, `bulb`, `coffee`.",
    inputSchema: z.object({
      ts: z.string().describe("The message's ts."),
      emoji: z.string().min(1).max(64).describe("Emoji name without colons."),
    }),
    execute: async ({ ts, emoji }, options) => {
      const { channel } = ctxOf(options).principal;
      await deps.slack.react(channel, ts, emoji);
      return { ok: true as const };
    },
  });

  return { read_inbox, read_thread, update_state, post_to_channel, react };
}
