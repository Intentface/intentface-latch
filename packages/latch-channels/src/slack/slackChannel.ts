import type { AppMessage } from "@intentface/latch-core";
import type { ChannelRunOps } from "../types.js";
import { consumeRun, pendingApprovals } from "../render.js";
import { slackApi, type SlackApiOptions, type SlackClient, type SlackToken } from "./api.js";
import { verifySlackSignature } from "./verify.js";
import { DM_ROOT, parseSlackChatId, slackChatId } from "./ids.js";
import { isRenderableUserMessage, normalizeSlackText } from "./normalize.js";
import { decodeAction, encodeAction } from "./payloads.js";
import {
  APPROVE_ACTION,
  DENY_ACTION,
  FEEDBACK_ACTION,
  approvalBlocksV2,
  approvalResolvedBlocks,
  connectBlocks,
  signInCard,
} from "./blocks.js";
import { renderSlackStream } from "./stream.js";

/**
 * The Slack channel, v2. One agent's dedicated Slack app; the host wires
 * `handleRequest` to a single webhook route.
 *
 * Design invariants (each one is a production incident that can't recur):
 *
 *  - **ACK first.** Pre-ACK work is signature verification and a minimal
 *    parse — nothing else. Every DB/Vault/history read happens in deferred
 *    workers. (The v1 pre-ACK chain caused the 3s timeouts whose retries the
 *    dedupe layers then had to absorb.)
 *  - **Admission is atomic.** One `claimOnce` primitive (TTL'd test-and-set)
 *    dedupes deliveries, messages and interactions; one `claimTurn` lease
 *    guarantees a single live run per chat. No read-then-act preflights.
 *  - **Threads are initiator-owned.** The first user to engage a chat owns
 *    it; everyone else gets ONE quiet notice. Nobody ever acts with another
 *    user's credentials — approvals are actor-bound in a signed payload.
 *  - **DMs are continuous.** Un-threaded DM messages share one chat per DM
 *    channel; session-pane threads and channel threads get one chat per
 *    thread, always scoped to this app.
 */

// ── Host contract ────────────────────────────────────────────────────────────

/** Everything Latch remembers about one Slack-anchored chat. */
export interface SlackChatMeta {
  /** The Slack user whose message created this chat — the only driver. */
  initiatorUserId: string;
  teamId: string;
  createdAt: number;
}

/**
 * Host-backed thread registry: ownership + the cross-instance stop flag.
 * `claim` is atomic first-writer-wins and returns the OWNING meta either way.
 */
export interface SlackThreadStore {
  claim(chatId: string, meta: SlackChatMeta): Promise<SlackChatMeta>;
  get(chatId: string): Promise<SlackChatMeta | null>;
  /** The viewer pressed Stop (possibly on another instance). */
  markStopped(chatId: string): Promise<void>;
  /** Was a stop raised after `sinceMs`? Polled by the streaming renderer. */
  stoppedSince(chatId: string, sinceMs: number): Promise<boolean>;
}

/** The per-tenant state a turn runs against. */
export interface SlackTenant<P> {
  principal: P;
  /** The workspace's bot token (vault-backed in practice). */
  botToken: SlackToken;
  runtime: ChannelRunOps<P>;
  /**
   * The bot's own Slack user id — REQUIRED. The authoritative self-check;
   * v2 has no `bot_id`/`subtype` identity fallback, a binding without it
   * must be reinstalled.
   */
  botUserId: string;
  /** The installed workspace — `chat.startStream` needs it in channels. */
  teamId: string;
}

/** Routing fields lifted from the already-verified payload, for `resolve`. */
export interface SlackPeek {
  kind: "event" | "interaction";
  type?: string;
  eventType?: string;
  teamId?: string;
  userId?: string;
  payload: unknown;
}

export interface SlackChannelConfig<P> {
  /** The agent this app serves (own-app-per-agent). */
  agent: string;
  /** The Slack app id — the chat-id namespace. Required: no unscoped chats. */
  appId: string;

  /** Static tenant (single-tenant construction) … */
  principal?: P;
  botToken?: SlackToken;
  runtime?: ChannelRunOps<P>;
  botUserId?: string;
  teamId?: string;
  /** … or resolve the tenant per payload (multi-tenant seam). */
  resolve?: (peek: SlackPeek) => SlackTenant<P> | null | Promise<SlackTenant<P> | null>;

