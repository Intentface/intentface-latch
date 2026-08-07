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
        return { allowed: true };
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
    // Thread-following: a Latch chat exists for a thread the bot has replied in.
    isFollowedThread: async (chatId) => {
      const msgs = await runtime.loadHistory({ chatId, principal });
      return msgs.length > 0;
    },
    authorizeUrl: (name, ctx) => {
      const q = new URLSearchParams({
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        returnTo: `${baseUrl()}/chat/${ctx.chatId}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return { channel, app, principal };
}
