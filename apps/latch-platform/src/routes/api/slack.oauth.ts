import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";
import { slackVaultKeys } from "@/lib/slack-store";
import { oauthAccess } from "@/lib/slack-admin";
import { baseUrl } from "@/lib/base-url";
import type { Principal } from "@/lib/session";

/**
 * Slack OAuth install callback for the one-button (C) flow. After the user
 * approves the install, Slack redirects here with `?code=…&state=<appId>`. We
 * resolve the app's owner + client creds, exchange the code for the bot token,
 * and store it in the Vault — completing the bind with zero token pasting.
 */

const back = (status: string) =>
  new Response(null, { status: 302, headers: { location: `/agents?slack=${status}` } });

async function handleOauth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const appId = url.searchParams.get("state");
  if (!code || !appId) return back("error");

  const { slackStore, credentials } = await getLatch();
  const app = await slackStore.resolve(appId);
  if (!app) return back("error");

  const owner: Principal = { orgId: app.orgId, userId: app.userId };
  const keys = slackVaultKeys(appId);
  const clientId = await credentials.get(owner, keys.clientId, "org");
  const clientSecret = await credentials.get(owner, keys.clientSecret, "org");
  if (!clientId || !clientSecret) return back("error");

  try {
    const res = await oauthAccess({
      clientId,
      clientSecret,
      code,
      redirectUri: `${baseUrl()}/api/slack/oauth`,
    });
    await credentials.set(owner, keys.botToken, "org", res.botToken);
    if (res.teamId) {
      await slackStore.bind({
        appId,
        teamId: res.teamId,
        agent: app.agent,
        orgId: app.orgId,
        userId: app.userId,
        botName: app.botName,
      });
      // Auto-link the installer (the owner) so they can use the bot right away.
      if (res.authedUserId && app.userId) {
        await slackStore.linkIdentity({
          teamId: res.teamId,
          slackUserId: res.authedUserId,
          userId: app.userId,
          orgId: app.orgId,
        });
      }
    }
  } catch {
    return back("error");
  }
  return back("connected");
}

export const Route = createFileRoute("/api/slack/oauth")({
  server: {
    handlers: {
      GET: ({ request }) => handleOauth(request),
    },
  },
});
