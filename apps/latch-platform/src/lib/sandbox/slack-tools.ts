import { tool, jsonSchema } from "ai";
import {
  parseSlackChatId,
  slackApi,
  SlackApiError,
  markdownBlocks,
  notificationText,
} from "@intentface/latch-channels/slack";
import type { SlackClient } from "@intentface/latch-channels/slack";
import { getLatch } from "@/lib/latch";
import { slackVaultKeys } from "@/lib/slack-store";
import type { SlackApp } from "@/lib/slack-store";
import type { Principal } from "@/lib/session";

/**
 * Slack tools for agents running INSIDE a Slack conversation: read the thread
 * or channel the humans are pointing at, and post to another channel behind a
 * HITL approval.
 *
 * The entire authority model lives server-side in these `execute`s — nothing
 * in the tool schema lets the model choose who it acts as:
 *
 *  - The app, bot token and REQUESTER are derived from the run's chat id and
 *    its thread-ownership row. A prompt-injected agent cannot name a
 *    different requester, app or token; the inputs simply don't exist.
 *  - Reads are gated on the REQUESTER'S visibility: the bot must be in the
 *    channel AND the thread's initiator must be a member of it, checked live
 *    against `conversations.members`. A bot sitting in #leadership never
 *    becomes a read proxy for someone outside it. The membership walk fails
 *    CLOSED if it can't be completed.
 *  - `post_to_channel` is approval-gated (harnessApproval) — a human sees the
 *    exact channel + full text before anything leaves the conversation.
 *  - Outside a Slack chat (web runs, subagent runs — whose gates are waived by
 *    design) every tool refuses: the chat id doesn't parse, so there is no
 *    authority to act with.
 */

type ToolCtx = {
  principal: Principal;
  run?: { id: string; chatId: string; agent: string };
};
const ctxOf = (o: unknown): Partial<ToolCtx> => (o as { context?: ToolCtx }).context ?? {};

interface SlackToolCtx {
  api: SlackClient;
  app: SlackApp;
  /** The thread initiator's Slack user id — whose visibility gates reads. */
  requesterSlackId: string;
  /** The channel the current conversation lives in. */
  homeChannel: string;
}

/** Resolve the acting context from the run — never from model input. */
async function slackCtx(options: unknown): Promise<{ ctx?: SlackToolCtx; error?: string }> {
  const { principal, run } = ctxOf(options);
  if (!principal || !run) return { error: "No principal for this turn." };
  const ref = parseSlackChatId(run.chatId);
  if (!ref) {
    return { error: "This tool only works inside a Slack conversation." };
  }
  const { slackStore, credentials } = await getLatch();
  const app = await slackStore.resolve(ref.app);
  if (!app || app.orgId !== principal.orgId) {
    return { error: "The Slack app behind this conversation is no longer bound." };
  }
  if (app.status === "disabled") {
    return { error: "The Slack app behind this conversation is disabled." };
  }
  const thread = await slackStore.getThread(run.chatId);
  if (!thread) return { error: "This conversation has no Slack ownership record." };
  const token = await credentials.get(
    { orgId: app.orgId, userId: app.userId },
    slackVaultKeys(app.appId).botToken,
    "org",
  );
  if (!token) return { error: "The Slack app behind this conversation has no bot token." };
  return {
    ctx: {
      api: slackApi(token),
      app,
      requesterSlackId: thread.initiatorSlackUserId,
      homeChannel: ref.channel,
    },
  };
}

/**
 * The requester-visibility gate: bot in channel AND requester in channel.
 * Returns an error string to hand the model, or null when reading is allowed.
 */
async function requesterCanRead(
  ctx: SlackToolCtx,
  channel: string,
): Promise<string | null> {
  // The conversation's own channel needs no membership walk: the requester is
  // literally talking in it.
  if (channel === ctx.homeChannel) return null;
  let members: string[];
  try {
    members = await ctx.api.conversationsMembers(channel);
  } catch (e) {
    if (e instanceof SlackApiError) {
      if (e.code === "not_in_channel" || e.code === "channel_not_found") {
        // channel_not_found is also what a private channel the bot can't see
        // returns — same instruction either way, and no existence oracle.
        return `I'm not in <#${channel}> — ask a member to /invite the bot, then try again.`;
      }
      if (e.code === "member_list_truncated") {
        return "That channel is too large to verify membership — reading it is not allowed.";
      }
    }
    console.error("[slack-tools] membership check failed:", e);
    return "Couldn't verify channel membership — reading it is not allowed.";
  }
  if (!members.includes(ctx.requesterSlackId)) {
    return "The person driving this conversation isn't a member of that channel, so I can't read it for them.";
  }
  return null;
}

/** Slack messages, shaped for the model (stable @handles, no raw payloads). */
const shapeMessages = (
  msgs: { userId?: string; text: string; isBot: boolean; ts: string; threadTs?: string }[],
) =>
  msgs.map((m) => ({
    from: m.isBot ? "bot" : m.userId ? `@${m.userId}` : "user",
    ts: m.ts,
    ...(m.threadTs && m.threadTs !== m.ts ? { in_thread: m.threadTs } : {}),
    text: m.text,
  }));

