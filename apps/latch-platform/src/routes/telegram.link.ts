import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getTelegramChannelForBot } from "@/lib/telegram-channel";
import { getPrincipalFromHeaders } from "@/lib/session";
import { verifyTelegramLink } from "@/lib/telegram-link";

/**
 * Account-link landing for Telegram, mirroring `slack.link.ts`. The bot DMs a
 * signed link to a specific Telegram user; opening it (while logged into
 * Latch) records (bot, Telegram user) → this platform user. A link already
 * claimed by a DIFFERENT platform user is refused (unlike Slack's last-wins).
 * The message that triggered the link prompt is replayed afterwards.
 */
async function handleLink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const botId = url.searchParams.get("bot") ?? "";
  const telegramUserId = url.searchParams.get("user") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  if (!botId || !telegramUserId || !verifyTelegramLink(botId, telegramUserId, exp, sig)) {
    return redirect("/agents?telegram=link_error");
  }

  const principal = await getPrincipalFromHeaders(request.headers);
  if (!principal?.userId) {
    // Log in first, then re-open the link from Telegram.
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const { telegramStore } = await getLatch();
  const bot = await telegramStore.get(botId);
  if (!bot) return redirect("/agents?telegram=link_error");
  // The link grants a `{ orgId: bot.orgId, userId }` principal — never mint
  // one for a user who isn't a member of the bot's org.
  if (bot.orgId !== principal.orgId) return redirect("/agents?telegram=link_wrong_org");

  const outcome = await telegramStore.linkIdentity({
    botId,
    telegramUserId,
    userId: principal.userId,
    orgId: bot.orgId,
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
            principal: { orgId: bot.orgId, userId: principal.userId },
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
      GET: ({ request }) => handleLink(request),
    },
  },
});
