import type { AppMessage } from "@intentface/latch-core";
import type { ChannelRunOps } from "../types.js";
import { consumeRun, pendingApprovals } from "../render.js";
import { slackApi, type SlackClient, type SlackToken } from "./api.js";
import { verifySlackSignature } from "./verify.js";
import {
  approvalBlocks,
  approvalResolvedBlocks,
  connectBlocks,
  decodeApprovalAction,
  textBlocks,
} from "./blocks.js";

/** @deprecated Use `ChannelRunOps` from `../types.js` — same shape, channel-agnostic. */
export type SlackRunOps<P> = ChannelRunOps<P>;

/**
 * The per-tenant state a turn runs against: who to run as, which bot token to
 * post with, and which runtime (→ which tenant DB) to drive. Static single-
 * tenant apps set these once on the config; multi-tenant hosts return them
 * from `resolve` after the payload identifies the Slack team.
 */
export interface SlackTenant<P> {
  /** The owner to run the turn as. */
  principal: P;
  /** The workspace's bot token (vault-backed in practice). */
  botToken: SlackToken;
  runtime: SlackRunOps<P>;
}

/**
 * What `resolve` gets to identify the tenant: the routing fields lifted out of
 * the ALREADY-PARSED (and signature-verified) Slack payload, plus the payload
 * itself for anything else. The channel parses the body exactly once — hosts
 * never re-peek the envelope or re-materialize the Request.
 */
export interface SlackPeek {
  /** Where the payload came from: the Events API or an interactivity POST. */
  kind: "event" | "interaction";
  /** The envelope type Slack sent (`event_callback`, `block_actions`, …). */
  type?: string;
  /** Inner event type for Events API payloads (`app_mention`, `message`, …). */
  eventType?: string;
  /** The Slack workspace (team) the payload belongs to. */
  teamId?: string;
  /** The triggering Slack user id, when present. */
  userId?: string;
  /** The full parsed envelope (Events API body / interactivity payload). */
  payload: unknown;
}

