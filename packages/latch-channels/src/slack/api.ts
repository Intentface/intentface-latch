/**
 * Minimal Slack Web API client — just the methods a channel needs. Form-encoded
 * POSTs with a bearer bot token (Slack accepts both; form is simplest and is
 * what most methods want). `blocks`/`metadata` go as JSON-in-form fields.
 */

export type SlackToken = string | (() => string | Promise<string>);

export interface SlackApiError {
  ok: false;
  error: string;
}

async function resolveToken(token: SlackToken): Promise<string> {
  return typeof token === "function" ? token() : token;
}

async function call(
  token: SlackToken,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await resolveToken(token)}`,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: form,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`slack:${method} failed: ${String(json.error ?? res.status)}`);
  }
  return json;
}

/** A bot-scoped client bound to one token. */
export function slackApi(token: SlackToken) {
  return {
    /** Post a message (mrkdwn `text` and/or Block Kit `blocks`) to a channel/thread. */
    async postMessage(input: {
      channel: string;
      text?: string;
      blocks?: unknown[];
      thread_ts?: string;
      username?: string;
      icon_emoji?: string;
      icon_url?: string;
    }): Promise<{ ts: string; channel: string }> {
      const r = await call(token, "chat.postMessage", { unfurl_links: false, ...input });
      return { ts: String(r.ts), channel: String(r.channel) };
    },

    /** Edit a previously posted message in place (e.g. resolve an approval card). */
    async update(input: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown[];
    }): Promise<void> {
      await call(token, "chat.update", input);
    },

    /** Post a message only the given user sees (used for OAuth sign-in links). */
    async postEphemeral(input: {
      channel: string;
      user: string;
      text?: string;
      blocks?: unknown[];
      thread_ts?: string;
    }): Promise<void> {
      await call(token, "chat.postEphemeral", input);
    },

    /** Fetch a thread's messages (oldest first) — for seeding prior context. */
    async threadReplies(
      channel: string,
      ts: string,
      limit = 50,
    ): Promise<{ userId?: string; text: string; isBot: boolean; ts: string }[]> {
      const r = await call(token, "conversations.replies", { channel, ts, limit: String(limit) });
      const msgs = (r.messages as Record<string, unknown>[] | undefined) ?? [];
      return msgs.map((m) => ({
        userId: m.user ? String(m.user) : undefined,
        text: typeof m.text === "string" ? m.text : "",
        isBot: Boolean(m.bot_id) || m.subtype === "bot_message",
        ts: String(m.ts),
      }));
    },

    /** Open (or fetch) a DM channel with a user; returns the IM channel id. */
    async openDm(user: string): Promise<string> {
      const r = await call(token, "conversations.open", { users: user });
      return String((r.channel as { id?: string } | undefined)?.id ?? "");
    },

    /** Set the assistant "thinking…/working…" status line on a thread. */
    async setStatus(input: { channel_id: string; thread_ts: string; status: string }): Promise<void> {
      await call(token, "assistant.threads.setStatus", input).catch(() => {
        /* not an assistant thread / missing scope — status is best-effort */
      });
    },
  };
}

export type SlackClient = ReturnType<typeof slackApi>;
