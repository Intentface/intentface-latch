import { slackApi } from "@intentface/latch-channels/slack";

/**
 * The little Slack the app needs, over the package's bot client. Names are
 * resolved so the agent reads "Anna: …" rather than "U0123: …" — user and
 * channel lookups are cached for the process lifetime.
 */
export interface ChannelMessage {
  ts: string;
  /** Set on thread replies and on thread roots that have replies. */
  threadTs?: string;
  author: string;
  isBot: boolean;
  /** The message @-mentions the bot. */
  mentionsMe: boolean;
  text: string;
  /** ISO time, for the agent's sense of "how long ago". */
  at: string;
}

export interface Slack {
  /** The bot's own user id (auth.test, cached). */
  botUserId(): Promise<string>;
  userName(id: string | undefined): Promise<string>;
  channelName(channel: string): Promise<string>;
  /** Top-level messages newer than `cursor` (all of them when null), oldest first. */
  readSince(channel: string, cursor: string | null, limit?: number): Promise<ChannelMessage[]>;
  readThread(channel: string, threadTs: string): Promise<ChannelMessage[]>;
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
}

const isoOf = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

export function createSlack(token: string, fetchImpl: typeof fetch = fetch): Slack {
  const api = slackApi(token, { fetchImpl });
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  let self: Promise<string> | undefined;

  async function get(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams(params).toString();
    const res = await fetchImpl(`https://slack.com/api/${method}?${q}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as Record<string, unknown> & { ok?: boolean; error?: string };
    if (!json.ok) throw new Error(`slack:${method} failed: ${json.error ?? res.status}`);
    return json;
  }

  async function userName(id: string | undefined): Promise<string> {
    if (!id) return "someone";
    const hit = users.get(id);
    if (hit) return hit;
    let name = id;
    try {
      const r = await get("users.info", { user: id });
      const u = r.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
      name = u?.profile?.display_name || u?.real_name || u?.name || id;
    } catch {
      // Unknown or unreadable user (deleted, external): keep the id.
    }
    users.set(id, name);
    return name;
  }

  const botUserId = (): Promise<string> => {
    self ??= get("auth.test", {}).then((r) => String(r.user_id ?? ""));
    return self;
  };

  const toMessage = async (m: { userId?: string; text: string; isBot: boolean; ts: string; threadTs?: string }): Promise<ChannelMessage> => {
    const me = await botUserId();
    return {
      ts: m.ts,
      ...(m.threadTs ? { threadTs: m.threadTs } : {}),
      author: await userName(m.userId),
      isBot: m.isBot,
      mentionsMe: !!me && m.text.includes(`<@${me}>`),
      text: m.text,
      at: isoOf(m.ts),
    };
  };

  return {
    botUserId,
    userName,
    async channelName(channel) {
      const hit = channels.get(channel);
      if (hit) return hit;
      let name = channel;
      try {
        const r = await get("conversations.info", { channel });
        name = (r.channel as { name?: string } | undefined)?.name ?? channel;
      } catch {
        // Fall back to the id.
      }
      channels.set(channel, name);
      return name;
    },

    async readSince(channel, cursor, limit = 200) {
      const raw = await api.conversationsHistory({ channel, limit, ...(cursor ? { oldest: cursor } : {}) });
      // Slack returns newest first and `oldest` is exclusive; sort oldest-first
      // and drop the cursor row defensively.
      const rows = raw
        .filter((m) => !cursor || Number(m.ts) > Number(cursor))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const out: ChannelMessage[] = [];
      for (const m of rows) out.push(await toMessage(m));
      return out;
    },

    async readThread(channel, threadTs) {
      const raw = await api.threadReplies(channel, threadTs, 100);
      const out: ChannelMessage[] = [];
      for (const m of raw) out.push(await toMessage({ ...m, threadTs }));
      return out;
    },

    async post(channel, text, threadTs) {
      const r = await api.postMessage({ channel, markdown_text: text, ...(threadTs ? { thread_ts: threadTs } : {}) });
      return { ts: r.ts };
    },
  };
}
