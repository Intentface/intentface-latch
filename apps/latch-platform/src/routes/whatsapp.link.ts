import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getWhatsappChannelForBot } from "@/lib/whatsapp-channel";
import { getPrincipalFromHeaders } from "@/lib/session";
import { verifyWhatsappLink } from "@/lib/whatsapp-link";

/**
 * Account-link landing for WhatsApp, mirroring `telegram.link.ts`: records
 * (bot, wa_id) → this platform user, refuses cross-user takeovers, and
 * replays the stashed pre-link message.
 */
async function handleLink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const botId = url.searchParams.get("bot") ?? "";
  const waId = url.searchParams.get("user") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  if (!botId || !waId || !verifyWhatsappLink(botId, waId, exp, sig)) {
    return redirect("/agents?whatsapp=link_error");
  }

  const principal = await getPrincipalFromHeaders(request.headers);
  if (!principal?.userId) {
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const { whatsappStore } = await getLatch();
  const bot = await whatsappStore.get(botId);
  if (!bot) return redirect("/agents?whatsapp=link_error");

  const outcome = await whatsappStore.linkIdentity({
    botId,
    waId,
    userId: principal.userId,
    orgId: bot.orgId,
  });
  if (outcome === "conflict") return redirect("/agents?whatsapp=link_conflict");

  const pending = await whatsappStore.takePending(botId, waId);
  if (pending) {
    const resolved = await getWhatsappChannelForBot(botId);
    if (resolved) {
      waitUntil(
        resolved.channel
          .runMessage({
            waId,
            text: pending.text,
            principal: { orgId: bot.orgId, userId: principal.userId },
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
      GET: ({ request }) => handleLink(request),
    },
  },
});
