import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getWhatsappChannelForBot } from "@/lib/whatsapp-channel";
import { getSessionUserFromHeaders } from "@/lib/session";
import { verifyWhatsappLink } from "@/lib/whatsapp-link";
import { renderLinkConfirmPage } from "@/lib/channel-link-confirm";

/**
 * Account-link landing for WhatsApp, mirroring `telegram.link.ts`: records
 * (bot, wa_id) → this platform user, refuses cross-user takeovers, and
 * replays the stashed pre-link message. GET only renders a confirmation page
 * showing both identities (the wa_id from the signed link, the Latch account
 * from the browser session — they may belong to different people); the link
 * is written on the explicit POST.
 */

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** Shared guards for GET and POST: token, session, bot, org membership. */
async function prepare(request: Request) {
  const url = new URL(request.url);
  const botId = url.searchParams.get("bot") ?? "";
  const waId = url.searchParams.get("user") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  if (!botId || !waId || !verifyWhatsappLink(botId, waId, exp, sig)) {
    return { ok: false, response: redirect("/agents?whatsapp=link_error") } as const;
  }

  const session = await getSessionUserFromHeaders(request.headers);
  if (!session?.principal.userId) {
    return {
      ok: false,
      response: redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`),
    } as const;
  }

  const { whatsappStore } = await getLatch();
  const bot = await whatsappStore.get(botId);
  if (!bot) return { ok: false, response: redirect("/agents?whatsapp=link_error") } as const;
  // The link grants a `{ orgId: bot.orgId, userId }` principal — never mint
  // one for a user who isn't a member of the bot's org.
  if (bot.orgId !== session.principal.orgId) {
    return { ok: false, response: redirect("/agents?whatsapp=link_wrong_org") } as const;
  }

  return { ok: true, url, botId, waId, session, whatsappStore, bot } as const;
}

async function handleConfirmPage(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;

  const existing = await ctx.whatsappStore.resolveIdentity(ctx.botId, ctx.waId);
  if (existing?.userId === ctx.session.principal.userId) {
    return redirect("/agents?whatsapp=linked");
  }

  return renderLinkConfirmPage({
    channelLabel: "WhatsApp",
    externalIdentity: `+${ctx.waId}`,
    account: { name: ctx.session.name, email: ctx.session.email },
    actionUrl: ctx.url.pathname + ctx.url.search,
    switchAccountUrl: `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`,
  });
}

async function handleLink(request: Request): Promise<Response> {
  const ctx = await prepare(request);
  if (!ctx.ok) return ctx.response;
  const { botId, waId, session, whatsappStore, bot } = ctx;

  const outcome = await whatsappStore.linkIdentity({
    botId,
    waId,
    userId: session.principal.userId!,
    orgId: bot.orgId,
  });
  if (outcome === "conflict") return redirect("/agents?whatsapp=link_conflict");

  // Replay text + any held media under the turn lease (see telegram.link.ts).
  const pending = await whatsappStore.takePending(botId, waId);
  if (pending) {
    const resolved = await getWhatsappChannelForBot(botId);
    if (resolved) {
      waitUntil(
        resolved.channel
          .replayMessage({
            waId,
            text: pending.text,
            media: pending.media,
            principal: { orgId: bot.orgId, userId: session.principal.userId! },
          })
          .catch((e) => console.error("[whatsapp] post-link replay failed:", e)),
      );
    }
  }
  return redirect("/agents?whatsapp=linked");
}

export const Route = createFileRoute("/whatsapp/link")({
  server: {
    handlers: {
      GET: ({ request }) => handleConfirmPage(request),
      POST: ({ request }) => handleLink(request),
    },
  },
});