export interface SlackChannelConfig<P> {
  /** The agent this app serves (own-app-per-agent). */
  agent: string;
  /**
   * Static tenant state (single-tenant / per-request construction). Optional
   * when `resolve` is supplied — multi-tenant hosts resolve these per payload.
   */
  principal?: P;
  /** Vault-backed in practice: `() => vault.get(principal, "slack_bot_token")`. */
  botToken?: SlackToken;
  runtime?: SlackRunOps<P>;
  /**
   * Multi-tenant seam: resolve the tenant (principal, bot token, runtime) from
   * the parsed payload — called AFTER signature verification (over the raw
   * body) and the `url_verification` challenge, so hosts never pre-parse the
   * envelope themselves. Return `null` for payloads that can't be routed
   * (unknown team, no installation): the channel ACKs 200 so Slack stops
   * retrying. When omitted, the static `principal`/`botToken`/`runtime` above
   * are used for every request (back-compatible).
   */
  resolve?: (peek: SlackPeek) => SlackTenant<P> | null | Promise<SlackTenant<P> | null>;
  signingSecret: string | (() => string | Promise<string>);
  /**
   * Host hook to keep a serverless function alive for background work after we
   * ACK Slack (Slack's 3s timeout). On Vercel: `waitUntil` from `@vercel/functions`.
   * Without it we await inline (fine for long-running / non-serverless hosts).
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * Persistent dedupe: return true if this Slack `event_id` was already handled.
   * Slack re-delivers events; an in-process Set is not enough on serverless.
   */
  seen?: (eventId: string) => Promise<boolean>;
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
  /**
   * Gate inbound users: given the triggering Slack identity, decide whether to
   * run. Return `{ allowed: false, linkUrl }` to refuse and prompt the user to
   * link their platform account (posted ephemerally). Omitted → everyone in the
   * channel may use the bot.
   *
   * Return `principal` alongside `allowed: true` to run THIS message's turn as
   * that principal instead of the tenant's — the resolver contract Telegram
   * already uses. This is how a shared channel bot acts with the TYPIST's own
   * credentials rather than the installer's: without it, everyone in the
   * channel reads (and writes) through whatever the binding owner connected —
   * which is a data-exposure problem, not just an attribution one. The
   * principal is opaque to this channel; the host decides how it encodes
   * "shared thread, per-user credentials" (e.g. keeping chat ownership stable
   * while carrying the actor for credential resolution). Omitted → the
   * tenant's `principal`, as before.
   */
  authorizeUser?: (user: {
    teamId: string;
    userId: string;
    channelId: string;
    threadRoot: string;
    prompt: string;
  }) => Promise<{ allowed: boolean; linkUrl?: string; message?: string; principal?: P }>;
  /**
   * For thread-following: is this thread one the bot is already active in (so a
   * plain message — no @-mention — should be handled)? Omitted → only mentions
   * and DMs trigger the bot.
   */
  isFollowedThread?: (chatId: string) => Promise<boolean>;
  /**
   * Is a turn already running for this chat? A circuit breaker, checked before
   * EVERY inbound message turn: whatever the trigger, a Slack thread should
   * never have several agent turns executing at once. Without it a single
   * mis-classified self-message ran 8 concurrent turns on one thread (22 runs
   * from ~3 real exchanges) — each one posting, each post arriving as another
   * event.
   *
   * Best-effort by construction, and deliberately so. It is a read-then-act
   * preflight, so two deliveries arriving in the same instant can both observe
   * an idle chat; it damps a runaway (which is a SUSTAINED loop, and each
   * generation is caught) rather than guaranteeing one-at-a-time. It also does
   * not cover approval resumes — an approval normally arrives while the turn
   * is parked, not running. A real guarantee means atomic admission in the
   * storage layer (`claimRun` refusing a second live run per chat), which
   * changes the adapter contract and would have to accommodate the concurrent
   * runs Latch creates on purpose: subagents, compaction, and approval
   * continuations. That is a deliberate design decision, not a widened preflight.
   * Omitted → no cap (previous behaviour).
   */
  isBusy?: (chatId: string) => Promise<boolean>;
  /**
   * The bot's own Slack user id. The authoritative self-check: a message the
   * bot posted must never start a turn, and `bot_id`/`subtype` are absent on
   * some post shapes — a self-message that slips through the thread-following
   * gate makes the bot answer itself, post again, and run away. Supply this
   * (captured at install as `bot_user_id`) and the loop is structurally
   * impossible. Omitted → falls back to the weaker `bot_id`/`subtype` check.
   */
  botUserId?: string;
  /**
   * Scopes this app's Slack threads to their own Latch chats — pass the Slack
   * app id. Omitting it shares one chat per thread with every other bot in the
   * channel (see the chat-id notes above): they answer each other's messages
   * and interleave one history. Optional only so existing hosts keep
   * compiling; supply it.
   */
  chatNamespace?: string;
  /**
   * Adopt a pre-`chatNamespace` thread instead of stranding it. Called with
   * both candidate ids; return the one to use.
   *
   * Threads created before scoping live at the unscoped id, and switching them
   * to a scoped one would hide their history: plain replies stop being
   * followed, and a later mention starts an empty chat. Hosts should return
   * the legacy id when a chat exists there AND belongs to THIS agent, and the
   * scoped id otherwise — which keeps each thread with the bot that actually
   * owns it while the other bots in the channel get their own fresh chats
   * (i.e. it heals the shared-thread bug rather than perpetuating it).
   * Omitted → always the scoped id.
   */
  resolveChatId?: (ids: { scoped: string; legacy: string }) => Promise<string>;
  /** Per-agent display identity (defaults applied by the bot user). */
  botName?: string;
  iconEmoji?: string;
}

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
};

const ok = () => new Response(null, { status: 200 });

