/**
 * Minimal Slack Web API client — just the methods a channel needs.
 *
 * Form-encoded POSTs with a bearer bot token (Slack accepts form on every
 * method used here, including the streaming ones; complex values like
 * `blocks`/`chunks`/`metadata` go as JSON-in-form fields). Typed errors, a
 * bounded retry policy, and an injectable fetch for tests:
 *
 *   429            → honor `Retry-After` (capped) and retry ONCE
 *   5xx            → retry once after a beat
 *   ok:false, 4xx  → throw {@link SlackApiError} immediately (the caller
 *                    decides what's fatal — e.g. `stopped_by_user` on a
 *                    streaming append is a signal, not a failure)
 */

export type SlackToken = string | (() => string | Promise<string>);

export class SlackApiError extends Error {
  /** The Slack method that failed (`chat.postMessage`). */
  readonly method: string;
  /** HTTP status of the response (200 for ok:false payload errors). */
  readonly status: number;
  /** Slack's error code (`channel_not_found`, `stopped_by_user`, …) if any. */
  readonly code?: string;
  /** Seconds Slack asked us to wait, when it said. */
  readonly retryAfterS?: number;
  /**
   * Slack's `response_metadata.messages`, when present — for
   * `invalid_arguments` it names the offending field as a JSON pointer,
   * which is the difference between a fix and a guessing game.
   */
  readonly detail?: string;

