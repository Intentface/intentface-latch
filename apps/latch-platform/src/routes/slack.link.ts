import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";
import { getPrincipalFromHeaders } from "@/lib/session";
import { verifyLink } from "@/lib/slack-link";

/**
 * Account-link landing for Slack. The bot sends a signed link to a specific
 * Slack user; opening it (while logged into Latch) records (team, slack user) →
 * this platform user, so that Slack identity may then use the agent. No session
 * → bounce to login; bad/expired signature → error.
 */
async function handleLink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team") ?? "";
  const slackUserId = url.searchParams.get("user") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  if (!teamId || !slackUserId || !verifyLink(teamId, slackUserId, exp, sig)) {
    return redirect("/agents?slack=link_error");
  }

  const principal = await getPrincipalFromHeaders(request.headers);
  if (!principal?.userId) {
    // Log in first, then re-open the link from Slack.
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const { slackStore } = await getLatch();
  await slackStore.linkIdentity({
    teamId,
    slackUserId,
    userId: principal.userId,
    orgId: principal.orgId,
  });
  return redirect("/agents?slack=linked");
}

export const Route = createFileRoute("/slack/link")({
  server: {
    handlers: {
      GET: ({ request }) => handleLink(request),
    },
  },
});