/** Strip leading bot @-mentions from an app_mention's text. */
function stripMentions(text: string): string {
  return text.replace(/^(\s*<@[^>]+>\s*)+/, "").trim();
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

/** A tenant plus its bound Slack API client (built from the tenant's token). */
interface Bound<P> {
  tenant: SlackTenant<P>;
  api: SlackClient;
}

// ── The Slack chat-id format ────────────────────────────────────────────────
// `slack_<app>_<channel>_<threadRoot>`: a Latch conversation is anchored to a
// Slack thread AND to the app that owns it. Defined once here and read back by
// `parseSlackChatId` — hosts that need to go the other way (a scheduled run
// posting an anchor and threading under it) use these rather than re-deriving
// the shape.
//
// The `app` segment is not cosmetic. Several bots commonly sit in one channel,
// and every one of them receives `message.channels` for the same message.
// Without the segment they share ONE chat per thread, which means (a) each
// bot's `isFollowedThread` sees the others' replies as its own history, so a
// single un-mentioned follow-up is answered by EVERY bot in the channel, and
// (b) they read and write one interleaved history, so an agent answers out of
// another agent's conversation. Both were observed in production.
//
// Legacy ids (no app segment) still parse, so threads that predate the fix
// keep resolving; new ones are namespaced.

/** Build the chat id for a Slack thread, scoped to the owning app. */
export function slackChatId(channel: string, root: string, app?: string): string {
  return app ? `slack_${app}_${channel}_${root}` : `slack_${channel}_${root}`;
}

/**
 * The inverse of `slackChatId`, or null when `id` isn't one of ours. A thread
 * root is a Slack `ts` (`1712345678.000100`), which pins the tail — and neither
 * app nor channel ids contain `_`, which pins the head.
 */
export function parseSlackChatId(
  id: string,
): { channel: string; root: string; app?: string } | null {
  const scoped = /^slack_([^_]+)_([^_]+)_(\d+\.\d+)$/.exec(id);
  if (scoped) return { app: scoped[1]!, channel: scoped[2]!, root: scoped[3]! };
  const legacy = /^slack_(.+)_(\d+\.\d+)$/.exec(id);
  if (!legacy) return null;
  return { channel: legacy[1]!, root: legacy[2]! };
}

/**
 * One agent's Slack app. The host wires `handleRequest` to a single webhook
 * route (events + interactivity + slash all post here). We verify the
 * signature on the RAW body, parse the payload ONCE, resolve the tenant
 * (static config or the `resolve` seam), ACK fast, and run the turn in the
 * background, translating the run's `RenderEvent`s into Slack posts +
 * approval buttons.
 */
export function slackChannel<P>(config: SlackChannelConfig<P>) {
  // Static tenant (back-compat construction). With `resolve`, built per payload.
  const staticTenant: SlackTenant<P> | undefined =
    config.principal !== undefined && config.botToken !== undefined && config.runtime
      ? { principal: config.principal, botToken: config.botToken, runtime: config.runtime }
      : undefined;
  if (!staticTenant && !config.resolve) {
    throw new Error(
      "slackChannel: supply either static principal/botToken/runtime or a resolve() seam",
    );
  }
  const staticBound: Bound<P> | undefined = staticTenant
    ? { tenant: staticTenant, api: slackApi(staticTenant.botToken) }
    : undefined;

  async function resolveBound(peek: SlackPeek): Promise<Bound<P> | null> {
    if (config.resolve) {
      const tenant = await config.resolve(peek);
      if (!tenant) return null;
      return { tenant, api: slackApi(tenant.botToken) };
    }
    return staticBound ?? null;
  }

  async function resolveSigningSecret(): Promise<string> {
    return typeof config.signingSecret === "function"
      ? config.signingSecret()
      : config.signingSecret;
  }

  const defer = (p: Promise<unknown>) =>
    config.waitUntil ? config.waitUntil(p) : p;

  const identity = { username: config.botName, icon_emoji: config.iconEmoji };

  /**
   * chatId for a Slack thread — anchors a Latch conversation to the thread and
   * to this app. Async because a host may adopt a legacy (unscoped) chat; see
   * `resolveChatId`.
   */
  const chatIdFor = async (channel: string, root: string): Promise<string> => {
    const scoped = slackChatId(channel, root, config.chatNamespace);
    if (!config.chatNamespace || !config.resolveChatId) return scoped;
    const legacy = slackChatId(channel, root);
    return config
      .resolveChatId({ scoped, legacy })
      .catch(() => scoped); // a failed lookup must not drop the turn
  };

  // ── Drive one turn and render it ──────────────────────────────────────────
  async function runTurn(b: Bound<P>, ev: SlackEvent, teamId: string): Promise<void> {
    const channel = ev.channel!;
    const root = ev.thread_ts ?? ev.ts!;
    const userId = ev.user ?? "";
    const prompt = stripMentions(ev.text ?? "");
    console.log(
      `[slack] runTurn type=${ev.type} user=${userId} team=${teamId} chan=${channel} promptLen=${prompt.length}`,
    );
    if (!prompt) {
      console.log("[slack] empty prompt — nothing to do");
      return;
    }

    // Gate: only linked platform users may drive the agent.
    let turnPrincipal = b.tenant.principal;
    if (config.authorizeUser) {
      let auth: { allowed: boolean; linkUrl?: string; message?: string; principal?: P };
      try {
        auth = await config.authorizeUser({
          teamId,
          userId,
          channelId: channel,
          threadRoot: root,
          prompt,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await b.api
          .postMessage({ channel, thread_ts: root, text: `:warning: auth check failed: ${msg}` })
          .catch(() => {});
        return;
      }
      console.log(`[slack] gate allowed=${auth.allowed} user=${userId}`);
      if (!auth.allowed) {
        const link = auth.linkUrl ? ` <${auth.linkUrl}|Link your Latch account>` : "";
        const text = (auth.message ?? "Link your Latch account to use this agent.") + link;
        console.log(`[slack] refused user=${userId}; posting ephemeral link notice`);
        // Private to this user (the link is signed for them). CRUCIAL: only pass
        // thread_ts when the mention was a real thread reply — for a top-level
        // mention, threading the ephemeral hides it in a thread pane the user
        // isn't viewing (it still returns ok). No thread_ts → shows in-channel.
        // DM fallback if ephemeral can't post at all.
        try {
          await b.api.postEphemeral({ channel, user: userId, thread_ts: ev.thread_ts, text });
        } catch (e) {
          console.error("[slack] ephemeral failed, trying DM:", e);
          try {
            const dm = await b.api.openDm(userId);
            if (dm) await b.api.postMessage({ channel: dm, text });
          } catch (e2) {
            console.error("[slack] DM fallback failed:", e2);
          }
        }
        return;
      }
      if (auth.principal !== undefined) turnPrincipal = auth.principal;
    }

    // First time the bot engages a thread that already had human chat: seed the
    // prior thread messages as context, so it knows what "this" refers to.
    let context: string | undefined;
    if (ev.thread_ts) {
      try {
        const existing = await b.tenant.runtime.loadHistory({
          chatId: await chatIdFor(channel, root),
          principal: turnPrincipal,
        });
        if (existing.length === 0) {
          const replies = await b.api.threadReplies(channel, ev.thread_ts);
          const prior = replies
            .filter((m) => m.ts !== ev.ts && !m.isBot && m.text.trim())
            .slice(-30); // cap context to the most recent messages
          if (prior.length) {
            const lines = prior
              .map((m) => `${m.userId ? `<@${m.userId}>` : "user"}: ${stripMentions(m.text)}`)
              .join("\n");
            context = `Earlier messages in this Slack thread (for context):\n${lines}`;
          }
        }
      } catch (e) {
        console.error("[slack] thread context fetch failed:", e);
      }
    }

    // Circuit breaker, last thing before the turn: never stack turns on one
    // thread. Checked HERE (not at dispatch) so it covers mentions, DMs and
    // thread-following alike, and only after the gate has spent its work.
    const turnChatId = await chatIdFor(channel, root);
    if (config.isBusy && (await config.isBusy(turnChatId).catch(() => false))) {
      console.warn(`[slack] chat ${turnChatId} already has a live turn — skipping`);
      return;
    }

    await runMessageBound(b, {
      channel,
      root,
      userId,
      prompt,
      context,
      principal: turnPrincipal,
      chatId: turnChatId,
    });
  }

  /**
   * Run one user message against the agent and render it — WITHOUT the auth
   * gate (callers gate first). Reused by the gated turn, the post-link resume,
   * and thread follow-ups.
   */
  async function runMessageBound(
    b: Bound<P>,
    ctx: {
      channel: string;
      root: string;
      userId: string;
      prompt: string;
      /** Optional prior-thread context to prepend (seeded on first engagement). */
      context?: string;
      /** Per-message principal (the authorizeUser resolver's); tenant's when absent. */
      principal?: P;
      /** Pre-resolved chat id (runTurn resolves once, incl. legacy adoption). */
      chatId?: string;
    },
  ): Promise<void> {
    const principal = ctx.principal ?? b.tenant.principal;
    const chatId = ctx.chatId ?? (await chatIdFor(ctx.channel, ctx.root));
    await b.api.setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "is thinking…" });

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
        chatId,
        principal,
        message,
      });
      await renderRun(b, res, { channel: ctx.channel, root: ctx.root, userId: ctx.userId, chatId, principal });
    } catch (e) {
      console.error("[slack] runMessage failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      await b.api
        .postMessage({
          channel: ctx.channel,
          thread_ts: ctx.root,
          text: `:warning: ${msg.slice(0, 2900)}`,
          ...identity,
        })
        .catch(() => {});
      await b.api
        .setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "" })
        .catch(() => {});
    }
  }

  /** Fold a run Response into Slack posts (status + final text), then approvals. */
  async function renderRun(
    b: Bound<P>,
    res: Response,
    ctx: { channel: string; root: string; userId: string; chatId: string; principal?: P },
  ): Promise<void> {
    let text = "";
    let errorMsg: string | null = null;
    try {
      for await (const ev of consumeRun(res)) {
        switch (ev.type) {
          case "text-delta":
            text += ev.text;
            break;
          case "tool-start":
            await b.api.setStatus({
              channel_id: ctx.channel,
              thread_ts: ctx.root,
              status: `is using ${ev.toolName}…`,
            });
            break;
          case "error":
            errorMsg = ev.message;
            break;
        }
      }
    } catch (e) {
      console.error("[slack] renderRun stream failed:", e);
      errorMsg = e instanceof Error ? e.message : String(e);
    }

    if (text.trim()) {
      await b.api.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.root,
        blocks: textBlocks(text),
        text: text.slice(0, 3000),
        ...identity,
      });
    }
    // Surface failures in-thread so the user is never left with just a status.
    if (errorMsg && !text.trim()) {
      await b.api.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.root,
        text: `:warning: ${errorMsg.slice(0, 2900)}`,
        ...identity,
      });
    }
    await b.api.setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "" });
    if (errorMsg) return; // don't look for approvals on a failed turn

    // Approvals are message state, not stream chunks — check fresh history.
    const history = await b.tenant.runtime.loadHistory({
      chatId: ctx.chatId,
      principal: ctx.principal ?? b.tenant.principal,
    });
    for (const pa of pendingApprovals(history)) {
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
          thread_ts: ctx.root,
          blocks: connectBlocks(pa.connectionName, url),
          text: `Connect ${pa.connectionName} to continue.`,
        });
      } else {
        await b.api.postMessage({
          channel: ctx.channel,
          thread_ts: ctx.root,
          blocks: approvalBlocks(
            { chatId: ctx.chatId, agent: config.agent, approvalId: pa.approvalId },
            pa.toolName,
            pa.input,
          ),
          text: `Approve ${pa.toolName}?`,
          ...identity,
        });
      }
    }
  }

  // ── Approve/Deny button → resume the run ──────────────────────────────────
  async function runInteraction(
    b: Bound<P>,
    payload: {
      actions?: { action_id: string; value?: string }[];
      team?: { id?: string };
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      user?: { id: string; team_id?: string };
    },
  ): Promise<void> {
    const action = payload.actions?.[0];
    if (!action) return;
    const decoded = decodeApprovalAction(action.action_id, action.value);
    if (!decoded) return;

    const channel = payload.channel?.id ?? "";
    const ts = payload.message?.ts ?? "";
    const root = payload.message?.thread_ts ?? ts;

    // The resume re-runs the agent from history — a real turn, with tool
    // access. Gate and resolve the CLICKER exactly like a message author:
    // their principal (their credentials) drives the resumed turn, and an
    // unlinked bystander can't approve gated tools by being in the channel.
    let principal = b.tenant.principal;
    if (config.authorizeUser) {
      let auth: { allowed: boolean; linkUrl?: string; message?: string; principal?: P };
      try {
        auth = await config.authorizeUser({
          teamId: payload.team?.id ?? payload.user?.team_id ?? "",
          userId: payload.user?.id ?? "",
          channelId: channel,
          threadRoot: root,
          prompt: "",
        });
      } catch (e) {
        console.error("[slack] interaction auth check failed:", e);
        return;
      }
      if (!auth.allowed) {
        const link = auth.linkUrl ? ` <${auth.linkUrl}|Link your Latch account>` : "";
        await b.api
          .postEphemeral({
            channel,
            user: payload.user?.id ?? "",
            thread_ts: payload.message?.thread_ts,
            text: (auth.message ?? "Link your Latch account to act on approvals.") + link,
          })
          .catch(() => {});
        return;
      }
      if (auth.principal !== undefined) principal = auth.principal;
    }

    // Resolve the approval; collapse the buttons into a settled card.
    const res = await b.tenant.runtime.applyApproval({
      chatId: decoded.ref.chatId,
      principal,
      decisions: [{ approvalId: decoded.ref.approvalId, approved: decoded.approved }],
    });
    if (ts) {
      await b.api.update({
        channel,
        ts,
        blocks: approvalResolvedBlocks(decoded.ref.toolName ?? "tool", decoded.approved),
        text: decoded.approved ? "Approved" : "Denied",
      });
    }
    // Continue rendering whatever the resume produced (incl. chained approvals).
    await renderRun(b, res, {
      channel,
      root,
      userId: payload.user?.id ?? "",
      chatId: decoded.ref.chatId,
      principal,
    });
  }

  // ── The single webhook entrypoint ─────────────────────────────────────────
  async function handleRequest(request: Request): Promise<Response> {
    const raw = await request.text();
    // Signature FIRST, over the exact raw bytes — nothing (parsing, tenant
    // resolution) happens on an unverified payload.
    const validSig = verifySlackSignature({
      signingSecret: await resolveSigningSecret(),
      rawBody: raw,
      signature: request.headers.get("x-slack-signature"),
      timestamp: request.headers.get("x-slack-request-timestamp"),
    });
    if (!validSig) return new Response("invalid signature", { status: 401 });

    const contentType = request.headers.get("content-type") ?? "";

    // Interactivity (block_actions): form-encoded `payload=<json>`.
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(raw);
      const payloadStr = params.get("payload");
      if (payloadStr) {
        const payload = JSON.parse(payloadStr) as {
          type?: string;
          trigger_id?: string;
          team?: { id?: string };
          user?: { id?: string; team_id?: string };
        };
        if (payload.type === "block_actions") {
          // Interactions are retried by Slack exactly like events, and the
          // resume they trigger is a full agent turn — so they need the same
          // atomic dedupe. `trigger_id` is unique per interaction delivery.
          if (payload.trigger_id && config.seen && (await config.seen(payload.trigger_id))) {
            console.log(`[slack] duplicate interaction ${payload.trigger_id} — dropped`);
            return ok();
          }
          // Resolve the tenant INSIDE the deferred work: a cold start doing DB
          // + Vault reads before the ACK can blow Slack's 3s window and earn a
          // retry — which, before the dedupe above, meant a duplicate turn.
          defer(
            (async () => {
              const b = await resolveBound({
                kind: "interaction",
                type: payload.type,
                teamId: payload.team?.id ?? payload.user?.team_id,
                userId: payload.user?.id,
                payload,
              });
              if (!b) return; // unroutable tenant — already ACKed
              await runInteraction(b, payload as never);
            })().catch((e) => console.error("[slack] interaction failed:", e)),
          );
          return ok();
        }
      }
      return ok(); // slash commands etc. — not handled yet
    }

    // Events API (JSON).
    const body = JSON.parse(raw || "{}") as {
      type?: string;
      challenge?: string;
      event_id?: string;
      team_id?: string;
      event?: SlackEvent;
    };

    // url_verification carries no team — answered before tenant resolution.
    if (body.type === "url_verification") {
      return new Response(body.challenge ?? "", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (body.type === "event_callback" && body.event) {
      // Dedupe Slack's retries before doing any work.
      if (body.event_id && config.seen && (await config.seen(body.event_id))) {
        console.log(`[slack] duplicate event ${body.event_id} — dropped`);
        return ok();
      }

      const ev = body.event;
      const isMention = ev.type === "app_mention";
      const isDm = ev.type === "message" && ev.channel_type === "im";
      // `ev.user === botUserId` is the reliable arm; bot_id/subtype are the
      // fallback for bindings installed before the id was captured.
      const selfUser = Boolean(
        config.botUserId && ev.user && ev.user === config.botUserId,
      );
      const fromBot = selfUser || Boolean(ev.bot_id) || ev.subtype === "bot_message";
      console.log(
        `[slack] event type=${ev.type} channel_type=${ev.channel_type} fromBot=${fromBot} self=${selfUser} mention=${isMention} dm=${isDm}`,
      );
      const resolveFor = () =>
        resolveBound({
          kind: "event",
          type: body.type,
          eventType: ev.type,
          teamId: body.team_id,
          userId: ev.user,
          payload: body,
        });
      if ((isMention || isDm) && !fromBot && ev.channel && ev.ts) {
        const b = await resolveFor();
        if (!b) return ok(); // unroutable tenant — ACK so Slack stops retrying
        defer(runTurn(b, ev, body.team_id ?? ""));
      } else if (
        // Thread-following: a plain message (no @-mention — those arrive as
        // app_mention and are handled above, avoiding a double-run) in a thread
        // the bot is already active in.
        ev.type === "message" &&
        ev.channel_type !== "im" &&
        !fromBot &&
        !ev.subtype &&
        ev.channel &&
        ev.thread_ts &&
        !(ev.text ?? "").includes("<@") &&
        config.isFollowedThread
      ) {
        const chatId = await chatIdFor(ev.channel, ev.thread_ts);
        if (await config.isFollowedThread(chatId)) {
          console.log(`[slack] following thread ${chatId}`);
          const b = await resolveFor();
          if (!b) return ok();
          defer(runTurn(b, ev, body.team_id ?? ""));
        } else {
          console.log(`[slack] thread ${chatId} not followed — ignoring`);
        }
      } else {
        console.log("[slack] event not dispatched (not a mention/DM/followed thread)");
      }
      return ok();
    }

    return ok();
  }

  /**
   * Run one already-gated message (post-link resume continues a stashed
   * conversation). `tenant` is required when the channel was built with
   * `resolve` (there's no static tenant to fall back to).
   */
  async function runMessage(ctx: {
    channel: string;
    root: string;
    userId: string;
    prompt: string;
    context?: string;
    /**
     * Principal the replayed turn runs as. A post-link replay is a turn on
     * behalf of the human who JUST linked — without this it would run as the
     * tenant's principal (the binding owner's credentials), which is exactly
     * what per-user credential resolution exists to prevent.
     */
    principal?: P;
    tenant?: SlackTenant<P>;
  }): Promise<void> {
    const b = ctx.tenant
      ? { tenant: ctx.tenant, api: slackApi(ctx.tenant.botToken) }
      : staticBound;
    if (!b) {
      throw new Error(
        "slackChannel.runMessage: pass `tenant` when the channel uses resolve()",
      );
    }
    return runMessageBound(b, ctx);
  }

  /**
   * Approve a parked `connect_<name>` and render the resumed run back into the
   * thread — the host calls this after the connection's OAuth completes in the
   * browser, so the Slack conversation continues where the sign-in card
   * paused it instead of dead-ending until the next @-mention.
   *
   * Restricted to CONNECT approvals by verifying against fresh history: unlike
   * the Approve/Deny buttons (whose payloads arrive Slack-signed), this is
   * reached from a browser redirect, so the approvalId alone must not be able
   * to approve an arbitrary gated tool. A non-connect or already-settled
   * approval is a silent no-op.
   */
  async function resumeApproval(ctx: {
    chatId: string;
    approvalId: string;
    /** Slack user the ephemeral follow-ups (further connect cards) target. */
    userId: string;
    /** Principal the resumed turn runs as (the connecting user's); tenant's when absent. */
    principal?: P;
    tenant?: SlackTenant<P>;
  }): Promise<void> {
    const b = ctx.tenant
      ? { tenant: ctx.tenant, api: slackApi(ctx.tenant.botToken) }
      : staticBound;
    if (!b) {
      throw new Error(
        "slackChannel.resumeApproval: pass `tenant` when the channel uses resolve()",
      );
    }
    const parsed = parseSlackChatId(ctx.chatId);
    if (!parsed) return;
    const principal = ctx.principal ?? b.tenant.principal;
    const history = await b.tenant.runtime.loadHistory({
      chatId: ctx.chatId,
      principal,
    });
    const pending = pendingApprovals(history).find((pa) => pa.approvalId === ctx.approvalId);
    if (!pending?.isConnect) return;

    await b.api.setStatus({
      channel_id: parsed.channel,
      thread_ts: parsed.root,
      status: "is thinking…",
    });
    const res = await b.tenant.runtime.applyApproval({
      chatId: ctx.chatId,
      principal,
      decisions: [{ approvalId: ctx.approvalId, approved: true }],
    });
    await renderRun(b, res, {
      channel: parsed.channel,
      root: parsed.root,
      userId: ctx.userId,
      chatId: ctx.chatId,
      principal,
    });
  }

  return { handleRequest, runMessage, resumeApproval };
}
