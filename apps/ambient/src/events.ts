import { verifySlackSignature } from "@intentface/latch-channels/slack";
import type { Observation, StateStore } from "./state.js";

/**
 * Slack Events API → the inbox. Nothing here starts a turn: each event is
 * normalized into an {@link Observation}, queued for its channel, and the
 * channel is woken — immediately for a mention, after a quiet period for
 * everything else. Membership events keep the watch set current.
 */
export interface EventsDeps {
  signingSecret: string;
  state: StateStore;
  isWatched: (channel: string) => boolean;
  /** Wake the channel's tick: `now` for a mention, debounced otherwise. Must not throw. */
  wake: (channel: string, opts: { now: boolean }) => void;
  /** The bot joined / left a channel. */
  onJoin: (channel: string) => Promise<void>;
  onLeave: (channel: string) => Promise<void>;
  botUserId: () => Promise<string>;
  now?: () => number;
}

type SlackEvent = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  text?: string;
  files?: unknown[];
  reaction?: string;
  item?: { channel?: string; ts?: string };
  message?: { ts?: string; text?: string; user?: string; thread_ts?: string; bot_id?: string };
  previous_message?: { ts?: string; user?: string };
  deleted_ts?: string;
};

const MESSAGE_SUBTYPES_KEPT = new Set([undefined, "file_share", "thread_broadcast", "bot_message"]);

/** Turn one Slack event into an observation, or null when it is noise. */
export function toObservation(e: SlackEvent, me: string): { channel: string; obs: Observation } | null {
  const own = (user?: string, botId?: string) => (!!me && user === me) || (!!botId && !user);
  switch (e.type) {
    case "app_mention": {
      if (!e.channel || !e.ts || own(e.user, e.bot_id)) return null;
      const threadTs = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : undefined;
      return { channel: e.channel, obs: { kind: "mention", ts: e.ts, ...(threadTs ? { threadTs } : {}), ...(e.user ? { userId: e.user } : {}), text: e.text ?? "" } };
    }
    case "message": {
      if (!e.channel) return null;
      if (e.subtype === "message_changed") {
        const m = e.message;
        if (!m?.ts || own(m.user, m.bot_id)) return null;
        const threadTs = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined;
        return { channel: e.channel, obs: { kind: "edit", ts: e.event_ts ?? e.ts ?? m.ts, ...(threadTs ? { threadTs } : {}), ...(m.user ? { userId: m.user } : {}), text: m.text ?? "", targetTs: m.ts } };
      }
      if (e.subtype === "message_deleted") {
        const target = e.deleted_ts ?? e.previous_message?.ts;
        if (!target || own(e.previous_message?.user)) return null;
        const threadTs = e.thread_ts && e.thread_ts !== target ? e.thread_ts : undefined;
        return { channel: e.channel, obs: { kind: "delete", ts: e.event_ts ?? e.ts ?? target, ...(threadTs ? { threadTs } : {}), targetTs: target } };
      }
      if (!MESSAGE_SUBTYPES_KEPT.has(e.subtype) || !e.ts || own(e.user, e.bot_id)) return null;
      // A mention in a channel also arrives as `message`; the app_mention copy carries the intent.
      if (me && (e.text ?? "").includes(`<@${me}>`)) return null;
      const threadTs = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : undefined;
      const files = Array.isArray(e.files) ? e.files.length : 0;
      return {
        channel: e.channel,
        obs: { kind: threadTs ? "reply" : "message", ts: e.ts, ...(threadTs ? { threadTs } : {}), ...(e.user ? { userId: e.user } : {}), text: e.text ?? "", ...(files ? { files } : {}) },
      };
    }
    case "reaction_added":
    case "reaction_removed": {
      const channel = e.item?.channel;
      const target = e.item?.ts;
      if (!channel || !target || !e.reaction || own(e.user)) return null;
      return { channel, obs: { kind: e.type, ts: e.event_ts ?? target, ...(e.user ? { userId: e.user } : {}), emoji: e.reaction, targetTs: target } };
    }
    default:
      return null;
  }
}

export function createEventsHandler(deps: EventsDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const rawBody = await req.text();
    const ok = verifySlackSignature({
      signingSecret: deps.signingSecret,
      rawBody,
      signature: req.headers.get("x-slack-signature"),
      timestamp: req.headers.get("x-slack-request-timestamp"),
      now: deps.now?.(),
    });
    if (!ok) return new Response("bad signature", { status: 401 });

    let body: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
    if (body.type !== "event_callback" || !body.event) return new Response("ignored");

    const e = body.event;
    // Self-knowledge is best effort: an auth.test hiccup must not drop events.
    const me = await deps.botUserId().catch(() => "");

    if ((e.type === "member_joined_channel" || e.type === "member_left_channel") && e.channel) {
      if (me && e.user === me) {
        if (e.type === "member_joined_channel") await deps.onJoin(e.channel);
        else await deps.onLeave(e.channel);
        return new Response("ok");
      }
      return new Response("ignored");
    }

    const hit = toObservation(e, me);
    if (!hit || !deps.isWatched(hit.channel)) return new Response("ignored");
    await deps.state.push(hit.channel, body.event_id ?? `${hit.obs.kind}:${hit.obs.ts}`, hit.obs);
    deps.wake(hit.channel, { now: hit.obs.kind === "mention" });
    return new Response("ok");
  };
}
