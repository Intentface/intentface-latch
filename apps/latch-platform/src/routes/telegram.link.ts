import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getTelegramChannelForBot } from "@/lib/telegram-channel";
import { getSessionUserFromHeaders } from "@/lib/session";
import { verifyTelegramLink } from "@/lib/telegram-link";
import { renderLinkConfirmPage } from "@/lib/channel-link-confirm";
import {
  channelLinkCsrfToken,
  readCsrfField,
  verifyChannelLinkCsrf,
} from "@/lib/channel-link-csrf";

/**
 * Account-link landing for Telegram, mirroring `slack.link.ts`. The bot DMs a
 * signed link to a specific Telegram user; the link identifies the TELEGRAM
 * side, while the Latch side comes from the browser session — two identities
 * that may belong to different people (a forwarded link, a shared machine).
 * So GET only renders a confirmation page showing both; the link is written
 * on the explicit POST. A link already claimed by a DIFFERENT platform user
 * is refused (unlike Slack's last-wins). The message that triggered the link
 * prompt is replayed afterwards.
 */

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** Shared guards for GET and POST: token, session, bot, org membership. */
async function prepare(request: Request) {
  const url = new URL(request.url);
  const botId = url.searchParams.get("bot") ?? "";
  const telegramUserId = url.searchParams.get("user") ?? "";
  const username = url.searchParams.get("un") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  if (!botId || !telegramUserId || !verifyTelegramLink(botId, telegramUserId, exp, sig, username)) {
    return { ok: false, response: redirect("/agents?telegram=link_error") } as const;
  }

  const session = await getSessionUserFromHeaders(request.headers);
  if (!session?.principal.userId) {
    // Log in first, then re-open the link from Telegram.
    return {
      ok: false,
      response: redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`),
    } as const;
  }

  const { telegramStore } = await getLatch();
  const bot = await telegramStore.get(botId);
  if (!bot) return { ok: false, response: redirect("/agents?telegram=link_error") } as const;
  // The link grants a `{ orgId: bot.orgId, userId }` principal — never mint
  // one for a user who isn't a member of the bot's org.
  if (bot.orgId !== session.principal.orgId) {
    return { ok: false, response: redirect("/agents?telegram=link_wrong_org") } as const;
  }

  return {
    ok: true,
    url,
    botId,
    telegramUserId,
    username,
    exp,
    session,
    telegramStore,
    bot,
  } as const;
}

/** CSRF identities for this request — both sides of the link plus the expiry. */
function csrfInput(ctx: {
  botId: string;
  telegramUserId: string;
  exp: number;
  session: { principal: { userId?: string } };
}) {
  return {
    channel: "telegram",
    scopeId: ctx.botId,
    externalId: ctx.telegramUserId,
    sessionUserId: ctx.session.principal.userId!,
    exp: ctx.exp,
  };
}

async function handleConfirmPage(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;

  // Re-opening the DM link when this exact pair is already linked: nothing to
  // confirm — just land on the app.
  const existing = await ctx.telegramStore.resolveIdentity(ctx.botId, ctx.telegramUserId);
  if (existing?.userId === ctx.session.principal.userId) {
    return redirect("/agents?telegram=linked");
  }

  return renderLinkConfirmPage({
    channelLabel: "Telegram",
    externalIdentity: ctx.username
      ? `@${ctx.username} (id ${ctx.telegramUserId})`
      : `user id ${ctx.telegramUserId}`,
    account: { name: ctx.session.name, email: ctx.session.email },
    actionUrl: ctx.url.pathname + ctx.url.search,
    switchAccountUrl: `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`,
    csrfToken: channelLinkCsrfToken(csrfInput(ctx)),
  });
}

async function handleLink(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;
  const { botId, telegramUserId, session, telegramStore, bot } = ctx;

  // The token proves this POST came from a confirmation page rendered for THIS
  // pair of identities, i.e. from a GET that already carried this browser's
  // session cookie — which a cross-site attacker cannot arrange.
  if (!verifyChannelLinkCsrf(await readCsrfField(request), csrfInput(ctx))) {
    return redirect("/agents?telegram=link_error");
  }

  const outcome = await telegramStore.linkIdentity({
    botId,
    telegramUserId,
    userId: session.principal.userId!,
    orgId: bot.orgId,
    username: ctx.username || undefined,
  });
  if (outcome === "conflict") return redirect("/agents?telegram=link_conflict");

  // Continue the conversation: replay the message (text + any held media)
  // that triggered the link. `replayMessage` claims the turn lease — a fresh
  // webhook message racing the replay must not start a concurrent run.
  const pending = await telegramStore.takePending(botId, telegramUserId);
  if (pending) {
    const resolved = await getTelegramChannelForBot(botId);
    if (resolved) {
      waitUntil(
        resolved.channel
          .replayMessage({
            telegramUserId,
            telegramChatId: pending.telegramChatId,
            text: pending.text,
            media: pending.media,
            principal: { orgId: bot.orgId, userId: session.principal.userId! },
          })
          .catch((e) => console.error("[telegram] post-link replay failed:", e)),
      );
    }
  }
  return redirect("/agents?telegram=linked");
}

export const Route = createFileRoute("/telegram/link")({
  server: {
    handlers: {
      GET: ({ request }) => handleConfirmPage(request),
      POST: ({ request }) => handleLink(request),
    },
  },
});