  signingSecret: string | (() => string | Promise<string>);
  /**
   * Keep a serverless function alive for the deferred worker after the ACK.
   * Without it the worker is awaited inline (fine off-serverless, but the ACK
   * then waits on the whole turn).
   */
  waitUntil?: (p: Promise<unknown>) => void;

  /**
   * Atomic TTL'd test-and-set: TRUE when THIS call claimed the key, false
   * when someone already holds it. One primitive covers delivery retries
   * (`evt:`), the same message arriving as two event shapes (`msg:`),
   * interaction redeliveries (`act:`) and once-ever notices (`note:`).
   */
  claimOnce: (key: string, ttlMs: number) => Promise<boolean>;
  /** One live run per chat: lease with a fencing token, `null` = busy. */
  claimTurn: (chatId: string) => Promise<string | null>;
  releaseTurn: (chatId: string, token: string) => Promise<void>;
  /** Thread ownership + stop flag. */
  threads: SlackThreadStore;

  /**
   * Gate inbound users (identity link, org membership, credential mode).
   * `principal` (when returned with `allowed: true`) runs THIS turn as that
   * principal — how per-user credentials work. `silent` suppresses the
   * refusal notice (disabled bindings shouldn't reply at all).
   */
  authorizeUser?: (user: {
    teamId: string;
    userId: string;
    channelId: string;
    threadRoot: string;
    prompt: string;
  }) => Promise<{
    allowed: boolean;
    silent?: boolean;
    linkUrl?: string;
    message?: string;
    principal?: P;
  }>;

  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: {
      chatId: string;
      channelId: string;
      threadTs: string;
      userId: string;
      approvalId: string;
    },
  ) => string;

  /** `tokens_revoked` / `app_uninstalled` → the host disables the binding. */
  onLifecycle?: (info: {
    type: "tokens_revoked" | "app_uninstalled";
    teamId: string;
  }) => Promise<void>;

  /**
   * Streaming-engine telemetry: called once per rendered turn with the mode
   * (`stream`, or `fallback` + Slack's refusal code). Hosts persist it so the
   * binding health row can say WHY a bot is in edited-message mode.
   */
  onStreamMode?: (info: {
    chatId: string;
    mode: "stream" | "fallback";
    code?: string;
    detail?: string;
  }) => Promise<void>;

  /** Native 👍/👎 on final answers. */
  feedback?: boolean;
  onFeedback?: (f: {
    userId: string;
    channelId: string;
    messageTs?: string;
    sentiment: "positive" | "negative";
  }) => Promise<void>;

  /** Up to 4 prompts pinned in the app's Messages tab. */
  suggestedPrompts?:
    | { title: string; message: string }[]
    | ((ctx: {
        userId: string;
        teamId: string;
      }) => Promise<{ title: string; message: string }[]>);

  /** Per-agent display identity (fallback engine posts only). */
  botName?: string;
  iconEmoji?: string;
  /** Test seam for the Slack Web API client. */
  apiOptions?: SlackApiOptions;
}

// ── Internals ────────────────────────────────────────────────────────────────

type SlackEvent = {
  type?: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  tab?: string;
  streaming_message_ts?: string[];
};

type Mode = "mention" | "dm" | "thread-follow";

const ok = () => new Response(null, { status: 200 });

// Claim TTLs. Dedupe keys are never released — they expire.
const EVT_TTL = 6 * 3600_000; // Slack retries within the hour; 6h is margin
const MSG_TTL = 6 * 3600_000;
const ACT_TTL = 15 * 60_000;
const NOTE_TTL = 7 * 24 * 3600_000;

const GENERIC_ERROR = ":warning: Something went wrong running the agent — the details are in Latch.";

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

/** A tenant plus its bound Slack API client. */
interface Bound<P> {
  tenant: SlackTenant<P>;
  api: SlackClient;
}

/** thread_ts for posting into a chat — the `_dm` chat posts un-threaded. */
const threadTsOf = (root: string): string | undefined => (root === DM_ROOT ? undefined : root);

