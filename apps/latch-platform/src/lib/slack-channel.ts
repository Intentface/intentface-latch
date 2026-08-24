import { waitUntil } from "@vercel/functions";
import { slackChannel } from "@intentface/latch-channels/slack";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { slackVaultKeys } from "./slack-store";
import { buildLinkUrl } from "./slack-link";
import { baseUrl } from "./base-url";
import type { Principal } from "./session";

/**
 * Build the v2 Slack channel for one app (resolved by `api_app_id`), wired to
 * the runtime + Vault + identity gate + admission stores. Shared by the
 * webhook route, the post-link replay, the connect-done resume, and scheduled
 * delivery. Returns null when the app isn't registered OR has no captured
 * `bot_user_id`/`team_id` — the v2 channel requires both (one reinstall per
 * pre-capture binding; the health row in the editor says so).
 */

/** In-instance throttle so health touches don't add a write per event. */
const lastTouch = new Map<string, number>();

// Claim TTLs owned here (policy), passed through the adapter's claimOnce.
export async function getSlackChannelForApp(appId: string) {
  const { runtime, slackStore, credentials } = await getLatch();
  const app = await slackStore.resolve(appId);
  if (!app) return null;
  if (!app.botUserId || !app.teamId) {
    console.warn(`[slack] binding ${appId} lacks bot_user_id/team_id — reinstall required`);
    return null;
  }

  const principal: Principal = { orgId: app.orgId, userId: app.userId };
  const keys = slackVaultKeys(appId);
  const disabled = app.status === "disabled";

  const channel = slackChannel<Principal>({
    // Scope-pinned agent ref (agent-store.ts): the binding runs the record it
    // was created for — a linked member's same-named personal agent can never
    // shadow an org binding. Unpinned = code-registry agent.
    agent: app.agentScope ? `${app.agentScope}:${app.agent}` : app.agent,
    appId,
    principal,
    botName: app.botName,
    botToken: async () => (await credentials.get(principal, keys.botToken, "org")) ?? "",
    signingSecret: async () => (await credentials.get(principal, keys.signingSecret, "org")) ?? "",
    botUserId: app.botUserId,
    teamId: app.teamId,
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    waitUntil: (p) => {
      waitUntil(p);
      // Health signal, throttled per instance: events are arriving + verifying.
      const now = Date.now();
      if (now - (lastTouch.get(appId) ?? 0) > 60_000) {
        lastTouch.set(appId, now);
        waitUntil(slackStore.touchEvent(appId).catch(() => {}));
      }
    },

    // ── Admission (all atomic, all in the store) ──────────────────────────────
    claimOnce: (key, ttlMs) => slackStore.claimOnce(`${appId}:${key}`, ttlMs),
    claimTurn: (chatId) => slackStore.claimTurn(chatId),
    releaseTurn: (chatId, token) => slackStore.releaseTurn(chatId, token),
    threads: {
      claim: async (chatId, meta) => {
        const row = await slackStore.claimThread({
          chatId,
          appId,
          initiatorSlackUserId: meta.initiatorUserId,
        });
        return {
          initiatorUserId: row.initiatorSlackUserId,
          teamId: meta.teamId,
          createdAt: row.createdAt,
        };
      },
      get: async (chatId) => {
        const row = await slackStore.getThread(chatId);
        if (!row) return null;
        return {
          initiatorUserId: row.initiatorSlackUserId,
          teamId: app.teamId ?? "",
          createdAt: row.createdAt,
        };
      },
      markStopped: (chatId) => slackStore.markThreadStopped(chatId),
      stoppedSince: (chatId, sinceMs) => slackStore.threadStoppedSince(chatId, sinceMs),
    },

    // ── Identity gate ─────────────────────────────────────────────────────────
    // Only linked platform users may drive the agent. On refusal, stash the
    // message so it can be replayed once they link.
    authorizeUser: async ({ teamId, userId, channelId, threadRoot, anchorTs, prompt }) => {
      // A disabled binding (uninstalled/revoked) never replies — Slack may
      // still deliver queued events for a while.
      if (disabled) return { allowed: false, silent: true };
      const team = teamId || app.teamId || "";
      const identity = await slackStore.resolveIdentity(team, userId);
      if (identity) {
        // The identity table is keyed by (team, slack user) ALONE — a link
        // recorded from any org would otherwise satisfy this gate and drive
        // this app as its owner. Bind the link to this app's org.
        if (identity.orgId !== app.orgId) {
          return {
            allowed: false,
            message: "Your Latch account isn't linked to this agent's organization.",
          };
        }
        // Identity rows outlive org membership — revalidate before running, or a
        // removed member keeps channel access to org agents.
        if (!(await isOrgMember(identity.userId, app.orgId))) {
          return {
            allowed: false,
            message: "Your Latch account is no longer a member of this agent's organization.",
          };
        }
        // A personal-agent binding resolves the CREATOR's record; no other
        // member may drive it.
        if (app.agentScope === "user" && identity.userId !== app.userId) {
          return {
            allowed: false,
            message: "This app serves a personal agent — only its owner can use it.",
          };
        }
        // Per-user credentials by default: the turn keeps the BINDING's
        // userId (chat ownership stays stable) but carries the TYPIST as the
        // actor — credential resolution (credentialPrincipalOf) then uses
        // THEIR OAuth grants, never the binding owner's.
        //
        // 'shared' is the EXPLICIT opt-out, chosen at bind time ("power this
        // bot with my integrations") and shown on the binding — everyone then
        // acts through the binder's grants, knowingly.
        if (app.credentialMode === "shared") return { allowed: true };
        return {
          allowed: true,
          principal: { orgId: app.orgId, userId: app.userId, actorUserId: identity.userId },
        };
      }
      await slackStore.setPending({
        appId,
        teamId: team,
        slackUserId: userId,
        channel: channelId,
        threadRoot,
        ...(anchorTs ? { anchorTs } : {}),
        prompt,
      });
      return {
        allowed: false,
        message: "You need a Latch account to use this agent.",
        linkUrl: buildLinkUrl(baseUrl(), appId, team, userId),
      };
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    onLifecycle: async ({ type }) => {
      // The binding goes dark rather than erroring forever against a dead
      // token. clientId/clientSecret/signingSecret stay in the Vault so a
      // reinstall revives it without re-pasting; the bot token is dead anyway.
      await slackStore.setStatus(appId, "disabled", type);
      await credentials.remove(principal, keys.botToken, "org").catch(() => {});
      console.warn(`[slack] binding ${appId} disabled (${type})`);
    },

    // Streaming health: the card's health row shows WHY a bot is in
    // edited-message fallback (throttled: only writes on change is overkill —
    // one small UPDATE per turn is fine at this scale).
    onStreamMode: async ({ mode, code, detail }) => {
      const value =
        mode === "stream" ? null : `${code ?? "unknown"}${detail ? `: ${detail}` : ""}`.slice(0, 300);
      await slackStore.setStreamError(appId, value).catch(() => {});
    },

    onFeedback: async (f) => {
      // Recorded for now; a Langfuse score is the natural next step.
      console.log(
        `[slack] feedback app=${appId} user=${f.userId} channel=${f.channelId} sentiment=${f.sentiment}`,
      );
    },

    authorizeUrl: (name, ctx) => {
      // `slackApp` makes the generic authorize/callback run under the APP
      // BINDING's principal (see resolveContext in latch.ts) — the grant must
      // land under the key the Slack turn checks, not the browser session's.
      // `returnTo` goes to the connect-done route, which approves the parked
      // `connect_<name>` and resumes the turn INTO THE THREAD.
      const done = new URLSearchParams({
        app: appId,
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        user: ctx.userId,
        // The effective thread (a real ts for `_dm` chats) — connect-done
        // hands it back so the resume renders where the card is.
        ...(/^\d+\.\d+$/.test(ctx.threadTs) ? { anchor: ctx.threadTs } : {}),
      });
      const q = new URLSearchParams({
        slackApp: appId,
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        // RELATIVE path, load-bearing: the connections callback's
        // open-redirect guard (safeReturnTo) rejects absolute URLs and falls
        // back to `/` — an absolute returnTo means connect-done NEVER runs
        // and the thread silently never resumes.
        returnTo: `/api/slack/connect-done?${done}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return { channel, app, principal };
}
