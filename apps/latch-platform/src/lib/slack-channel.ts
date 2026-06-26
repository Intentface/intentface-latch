import { waitUntil } from "@vercel/functions";
import { slackChannel } from "@intentface/latch-channels/slack";
import { getLatch } from "./latch";
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
    agent: app.agent,
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
      if (await slackStore.resolveIdentity(team, userId)) return { allowed: true };
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
        linkUrl: buildLinkUrl(baseUrl(), team, userId),
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