export function slackChannel<P>(config: SlackChannelConfig<P>) {
  const staticTenant: SlackTenant<P> | undefined =
    config.principal !== undefined &&
    config.botToken !== undefined &&
    config.runtime &&
    config.botUserId &&
    config.teamId
      ? {
          principal: config.principal,
          botToken: config.botToken,
          runtime: config.runtime,
          botUserId: config.botUserId,
          teamId: config.teamId,
        }
      : undefined;
  if (!staticTenant && !config.resolve) {
    throw new Error(
      "slackChannel: supply either a full static tenant (principal/botToken/runtime/botUserId/teamId) or a resolve() seam",
    );
  }
  const boundOf = (tenant: SlackTenant<P>): Bound<P> => ({
    tenant,
    api: slackApi(tenant.botToken, config.apiOptions),
  });
  const staticBound = staticTenant ? boundOf(staticTenant) : undefined;

  async function resolveBound(peek: SlackPeek): Promise<Bound<P> | null> {
    if (config.resolve) {
      const tenant = await config.resolve(peek);
      return tenant ? boundOf(tenant) : null;
    }
    return staticBound ?? null;
  }

  const resolveSigningSecret = async (): Promise<string> =>
    typeof config.signingSecret === "function" ? config.signingSecret() : config.signingSecret;

  const defer = (p: Promise<unknown>) => {
    const guarded = p.catch((e) => console.error("[slack] deferred worker failed:", e));
    if (config.waitUntil) config.waitUntil(guarded);
    return guarded;
  };

  const identity = { username: config.botName, icon_emoji: config.iconEmoji };

  /** Session-surface status; a no-op outside the bot's DM channel. */
  async function setSession(
    api: SlackClient,
    channel: string,
    root: string,
    status: "active" | "processing" | "suspended" | "closed",
  ): Promise<void> {
    if (!channel.startsWith("D")) return;
    const threadTs = threadTsOf(root);
    await api
      .sessionsSetStatus({
        channel_id: channel,
        status,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
      .catch(() => {
        /* plain DMs aren't sessions; status is best-effort */
      });
  }

  // ── Turn rendering (shared by messages, resumes, replays) ─────────────────

  async function renderTurn(
    b: Bound<P>,
    res: Response,
    ctx: {
      chatId: string;
      channel: string;
      root: string;
      /** Slack user the turn belongs to — approval cards bind to them. */
      userId: string;
      principal: P;
      turnStartedAt: number;
    },
  ): Promise<void> {
    const threadTs = threadTsOf(ctx.root);
    const result = await renderSlackStream(consumeRun(res), {
      api: b.api,
      channel: ctx.channel,
      ...(threadTs ? { threadTs } : {}),
      recipientTeamId: b.tenant.teamId,
      recipientUserId: ctx.userId,
      shouldStop: () => config.threads.stoppedSince(ctx.chatId, ctx.turnStartedAt),
      feedback: config.feedback ?? false,
      identity,
      ...(config.onStreamMode
        ? {
            onStreamMode: (info: { mode: "stream" | "fallback"; code?: string; detail?: string }) =>
              void config.onStreamMode?.({ chatId: ctx.chatId, ...info }).catch(() => {}),
          }
        : {}),
      // The legacy free-text status box ("is thinking…"). Assistant/DM
      // surfaces only, and it needs a thread — best-effort by construction
      // (the api call swallows its own errors).
      ...(threadTs
        ? {
            setStatus: (text: string) =>
              b.api.setStatus({ channel_id: ctx.channel, thread_ts: threadTs, status: text }),
          }
        : {}),
    });
    if (result.stopped) {
      await setSession(b.api, ctx.channel, ctx.root, "active");
      return;
    }
    if (result.errorMessage) {
      // The stream's own error surface already rendered; don't hunt approvals
      // on a failed turn.
      await setSession(b.api, ctx.channel, ctx.root, "active");
      return;
    }

    // Approvals are message state, not stream chunks — check fresh history.
    let hasPending = false;
    try {
      const history = await b.tenant.runtime.loadHistory({
        chatId: ctx.chatId,
        principal: ctx.principal,
      });
      const secret = await resolveSigningSecret();
      for (const pa of pendingApprovals(history)) {
        hasPending = true;
        if (pa.isConnect && pa.connectionName && config.authorizeUrl) {
          const url = config.authorizeUrl(pa.connectionName, {
            chatId: ctx.chatId,
            channelId: ctx.channel,
            threadTs: ctx.root,
            userId: ctx.userId,
            approvalId: pa.approvalId,
          });
          await b.api.postEphemeral({
            channel: ctx.channel,
            user: ctx.userId,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            blocks: connectBlocks(pa.connectionName, url),
            text: `Connect ${pa.connectionName} to continue.`,
          });
        } else {
          const value = encodeAction(
            {
              kind: "approval",
              chatId: ctx.chatId,
              approvalId: pa.approvalId,
              tool: pa.toolName,
              actor: ctx.userId,
            },
            secret,
          );
          await b.api.postMessage({
            channel: ctx.channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            blocks: approvalBlocksV2(value, pa.toolName, pa.input),
            text: `Approve ${pa.toolName}?`,
            ...identity,
          });
        }
      }
    } catch (e) {
      console.error("[slack] approval rendering failed:", e);
    }
    await setSession(b.api, ctx.channel, ctx.root, hasPending ? "suspended" : "active");
  }

  /** Run one gated message inside the chat's turn lease. */
  async function runLeasedMessage(
    b: Bound<P>,
    ctx: {
      chatId: string;
      channel: string;
      root: string;
      userId: string;
      prompt: string;
      context?: string;
      principal: P;
    },
  ): Promise<void> {
    const turnStartedAt = Date.now();
    await setSession(b.api, ctx.channel, ctx.root, "processing");

    const text = ctx.context
      ? `${ctx.context}\n\nThe message addressed to you:\n${ctx.prompt}`
      : ctx.prompt;
    const message: AppMessage = {
      id: newId(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: { visibility: "user", createdAt: Date.now() },
    };

    try {
      const res = await b.tenant.runtime.handleChat({
        agent: config.agent,
        chatId: ctx.chatId,
        principal: ctx.principal,
        message,
      });
      await renderTurn(b, res, { ...ctx, turnStartedAt });
    } catch (e) {
      // Never post raw internals into the channel: masked stream errors render
      // through the renderer; a pre-stream throw gets the generic line.
      console.error("[slack] turn failed:", e);
      await b.api
        .postMessage({
          channel: ctx.channel,
          thread_ts: threadTsOf(ctx.root),
          text: GENERIC_ERROR,
          ...identity,
        })
        .catch(() => {});
      await setSession(b.api, ctx.channel, ctx.root, "active");
    }
  }

  // ── Deferred workers ───────────────────────────────────────────────────────

  async function handleUserMessage(
    body: { event_id?: string; team_id?: string; event: SlackEvent },
    mode: Mode,
  ): Promise<void> {
    const ev = body.event;
    const teamId = body.team_id ?? "";
    if (!ev.channel || !ev.ts) return;

    // 1. Delivery dedupe — Slack retries reuse the event_id.
    if (body.event_id && !(await config.claimOnce(`evt:${body.event_id}`, EVT_TTL))) return;

    // 2. Tenant (post-ACK — this may hit DB/Vault).
    const b = await resolveBound({
      kind: "event",
      type: "event_callback",
      eventType: ev.type,
      teamId,
      userId: ev.user,
      payload: body,
    });
    if (!b) return;

    // 3. Shape check — humans only, allowlisted subtypes, never the bot itself.
    if (!isRenderableUserMessage(ev, b.tenant.botUserId)) return;
    const userId = ev.user!;

    // 4. Message identity claim — one message arrives as several event shapes
    //    (a channel mention fires BOTH app_mention and message.channels).
    //    Claimed before any user-visible side effect so even a refusal notice
    //    posts exactly once.
    if (!(await config.claimOnce(`msg:${teamId}:${ev.channel}:${ev.ts}`, MSG_TTL))) return;

    // 5. The chat this message belongs to. Un-threaded messages in a DM
    //    channel always land on the `_dm` chat REGARDLESS of event shape —
    //    a DM mention can arrive as app_mention too, and both shapes must
    //    resolve to the same chat.
    const root = ev.thread_ts ?? (ev.channel.startsWith("D") ? DM_ROOT : ev.ts);
    const chatId = slackChatId(config.appId, ev.channel, root);
    const threadTs = threadTsOf(root);

    const existing = await config.threads.get(chatId);
    if (mode === "thread-follow" && !existing) return; // not our thread

    // 6. Initiator ownership — one quiet notice, then silence.
    if (existing && existing.initiatorUserId !== userId) {
      if (await config.claimOnce(`note:${chatId}:${userId}`, NOTE_TTL)) {
        await b.api
          .postEphemeral({
            channel: ev.channel,
            user: userId,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            text: `This is <@${existing.initiatorUserId}>'s conversation with the agent. Mention me in a new thread (or DM me) to start your own.`,
          })
          .catch(() => {});
      }
      return;
    }

    // 7. The prompt.
    const prompt = normalizeSlackText(ev.text ?? "", b.tenant.botUserId);
    if (!prompt) return;

    // 8. Identity gate.
    let principal = b.tenant.principal;
    if (config.authorizeUser) {
      let auth: Awaited<ReturnType<NonNullable<SlackChannelConfig<P>["authorizeUser"]>>>;
      try {
        auth = await config.authorizeUser({
          teamId,
          userId,
          channelId: ev.channel,
          threadRoot: root,
          prompt,
        });
      } catch (e) {
        console.error("[slack] auth check failed:", e);
        return;
      }
      if (!auth.allowed) {
        if (auth.silent) return;
        // Only pass thread_ts for a real thread reply — threading an ephemeral
        // under a top-level mention hides it in a pane the user isn't viewing.
        const ephemeralThread = ev.thread_ts ? { thread_ts: ev.thread_ts } : {};
        try {
          if (auth.linkUrl) {
            await b.api.postEphemeral({
              channel: ev.channel,
              user: userId,
              ...ephemeralThread,
              blocks: signInCard(auth.linkUrl, auth.message),
              text: auth.message ?? "Sign in to Latch to use this agent.",
            });
          } else {
            await b.api.postEphemeral({
              channel: ev.channel,
              user: userId,
              ...ephemeralThread,
              text: auth.message ?? "You don't have access to this agent.",
            });
          }
        } catch (e) {
          console.error("[slack] ephemeral refused-notice failed, trying DM:", e);
          try {
            const dm = await b.api.openDm(userId);
            if (dm) {
              await b.api.postMessage({
                channel: dm,
                ...(auth.linkUrl ? { blocks: signInCard(auth.linkUrl, auth.message) } : {}),
                text: auth.message ?? "Sign in to Latch to use this agent.",
              });
            }
          } catch (e2) {
            console.error("[slack] DM fallback failed:", e2);
          }
        }
        return;
      }
      if (auth.principal !== undefined) principal = auth.principal;
    }

    // 9. Turn lease — ONE live run per chat.
    const token = await config.claimTurn(chatId);
    if (!token) {
      await b.api
        .postEphemeral({
          channel: ev.channel,
          user: userId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: "Still working on the previous message here — send that again when I've answered.",
        })
        .catch(() => {});
      return;
    }

    try {
      // 10. Ownership record (inside the lease → no create race).
      if (!existing) {
        const owner = await config.threads.claim(chatId, {
          initiatorUserId: userId,
          teamId,
          createdAt: Date.now(),
        });
        if (owner.initiatorUserId !== userId) return; // lost an unlikely race
      }

      // 11. First engagement of a pre-existing human thread: seed context.
      let context: string | undefined;
      if (mode === "mention" && ev.thread_ts && !existing) {
        try {
          const history = await b.tenant.runtime.loadHistory({ chatId, principal });
          if (history.length === 0) {
            const replies = await b.api.threadReplies(ev.channel, ev.thread_ts);
            const prior = replies
              .filter((m) => m.ts !== ev.ts && !m.isBot && m.text.trim())
              .slice(-30);
            if (prior.length) {
              const lines = prior
                .map(
                  (m) =>
                    `${m.userId ? `@${m.userId}` : "user"}: ${normalizeSlackText(m.text, b.tenant.botUserId)}`,
                )
                .join("\n");
              context = `Earlier messages in this Slack thread (for context):\n${lines}`;
            }
          }
        } catch (e) {
          console.error("[slack] thread context fetch failed:", e);
        }
      }

      await runLeasedMessage(b, {
        chatId,
        channel: ev.channel,
        root,
        userId,
        prompt,
        ...(context !== undefined ? { context } : {}),
        principal,
      });
    } finally {
      await config.releaseTurn(chatId, token).catch(() => {});
    }
  }

  async function handleSessionStop(body: {
    event_id?: string;
    team_id?: string;
    event: SlackEvent;
  }): Promise<void> {
    const ev = body.event;
    if (body.event_id && !(await config.claimOnce(`evt:${body.event_id}`, EVT_TTL))) return;
    if (!ev.channel) return;
    const root = ev.thread_ts ?? DM_ROOT;
    const chatId = slackChatId(config.appId, ev.channel, root);
    await config.threads.markStopped(chatId).catch((e) => {
      console.error("[slack] markStopped failed:", e);
    });

    const b = await resolveBound({
      kind: "event",
      type: "event_callback",
      eventType: ev.type,
      teamId: body.team_id,
      userId: ev.user,
      payload: body,
    });
    if (!b) return;
    // Belt and braces: close any stream Slack says was live, and clear the
    // status — it does NOT auto-clear on stop.
    for (const streamTs of ev.streaming_message_ts ?? []) {
      await b.api
        .stopStream({ channel: ev.channel, ts: streamTs, markdown_text: "\n\n_Stopped._" })
        .catch(() => {});
    }
    await setSession(b.api, ev.channel, root, "active");
  }

  async function handleHomeOpened(body: {
    event_id?: string;
    team_id?: string;
    event: SlackEvent;
  }): Promise<void> {
    const ev = body.event;
    if (ev.tab !== "messages" || !ev.channel || !config.suggestedPrompts) return;
    if (body.event_id && !(await config.claimOnce(`evt:${body.event_id}`, EVT_TTL))) return;
    const b = await resolveBound({
      kind: "event",
      type: "event_callback",
      eventType: ev.type,
      teamId: body.team_id,
      userId: ev.user,
      payload: body,
    });
    if (!b) return;
    try {
      const prompts =
        typeof config.suggestedPrompts === "function"
          ? await config.suggestedPrompts({ userId: ev.user ?? "", teamId: body.team_id ?? "" })
          : config.suggestedPrompts;
      if (prompts.length) {
        await b.api.setSuggestedPrompts({
          channel_id: ev.channel,
          prompts: prompts.slice(0, 4),
        });
      }
    } catch (e) {
      console.error("[slack] suggested prompts failed:", e);
    }
  }

  async function handleInteraction(payload: {
    trigger_id?: string;
    actions?: { action_id: string; value?: string }[];
    team?: { id?: string };
    channel?: { id: string };
    message?: { ts: string; thread_ts?: string };
    user?: { id: string; team_id?: string };
  }): Promise<void> {
    const action = payload.actions?.[0];
    const clicker = payload.user?.id ?? "";
    const channel = payload.channel?.id ?? "";
    if (!action || !clicker) return;

    // Interaction dedupe — Slack retries interactivity POSTs too.
    if (payload.trigger_id && !(await config.claimOnce(`act:${payload.trigger_id}`, ACT_TTL))) {
      return;
    }

    const b = await resolveBound({
      kind: "interaction",
      type: "block_actions",
      teamId: payload.team?.id ?? payload.user?.team_id,
      userId: clicker,
      payload,
    });
    if (!b) return;

    if (action.action_id === FEEDBACK_ACTION) {
      if (config.onFeedback) {
        const sentiment = action.value === "negative" ? "negative" : "positive";
        await config
          .onFeedback({
            userId: clicker,
            channelId: channel,
            messageTs: payload.message?.ts,
            sentiment,
          })
          .catch((e) => console.error("[slack] feedback hook failed:", e));
      }
      return;
    }
    if (action.action_id !== APPROVE_ACTION && action.action_id !== DENY_ACTION) return;

    const secret = await resolveSigningSecret();
    const decoded = action.value ? decodeAction(action.value, secret) : null;
    const ephemeral = (text: string) =>
      b.api
        .postEphemeral({
          channel,
          user: clicker,
          ...(payload.message?.thread_ts ? { thread_ts: payload.message.thread_ts } : {}),
          text,
        })
        .catch(() => {});
    if (!decoded) {
      await ephemeral("This button has expired — ask the agent again.");
      return;
    }

    // Actor-only: the tool executes with the REQUESTER's credentials, so only
    // they may authorize it.
    if (clicker !== decoded.actor) {
      await ephemeral(`Only <@${decoded.actor}> can act on this approval.`);
      return;
    }

    const parsed = parseSlackChatId(decoded.chatId);
    if (!parsed || parsed.app !== config.appId) return;
    const approved = action.action_id === APPROVE_ACTION;

    // Gate the clicker like a message author — the resume is a real turn.
    let principal = b.tenant.principal;
    if (config.authorizeUser) {
      let auth: Awaited<ReturnType<NonNullable<SlackChannelConfig<P>["authorizeUser"]>>>;
      try {
        auth = await config.authorizeUser({
          teamId: payload.team?.id ?? payload.user?.team_id ?? "",
          userId: clicker,
          channelId: parsed.channel,
          threadRoot: parsed.root,
          prompt: "",
        });
      } catch (e) {
        console.error("[slack] interaction auth check failed:", e);
        return;
      }
      if (!auth.allowed) {
        if (!auth.silent) {
          await ephemeral(auth.message ?? "Sign in to Latch to act on approvals.");
        }
        return;
      }
      if (auth.principal !== undefined) principal = auth.principal;
    }

    // An approval resume IS a turn — same lease as a message.
    const token = await config.claimTurn(decoded.chatId);
    if (!token) {
      await ephemeral("The agent is mid-turn here — try again in a moment.");
      return;
    }
    const turnStartedAt = Date.now();
    try {
      const res = await b.tenant.runtime.applyApproval({
        chatId: decoded.chatId,
        principal,
        decisions: [{ approvalId: decoded.approvalId, approved }],
      });
      if (payload.message?.ts) {
        await b.api
          .update({
            channel,
            ts: payload.message.ts,
            blocks: approvalResolvedBlocks(decoded.tool ?? "tool", approved),
            text: approved ? "Approved" : "Denied",
          })
          .catch((e) => console.error("[slack] card settle failed:", e));
      }
      await renderTurn(b, res, {
        chatId: decoded.chatId,
        channel: parsed.channel,
        root: parsed.root,
        userId: clicker,
        principal,
        turnStartedAt,
      });
    } catch (e) {
      console.error("[slack] approval resume failed:", e);
      await ephemeral(GENERIC_ERROR);
    } finally {
      await config.releaseTurn(decoded.chatId, token).catch(() => {});
    }
  }

  async function handleLifecycle(body: {
    event_id?: string;
    team_id?: string;
    event: SlackEvent;
  }): Promise<void> {
    if (body.event_id && !(await config.claimOnce(`evt:${body.event_id}`, EVT_TTL))) return;
    if (!config.onLifecycle) return;
    const type = body.event.type === "tokens_revoked" ? "tokens_revoked" : "app_uninstalled";
    await config.onLifecycle({ type, teamId: body.team_id ?? "" }).catch((e) => {
      console.error("[slack] lifecycle hook failed:", e);
    });
  }

  // ── The single webhook entrypoint ─────────────────────────────────────────
  //
  // PRE-ACK WORK IS EXACTLY THIS: read body → verify signature → minimal parse
  // → route to a deferred worker → 200. Anything unroutable is 200 too, so
  // Slack never retries what we'll never handle.

  async function handleRequest(request: Request): Promise<Response> {
    const raw = await request.text();
    const validSig = verifySlackSignature({
      signingSecret: await resolveSigningSecret(),
      rawBody: raw,
      signature: request.headers.get("x-slack-signature"),
      timestamp: request.headers.get("x-slack-request-timestamp"),
    });
    if (!validSig) return new Response("invalid signature", { status: 401 });

    const contentType = request.headers.get("content-type") ?? "";

    // Interactivity: form-encoded `payload=<json>`.
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const payloadStr = new URLSearchParams(raw).get("payload");
      if (payloadStr) {
        try {
          const payload = JSON.parse(payloadStr) as { type?: string };
          if (payload.type === "block_actions") {
            defer(handleInteraction(payload as never));
          }
        } catch (e) {
          console.error("[slack] interaction payload parse failed:", e);
        }
      }
      return ok();
    }

    // Events API (JSON).
    let body: {
      type?: string;
      challenge?: string;
      event_id?: string;
      team_id?: string;
      event?: SlackEvent;
    };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return ok();
    }

    if (body.type === "url_verification") {
      return new Response(body.challenge ?? "", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (body.type !== "event_callback" || !body.event) return ok();

    const ev = body.event;
    const withEvent = body as { event_id?: string; team_id?: string; event: SlackEvent };
    switch (ev.type) {
      case "app_mention":
        defer(handleUserMessage(withEvent, "mention"));
        break;
      case "message":
        if (ev.channel_type === "im") {
          defer(handleUserMessage(withEvent, "dm"));
        } else if (ev.thread_ts) {
          defer(handleUserMessage(withEvent, "thread-follow"));
        }
        break;
      case "app_home_opened":
        defer(handleHomeOpened(withEvent));
        break;
      case "agent_session_stopped":
        defer(handleSessionStop(withEvent));
        break;
      case "tokens_revoked":
      case "app_uninstalled":
        defer(handleLifecycle(withEvent));
        break;
      default:
        // agent_session_title_changed, app_context_changed (v2.1), everything
        // else: acknowledged and dropped.
        break;
    }
    return ok();
  }

  // ── Host-driven entries (replays, OAuth resumes) ───────────────────────────

  /**
   * Run one already-gated message (the post-link replay). Takes the chat's
   * turn lease like any other turn; a busy chat drops the replay (the user
   * just linked — their next message will land normally).
   */
  async function runMessage(ctx: {
    channel: string;
    /** Thread root ts, or `dm` for the un-threaded DM chat. */
    root: string;
    userId: string;
    prompt: string;
    context?: string;
    principal?: P;
    tenant?: SlackTenant<P>;
  }): Promise<void> {
    const b = ctx.tenant ? boundOf(ctx.tenant) : staticBound;
    if (!b) {
      throw new Error("slackChannel.runMessage: pass `tenant` when the channel uses resolve()");
    }
    const chatId = slackChatId(config.appId, ctx.channel, ctx.root);
    const principal = ctx.principal ?? b.tenant.principal;
    const token = await config.claimTurn(chatId);
    if (!token) {
      console.warn(`[slack] runMessage: chat ${chatId} busy — replay dropped`);
      return;
    }
    try {
      await config.threads.claim(chatId, {
        initiatorUserId: ctx.userId,
        teamId: b.tenant.teamId,
        createdAt: Date.now(),
      });
      await runLeasedMessage(b, {
        chatId,
        channel: ctx.channel,
        root: ctx.root,
        userId: ctx.userId,
        prompt: ctx.prompt,
        ...(ctx.context !== undefined ? { context: ctx.context } : {}),
        principal,
      });
    } finally {
      await config.releaseTurn(chatId, token).catch(() => {});
    }
  }

  /**
   * Approve a parked `connect_<name>` after its OAuth completed in the
   * browser. Connect-only, verified against fresh history — a browser
   * redirect must never be able to approve an arbitrary gated tool.
   */
  async function resumeApproval(ctx: {
    chatId: string;
    approvalId: string;
    userId: string;
    principal?: P;
    tenant?: SlackTenant<P>;
  }): Promise<void> {
    const b = ctx.tenant ? boundOf(ctx.tenant) : staticBound;
    if (!b) {
      throw new Error("slackChannel.resumeApproval: pass `tenant` when the channel uses resolve()");
    }
    const parsed = parseSlackChatId(ctx.chatId);
    if (!parsed || parsed.app !== config.appId) return;
    const principal = ctx.principal ?? b.tenant.principal;

    const history = await b.tenant.runtime.loadHistory({ chatId: ctx.chatId, principal });
    const pending = pendingApprovals(history).find((pa) => pa.approvalId === ctx.approvalId);
    if (!pending?.isConnect) return;

    const token = await config.claimTurn(ctx.chatId);
    if (!token) {
      console.warn(`[slack] resumeApproval: chat ${ctx.chatId} busy — resume dropped`);
      return;
    }
    const turnStartedAt = Date.now();
    try {
      await setSession(b.api, parsed.channel, parsed.root, "processing");
      const res = await b.tenant.runtime.applyApproval({
        chatId: ctx.chatId,
        principal,
        decisions: [{ approvalId: ctx.approvalId, approved: true }],
      });
      await renderTurn(b, res, {
        chatId: ctx.chatId,
        channel: parsed.channel,
        root: parsed.root,
        userId: ctx.userId,
        principal,
        turnStartedAt,
      });
    } finally {
      await config.releaseTurn(ctx.chatId, token).catch(() => {});
    }
  }

  return { handleRequest, runMessage, resumeApproval };
}