const readErr = (e: unknown): { error: string } => {
  if (e instanceof SlackApiError && (e.code === "not_in_channel" || e.code === "channel_not_found")) {
    return { error: "I'm not in that channel — ask a member to /invite the bot, then try again." };
  }
  console.error("[slack-tools] read failed:", e);
  return { error: "Slack read failed." };
};

const slack_read_thread = tool({
  description:
    "Read a Slack thread the user pointed you at (e.g. from a link or 'that thread above'). " +
    "Only works for channels both the bot AND the requesting user are members of.",
  inputSchema: jsonSchema<{ channel: string; thread_ts: string; limit?: number }>({
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id (C…/G…) the thread lives in" },
      thread_ts: { type: "string", description: "The thread root timestamp (e.g. 1712345678.000100)" },
      limit: { type: "number", description: "Max messages (default 50, max 200)" },
    },
    required: ["channel", "thread_ts"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { ctx, error } = await slackCtx(options);
    if (!ctx) return { error };
    const refusal = await requesterCanRead(ctx, args.channel);
    if (refusal) return { error: refusal };
    try {
      const msgs = await ctx.api.threadReplies(
        args.channel,
        args.thread_ts,
        Math.min(Math.max(args.limit ?? 50, 1), 200),
      );
      return { messages: shapeMessages(msgs) };
    } catch (e) {
      return readErr(e);
    }
  },
});

const slack_read_channel = tool({
  description:
    "Read the recent top-level messages of a Slack channel — for 'catch up on #general' or when " +
    "the discussion the user references happened above in the channel. Only works for channels " +
    "both the bot AND the requesting user are members of.",
  inputSchema: jsonSchema<{ channel: string; limit?: number; oldest?: string }>({
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id (C…/G…)" },
      limit: { type: "number", description: "Max messages (default 30, max 200)" },
      oldest: { type: "string", description: "Only messages after this ts" },
    },
    required: ["channel"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { ctx, error } = await slackCtx(options);
    if (!ctx) return { error };
    const refusal = await requesterCanRead(ctx, args.channel);
    if (refusal) return { error: refusal };
    try {
      const msgs = await ctx.api.conversationsHistory({
        channel: args.channel,
        limit: Math.min(Math.max(args.limit ?? 30, 1), 200),
        ...(args.oldest ? { oldest: args.oldest } : {}),
      });
      return { messages: shapeMessages(msgs) };
    } catch (e) {
      return readErr(e);
    }
  },
});

const slack_list_channels = tool({
  description:
    "List the workspace's public channels (names + ids) — to resolve '#general' to an id before " +
    "reading or posting. Listing is names only; reading still requires membership.",
  inputSchema: jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  execute: async (_args, options) => {
    const { ctx, error } = await slackCtx(options);
    if (!ctx) return { error };
    try {
      return { channels: await ctx.api.conversationsList() };
    } catch (e) {
      console.error("[slack-tools] list failed:", e);
      return { error: "Couldn't list channels." };
    }
  },
});

const post_to_channel = tool({
  description:
    "Post a message to a Slack channel OTHER than this conversation ('post this summary to " +
    "#general'). Always shows the user an approval card with the exact channel and full text " +
    "first. Pass the complete message — it is sent verbatim.",
  inputSchema: jsonSchema<{ channel: string; text: string }>({
    type: "object",
    properties: {
      channel: { type: "string", description: "Target channel id (use slack_list_channels to resolve a #name)" },
      text: { type: "string", description: "The COMPLETE message to post, verbatim (markdown supported)" },
    },
    required: ["channel", "text"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { ctx, error } = await slackCtx(options);
    if (!ctx) return { error };
    if (!args.text.trim()) return { error: "Nothing to post." };
    // The user approved args.text EXACTLY — never publish a silently different
    // (truncated) message. Over the markdown limit → make the model shorten it.
    if (args.text.length > 12_000) {
      return {
        error: `Message is ${args.text.length} characters — Slack's limit is 12000. Shorten it and try again.`,
      };
    }
    try {
      // markdown blocks + notification text: chat.postMessage REJECTS
      // markdown_text combined with text (markdown_text_conflict) — this is
      // the same pattern the streaming fallback engine uses.
      const r = await ctx.api.postMessage({
        channel: args.channel,
        blocks: markdownBlocks(args.text),
        text: notificationText(args.text),
      });
      return { posted: true, channel: r.channel, ts: r.ts };
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === "not_in_channel" || e.code === "channel_not_found")) {
        return { error: "The bot isn't in that channel — ask a member to /invite it, then try again." };
      }
      console.error("[slack-tools] post failed:", e);
      // Relay Slack's code/detail — a bare "failed" hides the cause from the
      // user AND from whoever debugs the transcript later.
      const why =
        e instanceof SlackApiError ? `${e.code ?? e.status}${e.detail ? `: ${e.detail}` : ""}` : "unexpected error";
      return { error: `Posting failed (${why}).` };
    }
  },
});

export const slackTools = {
  slack_read_thread,
  slack_read_channel,
  slack_list_channels,
  post_to_channel,
} as Record<string, unknown>;

/**
 * post_to_channel writes OUTSIDE the conversation the user can see — always
 * approval-gated. (A per-binding unattended allowlist for scheduled digests
 * arrives with the binding settings UI.)
 */
export const slackToolsApproval: Record<string, unknown> = {
  post_to_channel: "user-approval",
};
