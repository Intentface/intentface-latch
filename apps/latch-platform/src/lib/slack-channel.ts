import { waitUntil } from "@vercel/functions";
import { slackChannel } from "@intentface/latch-channels/slack";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { slackVaultKeys } from "./slack-store";
import { buildLinkUrl } from "./slack-link";
import { baseUrl } from "./base-url";
import type { Principal } from "./session";

/**
 * Build the Slack channel for one app (resolved by `api_app_id`), wired to the
 * runtime + Vault + identity gate. Shared by the webhook route and the
 * post-link resume. Returns null if the app isn't registered.
 */
export async function getSlackChannelForApp(appId: string) {
  const { runtime, slackStore, credentials } = await getLatch();
  const app = await slackStore.resolve(appId);
  if (!app) return null;

  const principal: Principal = { orgId: app.orgId, userId: app.userId };
  const keys = slackVaultKeys(appId);

  const channel = slackChannel<Principal>({
    // Scope-pinned agent ref (agent-store.ts): the binding runs the record it
    // was created for — a linked member's same-named personal agent can never
    // shadow an org binding. Unpinned = code-registry agent.
    agent: app.agentScope ? `${app.agentScope}:${app.agent}` : app.agent,
    principal,
    botName: app.botName,
    botToken: async () => (await credentials.get(principal, keys.botToken, "org")) ?? "",
    signingSecret: async () => (await credentials.get(principal, keys.signingSecret, "org")) ?? "",
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    waitUntil: (p) => waitUntil(p),
    seen: (eventId) => slackStore.seen(eventId),
    // Only linked platform users may drive the agent. On refusal, stash the
    // message so it can be replayed once they link.
    authorizeUser: async ({ teamId, userId, channelId, threadRoot, prompt }) => {
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
        // userId (chat ownership stays stable, so the shared thread never
        // fragments per member) but carries the TYPIST as the actor —
        // credential resolution (credentialPrincipalOf) then uses THEIR OAuth
        // grants, never the binding owner's. Without this, every member read
        // and wrote through whatever the binder had connected.
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
        teamId: team,
        slackUserId: userId,
        appId,
        channel: channelId,
        threadRoot,
        prompt,
      });
      return {
        allowed: false,
        message: "You need a Latch account to use this agent.",
        linkUrl: buildLinkUrl(baseUrl(), appId, team, userId),
      };
    },
    // The bot's own user id — the reliable self-message check (see the channel
    // config). Absent on bindings installed before it was captured; those fall
    // back to bot_id/subtype until the app is reinstalled.
    botUserId: app.botUserId,
    // Circuit breaker: one live turn per thread. A run is "live" only while
    // active and recently heartbeated — a crashed run's row lingers until the
    // reaper, and must not wedge the thread shut.
    isBusy: async (chatId) => {
      const runs = await runtime.listRuns({ principal, limit: 25 });
      const cutoff = Date.now() - 2 * 60_000;
      return runs.some(
        (r) =>
          r.chatId === chatId &&
          r.status === "active" &&
          !r.endedAt &&
          Math.max(r.heartbeatAt ?? 0, r.startedAt) > cutoff,
      );
    },
    // Thread-following: a Latch chat exists for a thread the bot has replied in.
    isFollowedThread: async (chatId) => {
      const msgs = await runtime.loadHistory({ chatId, principal });
      return msgs.length > 0;
    },
    authorizeUrl: (name, ctx) => {
      // `slackApp` makes the generic authorize/callback run under the APP
      // BINDING's principal (see resolveContext in latch.ts) — the grant must
      // land under the key the Slack turn checks, not the browser session's,
      // or signing in never satisfies the card that asked for it. `returnTo`
      // goes to the connect-done route, which approves the parked
      // `connect_<name>` and resumes the turn INTO THE THREAD — the web chat
      // page can't do it: the resumed stream would render in the browser, and
      // for any org member but the binding owner the page isn't even theirs.
      const done = new URLSearchParams({
        app: appId,
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        user: ctx.userId,
      });
      const q = new URLSearchParams({
        slackApp: appId,
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        returnTo: `${baseUrl()}/api/slack/connect-done?${done}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return { channel, app, principal };
}