  constructor(
    method: string,
    status: number,
    code?: string,
    retryAfterS?: number,
    detail?: string,
  ) {
    super(`slack:${method} failed: ${code ?? status}${detail ? ` (${detail})` : ""}`);
    this.name = "SlackApiError";
    this.method = method;
    this.status = status;
    if (code !== undefined) this.code = code;
    if (retryAfterS !== undefined) this.retryAfterS = retryAfterS;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface SlackApiOptions {
  /** Test seam / custom transport. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to https://slack.com/api. */
  baseUrl?: string;
  /** Test seam for the retry waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout; a hung Slack call must not hold a worker forever. */
  timeoutMs?: number;
}

/** One streamed unit for `chat.appendStream`/`stopStream` `chunks[]`. */
export type StreamChunk =
  | { type: "markdown_text"; text: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "in_progress" | "complete" | "error";
      details?: string;
      output?: string;
    }
  | { type: "plan_update"; title: string }
  | { type: "blocks"; blocks: unknown[] };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RETRY_AFTER_S = 10;

async function resolveToken(token: SlackToken): Promise<string> {
  return typeof token === "function" ? token() : token;
}

/** A bot-scoped client bound to one token. */
export function slackApi(token: SlackToken, options: SlackApiOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://slack.com/api";
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** Methods whose nested payloads (chunks/blocks) go as real JSON. */
  const JSON_METHODS = new Set(["chat.startStream", "chat.appendStream", "chat.stopStream"]);

  async function once(method: string, params: Record<string, unknown>): Promise<Response> {
    const auth = `Bearer ${await resolveToken(token)}`;
    if (JSON_METHODS.has(method)) {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) body[k] = v;
      }
      return fetchImpl(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return fetchImpl(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let retried = false;
    for (;;) {
      const res = await once(method, params);

      if (res.status === 429 && !retried) {
        retried = true;
        const after = Number(res.headers.get("retry-after") ?? 1);
        await sleep(Math.min(Number.isFinite(after) ? after : 1, MAX_RETRY_AFTER_S) * 1000);
        continue;
      }
      if (res.status >= 500 && !retried) {
        retried = true;
        await sleep(1000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new SlackApiError(
          method,
          res.status,
          undefined,
          Number(res.headers.get("retry-after") ?? 0) || undefined,
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      if (json.ok !== true) {
        const meta = (json.response_metadata as { messages?: string[] } | undefined)?.messages;
        throw new SlackApiError(
          method,
          res.status,
          String(json.error ?? "unknown_error"),
          undefined,
          meta?.length ? meta.join("; ").slice(0, 500) : undefined,
        );
      }
      return json;
    }
  }

  return {
    /**
     * Post a message. NOTE: `markdown_text` is EXCLUSIVE with `text`/`blocks`
     * (`markdown_text_conflict`) — for markdown with a notification fallback,
     * use `markdown` blocks + `text` instead.
     */
    async postMessage(input: {
      channel: string;
      text?: string;
      blocks?: unknown[];
      /** Slack renders this as full markdown (≤12k chars) — preferred for LLM output. */
      markdown_text?: string;
      thread_ts?: string;
      username?: string;
      icon_emoji?: string;
      icon_url?: string;
      metadata?: unknown;
    }): Promise<{ ts: string; channel: string }> {
      const r = await call("chat.postMessage", { unfurl_links: false, ...input });
      return { ts: String(r.ts), channel: String(r.channel) };
    },

    /** Edit a previously posted message in place (e.g. resolve an approval card). */
    async update(input: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown[];
      markdown_text?: string;
    }): Promise<void> {
      await call("chat.update", input);
    },

    /** Delete one of the bot's own messages (dead-stream cleanup). */
    async deleteMessage(input: { channel: string; ts: string }): Promise<void> {
      await call("chat.delete", input);
    },

    /** Post a message only the given user sees (sign-in links, refusals). */
    async postEphemeral(input: {
      channel: string;
      user: string;
      text?: string;
      blocks?: unknown[];
      thread_ts?: string;
    }): Promise<void> {
      await call("chat.postEphemeral", input);
    },

    // ── Streaming (AI apps) ──────────────────────────────────────────────────

    /**
     * Open a streamed message. In a CHANNEL Slack requires `recipient_team_id`
     * (`missing_recipient_team_id` otherwise); in the bot's DM it's optional.
     */
    async startStream(input: {
      channel: string;
      thread_ts?: string;
      recipient_team_id?: string;
      recipient_user_id?: string;
      /** `"timeline"` (default) = task cards interleaved with the streamed
       *  text; `"plan"` = tasks grouped in one plan block. Anything else is
       *  `invalid_arguments` — the "task" value we first shipped was one. */
      task_display_mode?: "timeline" | "plan";
      chunks?: StreamChunk[];
      markdown_text?: string;
    }): Promise<{ ts: string; channel: string }> {
      const r = await call("chat.startStream", input);
      return { ts: String(r.ts), channel: String(r.channel) };
    },

    /**
     * Append to a live stream. Throws `SlackApiError` with code
     * `stopped_by_user` when the viewer pressed the native Stop button —
     * callers treat that as a stop signal, not a failure.
     */
    async appendStream(input: {
      channel: string;
      ts: string;
      markdown_text?: string;
      chunks?: StreamChunk[];
    }): Promise<void> {
      await call("chat.appendStream", input);
    },

    /** Close a stream, optionally with final content and (≤50) blocks. */
    async stopStream(input: {
      channel: string;
      ts: string;
      markdown_text?: string;
      chunks?: StreamChunk[];
      blocks?: unknown[];
      metadata?: unknown;
    }): Promise<void> {
      await call("chat.stopStream", input);
    },

    // ── Agent sessions ───────────────────────────────────────────────────────

    /**
     * Set a session's lifecycle status (`processing` shows the working UI and,
     * with the `agent_session_stopped` subscription, the Stop button). Creates
     * the session if it doesn't exist. Status does NOT auto-clear.
     */
    async sessionsSetStatus(input: {
      channel_id: string;
      status: "active" | "processing" | "suspended" | "closed";
      thread_ts?: string;
      title?: string;
      icon_emoji?: string;
      username?: string;
    }): Promise<void> {
      await call("agents.sessions.setStatus", input);
    },

    // ── Conversations ────────────────────────────────────────────────────────

    /** Fetch a thread's messages (oldest first) — for seeding prior context. */
    async threadReplies(
      channel: string,
      ts: string,
      limit = 50,
    ): Promise<{ userId?: string; text: string; isBot: boolean; ts: string }[]> {
      const r = await call("conversations.replies", { channel, ts, limit: String(limit) });
      const msgs = (r.messages as Record<string, unknown>[] | undefined) ?? [];
      return msgs.map((m) => ({
        userId: m.user ? String(m.user) : undefined,
        text: typeof m.text === "string" ? m.text : "",
        isBot: Boolean(m.bot_id) || m.subtype === "bot_message",
        ts: String(m.ts),
      }));
    },

    /** Channel history (newest first, as Slack returns it). */
    async conversationsHistory(input: {
      channel: string;
      limit?: number;
      oldest?: string;
      latest?: string;
    }): Promise<{ userId?: string; text: string; isBot: boolean; ts: string; threadTs?: string }[]> {
      const r = await call("conversations.history", {
        channel: input.channel,
        limit: String(input.limit ?? 50),
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.latest ? { latest: input.latest } : {}),
      });
      const msgs = (r.messages as Record<string, unknown>[] | undefined) ?? [];
      return msgs.map((m) => ({
        userId: m.user ? String(m.user) : undefined,
        text: typeof m.text === "string" ? m.text : "",
        isBot: Boolean(m.bot_id) || m.subtype === "bot_message",
        ts: String(m.ts),
        threadTs: m.thread_ts ? String(m.thread_ts) : undefined,
      }));
    },

    /**
     * ALL member ids of a conversation, paginated. `maxPages` bounds the walk;
     * hitting the bound throws (callers gating access must fail CLOSED, never
     * conclude "not a member" from a truncated list).
     */
    async conversationsMembers(channel: string, maxPages = 25): Promise<string[]> {
      const members: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const r = await call("conversations.members", {
          channel,
          limit: "1000",
          ...(cursor ? { cursor } : {}),
        });
        for (const id of (r.members as string[] | undefined) ?? []) members.push(id);
        cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
        if (!cursor) return members;
      }
      throw new SlackApiError("conversations.members", 200, "member_list_truncated");
    },

    /** Open (or fetch) a DM channel with a user; returns the IM channel id. */
    async openDm(user: string): Promise<string> {
      const r = await call("conversations.open", { users: user });
      return String((r.channel as { id?: string } | undefined)?.id ?? "");
    },

    /**
     * The channels this bot can post to, for pickers. PUBLIC channels only:
     * the manifest asks for `channels:read` but deliberately not `groups:read`
     * for listing purposes — a private channel never appears here and has to
     * be entered by id. One page — a picker doesn't need to paginate a
     * workspace, and Slack caps `limit` at 1000 anyway.
     */
    async conversationsList(limit = 200): Promise<{ id: string; name: string }[]> {
      const r = await call("conversations.list", {
        exclude_archived: "true",
        types: "public_channel",
        limit: String(limit),
      });
      const channels = (r.channels as Record<string, unknown>[] | undefined) ?? [];
      return channels.map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
    },

    /**
     * v1 compatibility — the free-text assistant status line. Superseded by
     * `sessionsSetStatus`; removed with the v1 channel.
     * @deprecated
     */
    async setStatus(input: { channel_id: string; thread_ts: string; status: string }): Promise<void> {
      await call("assistant.threads.setStatus", input).catch(() => {
        /* not an assistant thread / missing scope — status is best-effort */
      });
    },
  };
}

export type SlackClient = ReturnType<typeof slackApi>;
