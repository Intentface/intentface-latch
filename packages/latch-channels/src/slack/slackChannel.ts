import type { AppMessage } from "@intentface/latch-core";
import { consumeRun, pendingApprovals } from "../render.js";
import { slackApi, type SlackToken } from "./api.js";
import { verifySlackSignature } from "./verify.js";
import {
  approvalBlocks,
  approvalResolvedBlocks,
  connectBlocks,
  decodeApprovalAction,
  textBlocks,
} from "./blocks.js";

/**
 * The subset of the Latch runtime a channel drives. Structural so the package
 * stays decoupled from the concrete app (and could even target a remote Latch).
 */
export interface SlackRunOps<P> {
  handleChat(input: {
    agent: string;
    chatId?: string;
    principal: P;
    message: AppMessage;
  }): Promise<Response>;
  applyApproval(input: {
    chatId: string;
    principal: P;
    decisions: { approvalId: string; approved: boolean }[];
  }): Promise<Response>;
  loadHistory(input: { chatId: string; principal: P }): Promise<AppMessage[]>;
}

export interface SlackChannelConfig<P> {
  /** The agent this app serves (own-app-per-agent), and the owner to run as. */
  agent: string;
  principal: P;
  /** Vault-backed in practice: `() => vault.get(principal, "slack_bot_token")`. */
  botToken: SlackToken;
  signingSecret: string | (() => string | Promise<string>);
  runtime: SlackRunOps<P>;
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
   * channel may use the bot. The turn still runs as `principal` (the owner).
   */
  authorizeUser?: (user: {
    teamId: string;
    userId: string;
    channelId: string;
    threadRoot: string;
    prompt: string;
  }) => Promise<{ allowed: boolean; linkUrl?: string; message?: string }>;
  /**
   * For thread-following: is this thread one the bot is already active in (so a
   * plain message — no @-mention — should be handled)? Omitted → only mentions
   * and DMs trigger the bot.
   */
  isFollowedThread?: (chatId: string) => Promise<boolean>;
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

/**
 * One agent's Slack app. The host wires `handleRequest` to a single webhook
 * route (events + interactivity + slash all post here). We verify, ACK fast,
 * and run the turn in the background, translating the run's `RenderEvent`s into
 * Slack posts + approval buttons.
 */
export function slackChannel<P>(config: SlackChannelConfig<P>) {
  const api = slackApi(config.botToken);

  async function resolveSigningSecret(): Promise<string> {
    return typeof config.signingSecret === "function"
      ? config.signingSecret()
      : config.signingSecret;
  }

  const defer = (p: Promise<unknown>) =>
    config.waitUntil ? config.waitUntil(p) : p;

  const identity = { username: config.botName, icon_emoji: config.iconEmoji };

  /** chatId for a Slack thread — anchors a Latch conversation to the thread. */
  const chatIdFor = (channel: string, root: string) => `slack_${channel}_${root}`;

  // ── Drive one turn and render it ──────────────────────────────────────────
  async function runTurn(ev: SlackEvent, teamId: string): Promise<void> {
    const channel = ev.channel!;
    const root = ev.thread_ts ?? ev.ts!;
    const chatId = chatIdFor(channel, root);
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
    if (config.authorizeUser) {
      let auth: { allowed: boolean; linkUrl?: string; message?: string };
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
        await api
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
          await api.postEphemeral({ channel, user: userId, thread_ts: ev.thread_ts, text });
        } catch (e) {
          console.error("[slack] ephemeral failed, trying DM:", e);
          try {
            const dm = await api.openDm(userId);
            if (dm) await api.postMessage({ channel: dm, text });
          } catch (e2) {
            console.error("[slack] DM fallback failed:", e2);
          }
        }
        return;
      }
    }

