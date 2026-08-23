import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";
import { slackVaultKeys } from "@/lib/slack-store";
import { verifyOauthState } from "@/lib/slack-oauth-state";
import { oauthAccess } from "@/lib/slack-admin";
import { baseUrl } from "@/lib/base-url";
import type { Principal } from "@/lib/session";

/**
 * Slack OAuth install callback. After the user approves the install, Slack
 * redirects here with `?code=…&state=…`. The state is SIGNED (see
 * slack-oauth-state.ts) — a bare app id would let anyone who can steer a
 * browser here complete an exchange for a flow Latch never started. We resolve
 * the app's owner + client creds, exchange the code for the bot token, and
 * store it in the Vault — completing the bind with zero token pasting. A
 * `manifestVersion` flag in the state marks a migrate-to-v2 reinstall and is
 * recorded only after the exchange succeeds.
 */

const back = (status: string) =>
  new Response(null, { status: 302, headers: { location: `/agents?slack=${status}` } });

async function handleOauth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = verifyOauthState(url.searchParams.get("state") ?? "");
  if (!code || !state) return back("error");
  const appId = state.appId;

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
        agentScope: app.agentScope,
        orgId: app.orgId,
        userId: app.userId,
        botName: app.botName,
        // The loop guard: without it the bot can answer its own messages.
        botUserId: res.botUserId,
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
      // A reinstall revives a binding disabled by uninstall/revocation.
      if (app.status === "disabled") await slackStore.setStatus(appId, "active");
      // A migrate-reinstall completes only here — the manifest may have been
      // updated earlier, but v2 features need the reinstall's fresh grants.
      if (state.manifestVersion) {
        await slackStore.setManifestVersion(appId, app.orgId, state.manifestVersion);
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
