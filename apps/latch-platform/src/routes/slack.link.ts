import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getSlackChannelForApp } from "@/lib/slack-channel";
import { getSessionUserFromHeaders } from "@/lib/session";
import { verifyLink } from "@/lib/slack-link";
import { renderLinkConfirmPage } from "@/lib/channel-link-confirm";
import {
  channelLinkCsrfToken,
  readCsrfField,
  verifyChannelLinkCsrf,
} from "@/lib/channel-link-csrf";

/**
 * Account-link landing for Slack. The bot sends a signed link to a specific
 * Slack user; the link identifies the SLACK side, while the Latch side comes
 * from the browser session — two identities that may belong to different
 * people (a forwarded link, a shared machine). So GET only renders a
 * confirmation page showing both; the link is written on the explicit POST.
 * No session → bounce to login; bad/expired signature → error.
 */

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** Shared guards for GET and POST: token + session. */
async function prepare(request: Request) {
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team") ?? "";
  const slackUserId = url.searchParams.get("user") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  if (!teamId || !slackUserId || !verifyLink(teamId, slackUserId, exp, sig)) {
    return { ok: false, response: redirect("/agents?slack=link_error") } as const;
  }

  const session = await getSessionUserFromHeaders(request.headers);
  if (!session?.principal.userId) {
    // Log in first, then re-open the link from Slack.
    return {
      ok: false,
      response: redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`),
    } as const;
  }

  return { ok: true, url, teamId, slackUserId, exp, session } as const;
}

/** CSRF identities for this request — both sides of the link plus the expiry. */
function csrfInput(ctx: {
  teamId: string;
  slackUserId: string;
  exp: number;
  session: { principal: { userId?: string } };
}) {
  return {
    channel: "slack",
    scopeId: ctx.teamId,
    externalId: ctx.slackUserId,
    sessionUserId: ctx.session.principal.userId!,
    exp: ctx.exp,
  };
}

async function handleConfirmPage(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;

  const { slackStore } = await getLatch();
  const existing = await slackStore.resolveIdentity(ctx.teamId, ctx.slackUserId);
  if (existing?.userId === ctx.session.principal.userId) {
    return redirect("/agents?slack=linked");
  }

  return renderLinkConfirmPage({
    channelLabel: "Slack",
    externalIdentity: `user ${ctx.slackUserId} (workspace ${ctx.teamId})`,
    account: { name: ctx.session.name, email: ctx.session.email },
    actionUrl: ctx.url.pathname + ctx.url.search,
    switchAccountUrl: `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`,
    csrfToken: channelLinkCsrfToken(csrfInput(ctx)),
  });
}

async function handleLink(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;
  const { teamId, slackUserId, session } = ctx;

  // Proves this POST came from a confirmation page rendered for THIS pair of
  // identities — see `channel-link-csrf.ts`.
  if (!verifyChannelLinkCsrf(await readCsrfField(request), csrfInput(ctx))) {
    return redirect("/agents?slack=link_error");
  }

  const { slackStore } = await getLatch();
  await slackStore.linkIdentity({
    teamId,
    slackUserId,
    userId: session.principal.userId!,
    orgId: session.principal.orgId,
  });

  // Continue the conversation: replay the message that triggered the link.
  const pending = await slackStore.takePending(teamId, slackUserId);
  if (pending) {
    const resolved = await getSlackChannelForApp(pending.appId);
    if (resolved) {
      waitUntil(
        resolved.channel
          .runMessage({
            channel: pending.channel,
            root: pending.threadRoot,
            userId: slackUserId,
            prompt: pending.prompt,
          })
          .catch((e) => console.error("[slack] post-link replay failed:", e)),
      );
    }
  }
  return redirect("/agents?slack=linked");
}

export const Route = createFileRoute("/slack/link")({
  server: {
    handlers: {
      GET: ({ request }) => handleConfirmPage(request),
      POST: ({ request }) => handleLink(request),
    },
  },
});