    // First time the bot engages a thread that already had human chat: seed the
    // prior thread messages as context, so it knows what "this" refers to.
    let context: string | undefined;
    if (ev.thread_ts) {
      try {
        const existing = await config.runtime.loadHistory({
          chatId: chatIdFor(channel, root),
          principal: config.principal,
        });
        if (existing.length === 0) {
          const replies = await api.threadReplies(channel, ev.thread_ts);
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

    await runMessage({ channel, root, userId, prompt, context });
  }

  /**
   * Run one user message against the agent and render it — WITHOUT the auth
   * gate (callers gate first). Reused by the gated turn, the post-link resume,
   * and thread follow-ups.
   */
  async function runMessage(ctx: {
    channel: string;
    root: string;
    userId: string;
    prompt: string;
    /** Optional prior-thread context to prepend (seeded on first engagement). */
    context?: string;
  }): Promise<void> {
    const chatId = chatIdFor(ctx.channel, ctx.root);
    await api.setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "is thinking…" });

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
      const res = await config.runtime.handleChat({
        agent: config.agent,
        chatId,
        principal: config.principal,
        message,
      });
      await renderRun(res, { channel: ctx.channel, root: ctx.root, userId: ctx.userId, chatId });
    } catch (e) {
      console.error("[slack] runMessage failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      await api
        .postMessage({
          channel: ctx.channel,
          thread_ts: ctx.root,
          text: `:warning: ${msg.slice(0, 2900)}`,
          ...identity,
        })
        .catch(() => {});
      await api
        .setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "" })
        .catch(() => {});
    }
  }

  /** Fold a run Response into Slack posts (status + final text), then approvals. */
  async function renderRun(
    res: Response,
    ctx: { channel: string; root: string; userId: string; chatId: string },
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
            await api.setStatus({
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
      await api.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.root,
        blocks: textBlocks(text),
        text: text.slice(0, 3000),
        ...identity,
      });
    }
    // Surface failures in-thread so the user is never left with just a status.
    if (errorMsg && !text.trim()) {
      await api.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.root,
        text: `:warning: ${errorMsg.slice(0, 2900)}`,
        ...identity,
      });
    }
    await api.setStatus({ channel_id: ctx.channel, thread_ts: ctx.root, status: "" });
    if (errorMsg) return; // don't look for approvals on a failed turn

    // Approvals are message state, not stream chunks — check fresh history.
    const history = await config.runtime.loadHistory({
      chatId: ctx.chatId,
      principal: config.principal,
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
        await api.postEphemeral({
          channel: ctx.channel,
          user: ctx.userId,
          thread_ts: ctx.root,
          blocks: connectBlocks(pa.connectionName, url),
          text: `Connect ${pa.connectionName} to continue.`,
        });
      } else {
        await api.postMessage({
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
  async function runInteraction(payload: {
    actions?: { action_id: string; value?: string }[];
    channel?: { id: string };
    message?: { ts: string; thread_ts?: string };
    user?: { id: string };
  }): Promise<void> {
    const action = payload.actions?.[0];
    if (!action) return;
    const decoded = decodeApprovalAction(action.action_id, action.value);
    if (!decoded) return;

    const channel = payload.channel?.id ?? "";
    const ts = payload.message?.ts ?? "";
    const root = payload.message?.thread_ts ?? ts;

    // Resolve the approval; collapse the buttons into a settled card.
    const res = await config.runtime.applyApproval({
      chatId: decoded.ref.chatId,
      principal: config.principal,
      decisions: [{ approvalId: decoded.ref.approvalId, approved: decoded.approved }],
    });
    if (ts) {
      await api.update({
        channel,
        ts,
        blocks: approvalResolvedBlocks(decoded.ref.toolName ?? "tool", decoded.approved),
        text: decoded.approved ? "Approved" : "Denied",
      });
    }
    // Continue rendering whatever the resume produced (incl. chained approvals).
    await renderRun(res, {
      channel,
      root,
      userId: payload.user?.id ?? "",
      chatId: decoded.ref.chatId,
    });
  }

  // ── The single webhook entrypoint ─────────────────────────────────────────
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

    // Interactivity (block_actions): form-encoded `payload=<json>`.
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(raw);
      const payloadStr = params.get("payload");
      if (payloadStr) {
        const payload = JSON.parse(payloadStr) as { type?: string };
        if (payload.type === "block_actions") {
          defer(runInteraction(payload as never));
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
      const fromBot = Boolean(ev.bot_id) || ev.subtype === "bot_message";
      console.log(
        `[slack] event type=${ev.type} channel_type=${ev.channel_type} fromBot=${fromBot} mention=${isMention} dm=${isDm}`,
      );
      if ((isMention || isDm) && !fromBot && ev.channel && ev.ts) {
        defer(runTurn(ev, body.team_id ?? ""));
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
        const chatId = chatIdFor(ev.channel, ev.thread_ts);
        if (await config.isFollowedThread(chatId)) {
          console.log(`[slack] following thread ${chatId}`);
          defer(runTurn(ev, body.team_id ?? ""));
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

  // `runMessage` is exposed so the post-link resume can continue a stashed
  // conversation (the gate already passed by linking).
  return { handleRequest, runMessage };
}
